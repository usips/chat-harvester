/**
 * CHUCK - Rumble Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import rumbleEvents from '../fixtures/rumble-events.json';

// Mock browser globals before importing Rumble
vi.stubGlobal('window', {
    location: { href: 'https://rumble.com/v123abc-test-stream.html' },
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
const { Rumble } = await import('../../src/platforms/rumble.js');

describe('Rumble Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(Rumble.hostname).toBe('rumble.com');
        });

        it('should have a valid namespace UUID', () => {
            expect(Rumble.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('Message parsing', () => {
        let rumble;

        beforeEach(() => {
            // Create a minimal Rumble instance for testing parser functions
            rumble = Object.create(Rumble.prototype);
            rumble.platform = 'Rumble';
            rumble.channel = 123456;
            rumble.namespace = Rumble.namespace;
            rumble.emotes = {};
            rumble.log = vi.fn();
            rumble.warn = vi.fn();
            rumble._debug = vi.fn();
        });

        it('should have fixtures loaded', () => {
            expect(rumbleEvents.ChatMessage).toBeDefined();
            expect(rumbleEvents.ChatMessage.text).toBe('Hello from Rumble!');
        });

        it('should have rant (paid message) fixture', () => {
            expect(rumbleEvents.ChatMessageWithRant).toBeDefined();
            expect(rumbleEvents.ChatMessageWithRant.rant.price_cents).toBe(500);
        });

        it('should have emote fixture', () => {
            expect(rumbleEvents.ChatMessageWithEmote).toBeDefined();
            expect(rumbleEvents.ChatMessageWithEmote.blocks[0].type).toBe('emote');
        });
    });

    describe('User data parsing', () => {
        it('should have user fixture with badges', () => {
            const user = rumbleEvents.UserWithBadges;
            expect(user.badges).toContain('moderator');
            expect(user.badges).toContain('subscriber');
        });
    });

    describe('prepareSubscriptions', () => {
        let rumble;

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.platform = 'Rumble';
            rumble.channel = 123456;
            rumble.namespace = Rumble.namespace;
            rumble.log = vi.fn();
        });

        it('should parse gift_purchase_notification as gifted subscription', async () => {
            const messages = [rumbleEvents.GiftPurchaseNotification];
            const users = [rumbleEvents.GiftPurchaseUser];

            const result = await rumble.prepareSubscriptions(messages, users);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: '2403846329322621779',
                gifted: true,
                buyer: 'GenerousGifter',
                count: 5,
                value: 5
            });
        });

        it('should parse notification as regular subscription', async () => {
            const messages = [rumbleEvents.SubscriptionNotification];
            const users = [rumbleEvents.SubscriptionUser];

            const result = await rumble.prepareSubscriptions(messages, users);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: 'rumble-sub-notification-123',
                gifted: false,
                buyer: 'NewSubscriber',
                count: 1,
                value: 5
            });
        });

        it('should filter out regular chat messages', async () => {
            const messages = [rumbleEvents.ChatMessage, rumbleEvents.GiftPurchaseNotification];
            const users = [rumbleEvents.User, rumbleEvents.GiftPurchaseUser];

            const result = await rumble.prepareSubscriptions(messages, users);

            // Should only have the gift notification, not the regular chat
            expect(result).toHaveLength(1);
            expect(result[0].gifted).toBe(true);
        });

        it('should handle missing user gracefully', async () => {
            const messages = [rumbleEvents.GiftPurchaseNotification];
            const users = []; // No matching user

            const result = await rumble.prepareSubscriptions(messages, users);

            expect(result).toHaveLength(1);
            expect(result[0]).toBeUndefined();
            expect(rumble.log).toHaveBeenCalledWith('User not found:', '88707682');
        });
    });
});
