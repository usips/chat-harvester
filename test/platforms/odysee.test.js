/**
 * CHUCK - Odysee Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import odyseeEvents from '../fixtures/odysee-events.json';

// Mock browser globals before importing Odysee
vi.stubGlobal('window', {
    location: { href: 'https://odysee.com/@TestChannel:1/test-stream:2' },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class { };
        addEventListener() { }
        send() { }
    },
    fetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    EventSource: class MockEventSource { },
    XMLHttpRequest: class MockXHR {
        prototype = { open: vi.fn(), send: vi.fn() };
    },
});

vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { Odysee } = await import('../../src/platforms/odysee.js');

describe('Odysee Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(Odysee.hostname).toBe('odysee.com');
        });

        it('should have a valid namespace UUID', () => {
            expect(Odysee.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('prepareChatMessages', () => {
        let odysee;

        beforeEach(() => {
            // Create a minimal Odysee instance for testing parser functions
            odysee = Object.create(Odysee.prototype);
            odysee.platform = 'Odysee';
            odysee.channel = '@TestChannel:1';
            odysee.namespace = Odysee.namespace;
            odysee.emojis = {};
            odysee.log = vi.fn();
            odysee.warn = vi.fn();
            odysee._debug = vi.fn();
        });

        it('should parse a standard comment', async () => {
            const item = odyseeEvents.CommentListItem;
            const messages = await odysee.prepareChatMessages([item]);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toBeInstanceOf(ChatMessage);
            expect(messages[0].username).toBe('@TestChannel');
            expect(messages[0].message).toBe('Hello from Odysee!');
            expect(messages[0].amount).toBe(0);
        });

        it('should parse a superchat with fiat amount', async () => {
            const item = odyseeEvents.SuperChatItem;
            const messages = await odysee.prepareChatMessages([item]);

            expect(messages).toHaveLength(1);
            expect(messages[0].username).toBe('@BigSupporter');
            expect(messages[0].amount).toBe(10.00);
            expect(messages[0].currency).toBe('USD');
        });

        it('should mark creator comments correctly', async () => {
            const item = odyseeEvents.CreatorComment;
            const messages = await odysee.prepareChatMessages([item]);

            expect(messages).toHaveLength(1);
            expect(messages[0].is_owner).toBe(true);
        });

        it('should generate deterministic IDs', async () => {
            const item = odyseeEvents.CommentListItem;
            const messages1 = await odysee.prepareChatMessages([item]);
            const messages2 = await odysee.prepareChatMessages([item]);

            expect(messages1[0].id).toBe(messages2[0].id);
        });
    });
});
