/**
 * CHUCK - Twitch Platform Tests
 * 
 * Note: Twitch IRC parsing is incomplete (marked as TODO in source)
 * These tests cover the basic structure and fixture validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import twitchEvents from '../fixtures/twitch-events.json';

// Mock browser globals before importing Twitch
vi.stubGlobal('window', {
    location: { href: 'https://twitch.tv/streamerchannel' },
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
const { Twitch } = await import('../../src/platforms/twitch.js');

describe('Twitch Platform', () => {
    describe('Static properties', () => {
        it('should have correct hostname', () => {
            expect(Twitch.hostname).toBe('twitch.tv');
        });

        it('should have a valid namespace UUID', () => {
            expect(Twitch.namespace).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });
    });

    describe('IRC Message Parsing', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
            twitch.platform = 'Twitch';
            twitch.channel = 'streamerchannel';
            twitch.namespace = Twitch.namespace;
            twitch.log = vi.fn();
            twitch.warn = vi.fn();
            twitch._debug = vi.fn();
        });

        it('should parse IRC metadata from PRIVMSG', () => {
            const ircMessage = twitchEvents.PrivMsg;
            const parsed = twitch.parseIrcMessageToJson(ircMessage);

            expect(parsed.meta).toBeDefined();
            expect(parsed.meta['display-name']).toBe('TestUser');
            expect(parsed.meta['subscriber']).toBe('1');
            expect(parsed.meta['color']).toBe('#FF4500');
        });

        it('should parse moderator badge from IRC message', () => {
            const ircMessage = twitchEvents.ModeratorMessage;
            const parsed = twitch.parseIrcMessageToJson(ircMessage);

            expect(parsed.meta['mod']).toBe('1');
            expect(parsed.meta['badges']).toContain('moderator');
        });

        it('should parse broadcaster message', () => {
            const ircMessage = twitchEvents.BroadcasterMessage;
            const parsed = twitch.parseIrcMessageToJson(ircMessage);

            expect(parsed.meta['badges']).toContain('broadcaster');
            expect(parsed.meta['display-name']).toBe('StreamerChannel');
        });

        it('should parse emote positions from metadata', () => {
            const ircMessage = twitchEvents.PrivMsgWithEmotes;
            const parsed = twitch.parseIrcMessageToJson(ircMessage);

            expect(parsed.meta['emotes']).toBe('25:0-4');
        });
    });

    describe('IRC Fixtures Validation', () => {
        it('should have PING message', () => {
            expect(twitchEvents.Ping).toBe('PING :tmi.twitch.tv');
        });

        it('should have subscription notice', () => {
            expect(twitchEvents.UserNotice_Sub).toContain('msg-id=sub');
        });

        it('should have clear chat event', () => {
            expect(twitchEvents.ClearChat).toContain('CLEARCHAT');
        });
    });
});
