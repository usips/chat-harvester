/**
 * CHUCK - XMRChat Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import xmrchatEvents from '../fixtures/xmrchat-events.json';

// Mock browser globals before importing XMRChat
vi.stubGlobal('window', {
    location: { href: 'https://xmrchat.com/streamer' },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class { };
        addEventListener() { }
        send() { }
    },
    fetch: vi.fn(() => Promise.resolve({
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('200.00')
    })),
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
const { XMRChat } = await import('../../src/platforms/xmrchat.js');

describe('XMRChat Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(XMRChat.hostname).toBe('xmrchat.com');
        });

        it('should have a valid namespace UUID', () => {
            expect(XMRChat.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('prepareChatMessage', () => {
        let xmrchat;

        beforeEach(() => {
            xmrchat = Object.create(XMRChat.prototype);
            xmrchat.platform = 'XMRChat';
            xmrchat.channel = 'xmrchat';
            xmrchat.namespace = XMRChat.namespace;
            xmrchat.xmrPrice = 200; // Mock XMR price
            xmrchat.messagesRead = [];
            xmrchat.log = vi.fn();
            xmrchat.warn = vi.fn();
            xmrchat._debug = vi.fn();
        });

        it('should parse a tip message', () => {
            const tip = xmrchatEvents.TipMessage;
            const message = xmrchat.prepareChatMessage(tip);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.username).toBe('GenerousDonor');
            expect(message.message).toBe('Great stream! Keep up the good work!');
        });

        it('should convert XMR amount to USD', () => {
            const tip = xmrchatEvents.TipMessage;
            const message = xmrchat.prepareChatMessage(tip);

            // 100000000000 piconero = 0.1 XMR, at $200/XMR = $20
            expect(message.amount).toBeCloseTo(20, 1);
            expect(message.currency).toBe('USD');
        });

        it('should handle large tips correctly', () => {
            const tip = xmrchatEvents.LargeTip;
            const message = xmrchat.prepareChatMessage(tip);

            // 1000000000000 piconero = 1 XMR, at $200/XMR = $200
            expect(message.amount).toBeCloseTo(200, 1);
        });

        it('should generate deterministic IDs', () => {
            const tip = xmrchatEvents.TipMessage;
            const message1 = xmrchat.prepareChatMessage(tip);
            const message2 = xmrchat.prepareChatMessage(tip);

            expect(message1.id).toBe(message2.id);
        });
    });

    describe('Tip Fixtures Validation', () => {
        it('should have public tip fixture', () => {
            expect(xmrchatEvents.TipMessage.private).toBe(false);
        });

        it('should have private tip fixture', () => {
            expect(xmrchatEvents.PrivateTip.private).toBe(true);
        });

        it('should have tips page response array', () => {
            expect(Array.isArray(xmrchatEvents.TipsPageResponse)).toBe(true);
            expect(xmrchatEvents.TipsPageResponse).toHaveLength(2);
        });
    });
});
