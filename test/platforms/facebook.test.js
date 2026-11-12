/**
 * CHUCK - Facebook Platform Tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', {
    location: {
        href: 'https://www.facebook.com/test/videos/123456',
        pathname: '/test/videos/123456',
        search: '',
    },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class {};
        addEventListener() {}
        send() {}
    },
    fetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    EventSource: class MockEventSource {},
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

const { ChatMessage } = await import('../../src/core/message.js');
const { Facebook } = await import('../../src/platforms/facebook.js');

describe('Facebook Platform', () => {
    let facebook;

    beforeEach(() => {
        facebook = Object.create(Facebook.prototype);
        facebook.platform = 'Facebook';
        facebook.channel = '123456';
        facebook.namespace = Facebook.namespace;
        facebook.log = vi.fn();
        facebook.warn = vi.fn();
        facebook.sendChatMessages = vi.fn();
    });

    it('has a valid platform registration identity', () => {
        expect(Facebook.hostname).toBe('facebook.com');
        expect(Facebook.namespace).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
    });

    it('parses comment content, author metadata, and timestamps', () => {
        const message = facebook.parseComment({
            id: 'comment-123',
            preferred_body: { text: 'Hello from Facebook!' },
            body: { text: 'Fallback text' },
            author: {
                name: 'Test User',
                profile_picture_depth_0: { uri: 'https://example.com/avatar.jpg' },
                is_verified: true,
            },
            created_time: 1_700_000_000,
        });

        expect(message).toBeInstanceOf(ChatMessage);
        expect(message.message).toBe('Hello from Facebook!');
        expect(message.username).toBe('Test User');
        expect(message.avatar).toBe('https://example.com/avatar.jpg');
        expect(message.is_verified).toBe(true);
        expect(message.sent_at).toBe(1_700_000_000_000);
    });

    it('maps earned Facebook badges to normalized roles', () => {
        const message = facebook.parseComment({
            id: 'comment-badges',
            body: { text: 'Badged message' },
            discoverable_identity_badges_web: [
                { identity_badge_type: 'moderator', is_earned: true },
                { identity_badge_type: 'top_fan', is_enabled: true },
                { identity_badge_type: 'gaming_partner', is_earned: true },
                { identity_badge_type: 'moderator', is_earned: false, is_enabled: false },
            ],
        });

        expect(message.is_mod).toBe(true);
        expect(message.is_sub).toBe(true);
        expect(message.is_owner).toBe(true);
    });

    it('returns null for comments without an ID', () => {
        expect(facebook.parseComment({ body: { text: 'No ID' } })).toBeNull();
    });

    it('forwards valid GraphQL comment_create responses', () => {
        const handled = facebook.handleGraphQLResponse({
            data: {
                comment_create: {
                    comment: {
                        id: 'sent-comment',
                        body: { text: 'Sent message' },
                        author: { name: 'Sender' },
                    },
                },
            },
        });

        expect(handled).toBe(true);
        expect(facebook.sendChatMessages).toHaveBeenCalledTimes(1);
        expect(facebook.sendChatMessages.mock.calls[0][0][0].message).toBe('Sent message');
    });

    it('ignores GraphQL responses without a usable comment', () => {
        expect(facebook.handleGraphQLResponse({ data: {} })).toBe(false);
        expect(facebook.handleGraphQLResponse(null)).toBe(false);
        expect(facebook.sendChatMessages).not.toHaveBeenCalled();
    });
});
