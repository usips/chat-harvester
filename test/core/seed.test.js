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
const { Seed } = await import('../../src/core/seed.js');

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
