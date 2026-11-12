/**
 * CHUCK - Core Seed Tests
 * Tests for base Seed class command dispatcher and message handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock browser globals before importing Seed
const mockWebSocket = class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static oldWebSocket = class {
        addEventListener() {}
        send() {}
    };
    readyState = 1;
    addEventListener() {}
    send = vi.fn();
    close() {}
};

vi.stubGlobal('window', {
    location: { href: 'https://test.com/channel' },
    WebSocket: mockWebSocket,
    fetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    EventSource: class MockEventSource {
        addEventListener() {}
    },
    XMLHttpRequest: class MockXHR {
        prototype = { open: vi.fn(), send: vi.fn() };
    },
});

vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    createElement: vi.fn(() => ({
        textContent: '',
        appendChild: vi.fn(),
    })),
    head: {
        appendChild: vi.fn(),
    },
    querySelector: vi.fn(() => null),
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { Seed, CONNECT_TIMEOUT_MS, RECONNECT_DELAY_MS, MAX_QUEUED_UPDATES } = await import('../../src/core/seed.js');
const await_imports = await import('../../src/core/message.js');

describe('Seed Base Class', () => {
    describe('handleServerCommand', () => {
        let seed;

        beforeEach(() => {
            seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.channel = 'testchannel';
            seed.namespace = 'test-namespace';
            seed.debug = false;
            seed.log = vi.fn();
            seed.warn = vi.fn();
            seed._debug = vi.fn();
            seed.injectMessage = vi.fn();
        });

        it('should dispatch inject_message command to injectMessage', () => {
            const messageData = {
                username: 'TestUser',
                message: 'Hello world',
            };

            seed.handleServerCommand('inject_message', messageData);

            expect(seed.injectMessage).toHaveBeenCalledWith(messageData);
        });

        it('should log unknown commands in debug mode', () => {
            seed.handleServerCommand('unknown_command', { foo: 'bar' });

            expect(seed._debug).toHaveBeenCalledWith(
                'Unknown server command:',
                'unknown_command',
                { foo: 'bar' }
            );
        });

        it('should not crash on null data', () => {
            expect(() => {
                seed.handleServerCommand('inject_message', null);
            }).not.toThrow();

            expect(seed.injectMessage).toHaveBeenCalledWith(null);
        });

        it('should not crash on undefined data', () => {
            expect(() => {
                seed.handleServerCommand('inject_message', undefined);
            }).not.toThrow();
        });
    });

    describe('_safeHook', () => {
        let seed;

        beforeEach(() => {
            seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.error = vi.fn();
            seed.recorder = { record: vi.fn() };
        });

        it('does not propagate a throwing hook', () => {
            expect(() => {
                seed._safeHook('ws_message', () => { throw new Error('platform bug'); });
            }).not.toThrow();

            expect(seed.recorder.record).toHaveBeenCalledWith(
                'ws_message', { payload: 'platform bug' }, 'error', null, 'platform bug'
            );
        });

        it('does not propagate a rejected async hook', async () => {
            seed._safeHook('fetch_response', () => Promise.reject(new Error('async bug')));
            await Promise.resolve();
            await Promise.resolve();

            expect(seed.recorder.record).toHaveBeenCalledWith(
                'fetch_response', { payload: 'async bug' }, 'error', null, 'async bug'
            );
        });

        it('survives a missing recorder', () => {
            seed.recorder = undefined;
            expect(() => {
                seed._safeHook('ws_send', () => { throw new Error('boom'); });
            }).not.toThrow();
        });
    });

    describe('WebSocket patch isolation', () => {
        it('does not let a throwing onWebSocketMessage reach the page', () => {
            const listeners = {};
            const sockets = [];
            const OldSocket = class {
                constructor(url) {
                    this.url = url;
                    sockets.push(this);
                }
                addEventListener(type, fn) { listeners[type] = fn; }
                send() {}
            };

            const seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.error = vi.fn();
            seed._debug = vi.fn();
            seed.recorder = { record: vi.fn() };
            seed.onWebSocketMessage = () => { throw new Error('platform bug'); };
            seed.onWebSocketSend = () => { throw new Error('send bug'); };

            const original = window.WebSocket;
            window.WebSocket = OldSocket;
            try {
                const Patched = seed.webSocketPatch();
                const ws = new Patched('wss://example.com/socket');

                expect(() => listeners.message({ data: 'anything' })).not.toThrow();
                expect(() => ws.send('anything')).not.toThrow();
                expect(seed.recorder.record).toHaveBeenCalledTimes(2);
                expect(sockets).toHaveLength(1);
            } finally {
                window.WebSocket = original;
            }
        });
    });

    describe('backend queue and lifecycle', () => {
        const { LivestreamUpdate, ChatMessage } = await_imports;

        function makeSeed({ open = false, channel = 'testchannel' } = {}) {
            const seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.channel = channel;
            seed.namespace = 'test-namespace';
            seed.viewers = null;
            seed.updateQueue = [];
            seed.chatMessageQueue = [];
            seed.chatSocket = open ? { readyState: 1, send: vi.fn() } : null;
            seed.log = vi.fn();
            seed.warn = vi.fn();
            seed._debug = vi.fn();
            seed.recorder = { recordChatMessage: vi.fn() };
            return seed;
        }

        function viewersUpdate(n) {
            const update = new LivestreamUpdate('Test', 'testchannel');
            update.viewers = n;
            return update;
        }

        it('does not send 0 on unload from a tab that never reported viewers', () => {
            const seed = makeSeed();
            seed.sendViewerCount = vi.fn();
            seed.onBeforeUnload({});
            expect(seed.sendViewerCount).not.toHaveBeenCalled();
        });

        it('sends 0 on unload from a tab that was reporting viewers', () => {
            const seed = makeSeed();
            seed.viewers = 1234;
            seed.sendViewerCount = vi.fn();
            seed.onBeforeUnload({});
            expect(seed.sendViewerCount).toHaveBeenCalledWith(0);
        });

        it('keeps only the latest queued viewer count', () => {
            const seed = makeSeed();
            seed.queueLivestreamUpdate(viewersUpdate(1));
            const chat = new LivestreamUpdate('Test', 'testchannel');
            chat.messages = [];
            seed.queueLivestreamUpdate(chat);
            seed.queueLivestreamUpdate(viewersUpdate(2));
            seed.queueLivestreamUpdate(viewersUpdate(3));

            expect(seed.updateQueue).toHaveLength(2);
            expect(seed.updateQueue[0]).toBe(chat);
            expect(seed.updateQueue[1].viewers).toBe(3);
        });

        it('caps the queue while the socket is down', () => {
            const seed = makeSeed();
            for (let i = 0; i < MAX_QUEUED_UPDATES + 50; i++) {
                const update = new LivestreamUpdate('Test', 'testchannel');
                update.removals = [String(i)];
                seed.queueLivestreamUpdate(update);
            }
            expect(seed.updateQueue).toHaveLength(MAX_QUEUED_UPDATES);
            expect(seed.updateQueue[0].removals).toEqual(['50']);
            expect(seed.warn).toHaveBeenCalledTimes(1);
        });

        it('fills in null message channels when flushing', () => {
            const seed = makeSeed({ channel: null });
            const message = new ChatMessage('id-1', 'Test', null);
            const update = new LivestreamUpdate('Test', null);
            update.messages = [message];
            seed.queueLivestreamUpdate(update);

            seed.chatSocket = { readyState: 1, send: vi.fn() };
            seed.setChannel('realchannel');

            const sent = JSON.parse(seed.chatSocket.send.mock.calls[0][0]);
            expect(sent.channel).toBe('realchannel');
            expect(sent.messages[0].channel).toBe('realchannel');
        });

        it('retries a socket stuck connecting', () => {
            vi.useFakeTimers();
            const sockets = [];
            const Stuck = class {
                constructor() { this.readyState = 0; this.close = vi.fn(); sockets.push(this); }
                addEventListener() {}
            };
            const original = window.WebSocket;
            window.WebSocket = { oldWebSocket: Stuck };
            try {
                const seed = makeSeed();
                seed.serverUrl = 'ws://127.0.0.2:1350/chat.ws';
                seed.createChatSocket();
                expect(sockets).toHaveLength(1);

                vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
                expect(sockets[0].close).toHaveBeenCalled();
                expect(seed.chatSocket).toBeNull();

                vi.advanceTimersByTime(RECONNECT_DELAY_MS);
                expect(sockets).toHaveLength(2);
            } finally {
                window.WebSocket = original;
                vi.useRealTimers();
            }
        });

        it('runs document-ready setup only once', () => {
            const seed = makeSeed();
            seed.onDocumentReady = vi.fn();
            seed.createChatSocket = vi.fn();
            seed.handleDocumentReady({});
            seed.handleDocumentReady({});
            expect(seed.onDocumentReady).toHaveBeenCalledTimes(1);
            expect(seed.createChatSocket).toHaveBeenCalledTimes(1);
        });
    });

    describe('onChatSocketMessage', () => {
        let seed;

        beforeEach(() => {
            seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.channel = 'testchannel';
            seed.namespace = 'test-namespace';
            seed.debug = false;
            seed.log = vi.fn();
            seed.warn = vi.fn();
            seed._debug = vi.fn();
            seed.handleServerCommand = vi.fn();
        });

        it('should parse valid JSON and dispatch command', () => {
            const event = {
                data: JSON.stringify({ type: 'inject_message', data: { username: 'Test' } })
            };

            seed.onChatSocketMessage({}, event);

            expect(seed.handleServerCommand).toHaveBeenCalledWith('inject_message', { username: 'Test' });
        });

        it('should ignore messages without type field', () => {
            const event = {
                data: JSON.stringify({ foo: 'bar' })
            };

            seed.onChatSocketMessage({}, event);

            expect(seed.handleServerCommand).not.toHaveBeenCalled();
        });

        it('should handle invalid JSON gracefully', () => {
            const event = {
                data: 'not valid json {'
            };

            expect(() => {
                seed.onChatSocketMessage({}, event);
            }).not.toThrow();

            expect(seed.handleServerCommand).not.toHaveBeenCalled();
        });

        it('should handle empty string', () => {
            const event = { data: '' };

            expect(() => {
                seed.onChatSocketMessage({}, event);
            }).not.toThrow();
        });

        it('should handle null event data', () => {
            const event = { data: null };

            expect(() => {
                seed.onChatSocketMessage({}, event);
            }).not.toThrow();
        });
    });

    describe('Fuzzing: onChatSocketMessage robustness', () => {
        let seed;

        beforeEach(() => {
            seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.channel = 'testchannel';
            seed.namespace = 'test-namespace';
            seed.debug = false;
            seed.log = vi.fn();
            seed.warn = vi.fn();
            seed._debug = vi.fn();
            seed.handleServerCommand = vi.fn();
        });

        it('should not crash on arbitrary string data', () => {
            fc.assert(
                fc.property(fc.string(), (data) => {
                    const event = { data };

                    try {
                        seed.onChatSocketMessage({}, event);
                        return true;
                    } catch (e) {
                        console.error('Crash on input:', data);
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should not crash on arbitrary JSON objects', () => {
            fc.assert(
                fc.property(fc.jsonValue(), (value) => {
                    const event = { data: JSON.stringify(value) };

                    try {
                        seed.onChatSocketMessage({}, event);
                        return true;
                    } catch (e) {
                        console.error('Crash on input:', JSON.stringify(value));
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle commands with arbitrary type strings', () => {
            fc.assert(
                fc.property(fc.string(), fc.jsonValue(), (type, data) => {
                    const event = {
                        data: JSON.stringify({ type, data })
                    };

                    try {
                        seed.onChatSocketMessage({}, event);
                        return true;
                    } catch (e) {
                        console.error('Crash on type:', type, 'data:', data);
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle deeply nested JSON structures', () => {
            const deepObject = fc.letrec(tie => ({
                tree: fc.oneof(
                    { maxDepth: 3 },
                    fc.string(),
                    fc.integer(),
                    fc.boolean(),
                    fc.constant(null),
                    fc.array(tie('tree'), { maxLength: 5 }),
                    fc.dictionary(fc.string(), tie('tree'), { maxKeys: 5 })
                )
            }));

            fc.assert(
                fc.property(deepObject.tree, (nested) => {
                    const event = {
                        data: JSON.stringify({ type: 'test', data: nested })
                    };

                    try {
                        seed.onChatSocketMessage({}, event);
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle unicode and special characters in messages', () => {
            fc.assert(
                fc.property(fc.string(), (message) => {
                    const event = {
                        data: JSON.stringify({
                            type: 'inject_message',
                            data: { username: 'Test', message }
                        })
                    };

                    try {
                        seed.onChatSocketMessage({}, event);
                        return true;
                    } catch (e) {
                        console.error('Crash on unicode message:', message);
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle very long strings', () => {
            fc.assert(
                fc.property(
                    fc.string({ minLength: 10000, maxLength: 100000 }),
                    (longString) => {
                        const event = {
                            data: JSON.stringify({
                                type: 'inject_message',
                                data: { message: longString }
                            })
                        };

                        try {
                            seed.onChatSocketMessage({}, event);
                            return true;
                        } catch (e) {
                            return false;
                        }
                    }
                ),
                { numRuns: 20 }
            );
        });
    });

    describe('Fuzzing: handleServerCommand robustness', () => {
        let seed;

        beforeEach(() => {
            seed = Object.create(Seed.prototype);
            seed.platform = 'Test';
            seed.channel = 'testchannel';
            seed.namespace = 'test-namespace';
            seed.debug = false;
            seed.log = vi.fn();
            seed.warn = vi.fn();
            seed._debug = vi.fn();
            seed.injectMessage = vi.fn();
        });

        it('should handle inject_message with arbitrary data shapes', () => {
            const messageArbitrary = fc.record({
                id: fc.option(fc.string(), { nil: undefined }),
                username: fc.option(fc.string(), { nil: undefined }),
                message: fc.option(fc.string(), { nil: undefined }),
                avatar: fc.option(fc.string(), { nil: undefined }),
                sent_at: fc.option(fc.integer(), { nil: undefined }),
                amount: fc.option(fc.float(), { nil: undefined }),
                currency: fc.option(fc.string(), { nil: undefined }),
                is_verified: fc.option(fc.boolean(), { nil: undefined }),
                is_sub: fc.option(fc.boolean(), { nil: undefined }),
                is_mod: fc.option(fc.boolean(), { nil: undefined }),
                is_owner: fc.option(fc.boolean(), { nil: undefined }),
                emojis: fc.option(fc.array(fc.tuple(fc.string(), fc.string(), fc.string())), { nil: undefined }),
            });

            fc.assert(
                fc.property(messageArbitrary, (messageData) => {
                    try {
                        seed.handleServerCommand('inject_message', messageData);
                        return true;
                    } catch (e) {
                        console.error('Crash on message data:', JSON.stringify(messageData));
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle completely random command types', () => {
            fc.assert(
                fc.property(fc.string(), fc.anything(), (type, data) => {
                    try {
                        seed.handleServerCommand(type, data);
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });
    });
});
