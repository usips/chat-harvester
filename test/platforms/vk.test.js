/**
 * CHUCK - VK Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import vkEvents from '../fixtures/vk-events.json';

// Mock browser globals before importing VK
vi.stubGlobal('window', {
    location: { href: 'https://vk.com/video/lives?z=video-123_456' },
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
const { VK } = await import('../../src/platforms/vk.js');

describe('VK Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(VK.hostname).toBe('vk.com');
        });

        it('should have a valid namespace UUID', () => {
            expect(VK.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('prepareChatMessages', () => {
        let vk;

        beforeEach(() => {
            vk = Object.create(VK.prototype);
            vk.platform = 'VK';
            vk.channel = 'video-123_456';
            vk.namespace = VK.namespace;
            vk.log = vi.fn();
            vk.warn = vi.fn();
            vk._debug = vi.fn();
        });

        it('should parse a standard chat message', () => {
            const event = vkEvents.ChatMessage;
            const messages = vk.prepareChatMessages([event]);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toBeInstanceOf(ChatMessage);
            expect(messages[0].username).toBe('TestUser');
            expect(messages[0].message).toBe('Привет!');
        });

        it('should mark verified users correctly', () => {
            const event = vkEvents.VerifiedUserMessage;
            const messages = vk.prepareChatMessages([event]);

            expect(messages[0].is_verified).toBe(true);
            expect(messages[0].username).toBe('VKVerified');
        });

        it('should generate deterministic IDs', () => {
            const event = vkEvents.ChatMessage;
            const messages1 = vk.prepareChatMessages([event]);
            const messages2 = vk.prepareChatMessages([event]);

            expect(messages1[0].id).toBe(messages2[0].id);
        });

        it('should use default avatar when none provided', () => {
            const event = {
                ...vkEvents.ChatMessage,
                sender: { ...vkEvents.ChatMessage.sender, profile_image_url: null }
            };
            const messages = vk.prepareChatMessages([event]);

            expect(messages[0].avatar).toContain('default_profile');
        });
    });
});
