/**
 * CHUCK - YouTube Platform Tests
 * Tests for YouTube message parsing and injection
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import youtubeEvents from '../fixtures/youtube-events.json';

// Mock DOM elements
const createMockElement = (tag) => {
    const children = [];
    return {
        tagName: tag,
        className: '',
        id: '',
        innerHTML: '',
        textContent: '',
        style: {},
        children,
        childNodes: children,
        setAttribute: vi.fn(),
        getAttribute: vi.fn(),
        appendChild: vi.fn((child) => {
            children.push(child);
            return child;
        }),
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
};

const mockChatContainer = createMockElement('div');
mockChatContainer.id = 'items';

const mockScroller = createMockElement('div');
mockScroller.id = 'item-scroller';
mockScroller.scrollHeight = 1000;
mockScroller.scrollTop = 900;
mockScroller.clientHeight = 100;

// Mock browser globals before importing YouTube
vi.stubGlobal('window', {
    location: { href: 'https://www.youtube.com/watch?v=test123' },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class {
            addEventListener() {}
            send() {}
        };
        readyState = 1;
        addEventListener() {}
        send = vi.fn();
    },
    fetch: vi.fn(() => Promise.resolve({
        json: () => Promise.resolve({ author_url: 'https://www.youtube.com/@TestChannel' })
    })),
    EventSource: class MockEventSource {
        addEventListener() {}
    },
    XMLHttpRequest: class MockXHR {
        prototype = { open: vi.fn(), send: vi.fn() };
    },
    ytInitialData: {},
});

const mockHead = createMockElement('head');

vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    createElement: vi.fn((tag) => createMockElement(tag)),
    head: mockHead,
    querySelector: vi.fn((selector) => {
        if (selector === 'yt-live-chat-item-list-renderer #items') {
            return mockChatContainer;
        }
        if (selector === 'yt-live-chat-item-list-renderer #item-scroller') {
            return mockScroller;
        }
        return null;
    }),
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { YouTube } = await import('../../src/platforms/youtube.js');

describe('YouTube Platform', () => {
    describe('prepareChatMessages', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should parse a standard text message', async () => {
            const action = youtubeEvents.liveChatTextMessage.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toBeInstanceOf(ChatMessage);
            expect(messages[0].username).toBe('@TestUser');
            expect(messages[0].message).toBe('Hello world!');
        });

        it('should parse a paid message (SuperChat)', async () => {
            const action = youtubeEvents.liveChatPaidMessage.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].username).toBe('@SuperChatter');
            expect(messages[0].message).toBe('Thanks for the stream!');
            expect(messages[0].amount).toBe(5);
            expect(messages[0].currency).toBe('USD');
        });

        it('should parse messages with emojis', async () => {
            const action = youtubeEvents.liveChatWithEmoji.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].message).toContain('Hello');
            expect(messages[0].message).toContain(':UC_happy:');
            expect(messages[0].message).toContain('world!');
            expect(messages[0].emojis).toHaveLength(1);
            expect(messages[0].emojis[0][2]).toBe('UC_happy');
        });

        it('should identify moderator badge', async () => {
            const action = youtubeEvents.liveChatWithBadges.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].is_mod).toBe(true);
            expect(messages[0].is_sub).toBe(true); // Has custom thumbnail = member
        });

        it('should handle empty actions array', async () => {
            const messages = await youtube.prepareChatMessages([]);
            expect(messages).toHaveLength(0);
        });

        it('should filter out null results from unknown action types', async () => {
            const unknownAction = {
                item: { unknownRenderer: {} }
            };
            const messages = await youtube.prepareChatMessages([unknownAction]);
            expect(messages).toHaveLength(0);
        });
    });

    describe('injectMessage', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = false;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();

            // Reset mocks
            mockChatContainer.appendChild.mockClear();
            mockHead.appendChild.mockClear();
        });

        it('should inject CSS on first message', () => {
            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(mockHead.appendChild).toHaveBeenCalled();
            expect(youtube._cssInjected).toBe(true);
        });

        it('should not inject CSS twice', () => {
            youtube._cssInjected = true;

            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(mockHead.appendChild).not.toHaveBeenCalled();
        });

        it('should create message element with correct structure', () => {
            const message = {
                id: 'test-id',
                username: '@TestUser',
                message: 'Hello world!',
                avatar: 'https://example.com/avatar.jpg',
                sent_at: Date.now(),
            };

            youtube.injectMessage(message);

            expect(mockChatContainer.appendChild).toHaveBeenCalled();
            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.tagName).toBe('yt-live-chat-text-message-renderer');
            expect(element.className).toContain('chuck-external');
            expect(element.id).toBe('test-id');
        });

        it('should generate ID if not provided', () => {
            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.id).toMatch(/^chuck-\d+-[a-z0-9]+$/);
        });

        it('should use default values for missing fields', () => {
            youtube.injectMessage({});

            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.innerHTML).toContain('External'); // Default username
        });

        it('should warn if chat container not found', () => {
            const originalQuery = document.querySelector;
            document.querySelector = vi.fn(() => null);

            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(youtube.warn).toHaveBeenCalledWith(
                'Could not find chat container for message injection'
            );

            document.querySelector = originalQuery;
        });

        it('should log successful injection', () => {
            youtube.injectMessage({ username: '@TestUser', message: 'Hello!' });

            expect(youtube.log).toHaveBeenCalledWith(
                'Injected external message:',
                '@TestUser',
                'Hello!'
            );
        });
    });

    describe('Fuzzing: prepareChatMessages robustness', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should not crash on malformed action data', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        item: fc.oneof(
                            fc.record({
                                liveChatTextMessageRenderer: fc.oneof(
                                    fc.record({
                                        message: fc.option(fc.record({
                                            runs: fc.option(fc.array(fc.record({
                                                text: fc.option(fc.string(), { nil: undefined }),
                                                emoji: fc.option(fc.record({
                                                    emojiId: fc.string(),
                                                    image: fc.record({
                                                        thumbnails: fc.array(fc.record({ url: fc.string() }))
                                                    })
                                                }), { nil: undefined })
                                            })), { nil: undefined })
                                        }), { nil: undefined }),
                                        authorName: fc.option(fc.record({
                                            simpleText: fc.string()
                                        }), { nil: undefined }),
                                        authorPhoto: fc.option(fc.record({
                                            thumbnails: fc.array(fc.record({
                                                url: fc.string(),
                                                width: fc.integer(),
                                                height: fc.integer()
                                            }))
                                        }), { nil: undefined }),
                                        id: fc.option(fc.string(), { nil: undefined }),
                                        timestampUsec: fc.option(fc.string(), { nil: undefined }),
                                        authorBadges: fc.option(fc.array(fc.record({
                                            liveChatAuthorBadgeRenderer: fc.record({
                                                icon: fc.option(fc.record({ iconType: fc.string() }), { nil: undefined }),
                                                customThumbnail: fc.option(fc.anything(), { nil: undefined })
                                            })
                                        })), { nil: undefined })
                                    }),
                                    fc.constant(undefined)
                                )
                            }),
                            fc.constant(undefined)
                        )
                    }),
                    async (action) => {
                        try {
                            await youtube.prepareChatMessages([action]);
                            return true;
                        } catch (e) {
                            console.error('Crash on action:', JSON.stringify(action));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle random message content without crashing', async () => {
            await fc.assert(
                fc.asyncProperty(fc.string(), async (content) => {
                    const action = {
                        item: {
                            liveChatTextMessageRenderer: {
                                message: { runs: [{ text: content }] },
                                authorName: { simpleText: '@FuzzUser' },
                                authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                                id: 'fuzz-test',
                                timestampUsec: '1234567890000000'
                            }
                        }
                    };

                    try {
                        const messages = await youtube.prepareChatMessages([action]);
                        return messages[0].message === content;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle unicode content', async () => {
            await fc.assert(
                fc.asyncProperty(fc.string(), async (content) => {
                    const action = {
                        item: {
                            liveChatTextMessageRenderer: {
                                message: { runs: [{ text: content }] },
                                authorName: { simpleText: '@UnicodeUser' },
                                authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                                id: 'unicode-test',
                                timestampUsec: '1234567890000000'
                            }
                        }
                    };

                    try {
                        await youtube.prepareChatMessages([action]);
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle various currency formats', async () => {
            const currencies = [
                '$5.00', '€10.00', '£5.00', '¥1000', '₹500',
                'US$5.00', 'A$10.00', 'C$5.00', 'HK$50.00',
                '5,00 €', '10.00 EUR', '500 INR', 'R$25.00'
            ];

            for (const currency of currencies) {
                const action = {
                    item: {
                        liveChatPaidMessageRenderer: {
                            message: { runs: [{ text: 'Thanks!' }] },
                            authorName: { simpleText: '@Donor' },
                            authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                            purchaseAmountText: { simpleText: currency },
                            id: 'currency-test',
                            timestampUsec: '1234567890000000'
                        }
                    }
                };

                // Should not throw
                await youtube.prepareChatMessages([action]);
            }
        });
    });

    describe('Fuzzing: injectMessage robustness', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = true; // Skip CSS injection
            youtube.log = vi.fn();
            youtube.warn = vi.fn();

            mockChatContainer.appendChild.mockClear();
        });

        it('should not crash on arbitrary message shapes', () => {
            const messageArbitrary = fc.record({
                id: fc.option(fc.string(), { nil: undefined }),
                username: fc.option(fc.string(), { nil: undefined }),
                message: fc.option(fc.string(), { nil: undefined }),
                avatar: fc.option(fc.string(), { nil: undefined }),
                sent_at: fc.option(fc.integer(), { nil: undefined }),
                amount: fc.option(fc.float(), { nil: undefined }),
                currency: fc.option(fc.string(), { nil: undefined }),
            });

            fc.assert(
                fc.property(messageArbitrary, (message) => {
                    try {
                        youtube.injectMessage(message);
                        return true;
                    } catch (e) {
                        console.error('Crash on message:', JSON.stringify(message));
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle XSS-like content safely', () => {
            const xssPayloads = [
                '<script>alert("xss")</script>',
                '"><script>alert(1)</script>',
                "javascript:alert('xss')",
                '<img src=x onerror=alert(1)>',
                '<svg onload=alert(1)>',
                '{{constructor.constructor("alert(1)")()}}',
                '${alert(1)}',
                '<iframe src="javascript:alert(1)">',
            ];

            for (const payload of xssPayloads) {
                expect(() => {
                    youtube.injectMessage({
                        username: payload,
                        message: payload,
                        avatar: payload,
                    });
                }).not.toThrow();
            }
        });

        it('should handle unicode usernames and messages', () => {
            fc.assert(
                fc.property(fc.string(), fc.string(), (username, message) => {
                    try {
                        youtube.injectMessage({ username, message });
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle very long messages', () => {
            fc.assert(
                fc.property(
                    fc.string({ minLength: 5000, maxLength: 50000 }),
                    (longMessage) => {
                        try {
                            youtube.injectMessage({ message: longMessage });
                            return true;
                        } catch (e) {
                            return false;
                        }
                    }
                ),
                { numRuns: 20 }
            );
        });

        it('should handle null and undefined gracefully', () => {
            expect(() => youtube.injectMessage(null)).not.toThrow();
            expect(youtube.warn).toHaveBeenCalledWith('injectMessage called with null/undefined message');

            youtube.warn.mockClear();
            expect(() => youtube.injectMessage(undefined)).not.toThrow();
            expect(youtube.warn).toHaveBeenCalledWith('injectMessage called with null/undefined message');

            youtube.warn.mockClear();
            expect(() => youtube.injectMessage({})).not.toThrow();
        });

        it('should handle messages with all edge case timestamps', () => {
            const edgeCases = [
                0,
                -1,
                Date.now(),
                Date.now() + 86400000, // Future
                Number.MAX_SAFE_INTEGER,
                Number.MIN_SAFE_INTEGER,
                NaN,
                Infinity,
                -Infinity,
            ];

            for (const timestamp of edgeCases) {
                expect(() => {
                    youtube.injectMessage({
                        username: 'Test',
                        message: 'Hello',
                        sent_at: timestamp,
                    });
                }).not.toThrow();
            }
        });
    });

    describe('Integration: full inject_message command flow', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = true;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
            youtube._debug = vi.fn();

            mockChatContainer.appendChild.mockClear();
        });

        it('should handle full inject_message payload from server', () => {
            const payload = youtubeEvents.injectMessagePayload;

            // Simulate what handleServerCommand does
            youtube.injectMessage(payload.data);

            expect(mockChatContainer.appendChild).toHaveBeenCalled();
            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.id).toBe('external-msg-123');
            expect(element.innerHTML).toContain('@ExternalUser');
            expect(element.innerHTML).toContain('Hello from another platform!');
        });
    });
});
