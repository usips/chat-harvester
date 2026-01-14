/**
 * CHUCK - X (Twitter) Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import xEvents from '../fixtures/x-events.json';

// Mock browser globals before importing X
vi.stubGlobal('window', {
    location: { href: 'https://x.com/i/broadcasts/1234567890' },
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
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { X } = await import('../../src/platforms/x.js');

describe('X (Twitter) Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(X.hostname).toBe('x.com');
        });

        it('should have alt hostname for twitter.com', () => {
            expect(X.altHostname).toBe('twitter.com');
        });

        it('should have a valid namespace UUID', () => {
            expect(X.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('prepareChatMessages', () => {
        let x;

        beforeEach(() => {
            x = Object.create(X.prototype);
            x.platform = 'X';
            x.channel = '1234567890';
            x.namespace = X.namespace;
            x.log = vi.fn();
            x.warn = vi.fn();
            x._debug = vi.fn();
        });

        it('should parse a standard chat message', async () => {
            const sender = xEvents.ParsedSender;
            const body = xEvents.ParsedBody;

            const messages = await x.prepareChatMessages([{ sender, body }]);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toBeInstanceOf(ChatMessage);
            expect(messages[0].username).toBe('TestUser');
            expect(messages[0].message).toBe('Hello from X!');
            expect(messages[0].is_verified).toBe(false);
        });

        it('should mark verified users correctly', async () => {
            const payload = JSON.parse(xEvents.VerifiedUserMessage.payload);
            const sender = payload.sender;
            const body = JSON.parse(payload.body);

            const messages = await x.prepareChatMessages([{ sender, body }]);

            expect(messages[0].is_verified).toBe(true);
            expect(messages[0].username).toBe('VerifiedPerson');
        });

        it('should use default avatar when none provided', async () => {
            const sender = { ...xEvents.ParsedSender, profile_image_url: null };
            const body = xEvents.ParsedBody;

            const messages = await x.prepareChatMessages([{ sender, body }]);

            expect(messages[0].avatar).toContain('default_profile');
        });
    });

    describe('WebSocket Message Fixtures', () => {
        it('should have chat message with kind 1', () => {
            expect(xEvents.ChatMessage.kind).toBe(1);
        });

        it('should have wrapped message with kind 2', () => {
            expect(xEvents.WrappedMessage.kind).toBe(2);
        });

        it('should have occupancy update with kind 4', () => {
            expect(xEvents.OccupancyUpdate.kind).toBe(4);
            expect(xEvents.OccupancyUpdate.occupancy).toBe(5432);
        });
    });
});
