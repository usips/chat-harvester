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
});
