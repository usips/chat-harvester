/**
 * CHUCK - Twitch Platform Tests
 * Tests for Twitch IRC-over-WebSocket message parsing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
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
const { ChatMessage } = await import('../../src/core/message.js');
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

    describe('parseIrcTags', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
        });

        it('should parse simple key=value pairs', () => {
            const tags = twitch.parseIrcTags('color=#FF0000;display-name=TestUser;mod=0');
            expect(tags['color']).toBe('#FF0000');
            expect(tags['display-name']).toBe('TestUser');
            expect(tags['mod']).toBe('0');
        });

        it('should handle empty values', () => {
            const tags = twitch.parseIrcTags('color=;emotes=;user-type=');
            expect(tags['color']).toBe('');
            expect(tags['emotes']).toBe('');
            expect(tags['user-type']).toBe('');
        });

        it('should unescape IRC escape sequences', () => {
            const tags = twitch.parseIrcTags('system-msg=Hello\\sWorld;msg=line1\\nline2');
            expect(tags['system-msg']).toBe('Hello World');
            expect(tags['msg']).toBe('line1\nline2');
        });

        it('should handle keys without values', () => {
            const tags = twitch.parseIrcTags('some-flag');
            expect(tags['some-flag']).toBe('');
        });
    });

    describe('parseIrcMessageToJson', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
        });

        it('should parse a full PRIVMSG', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PrivMsg);

            expect(parsed.command).toBe('PRIVMSG');
            expect(parsed.params).toContain('#streamerchannel');
            expect(parsed.trailing).toBe('Hello chat!');
            expect(parsed.prefix).toBe('testuser!testuser@testuser.tmi.twitch.tv');
            expect(parsed.tags['display-name']).toBe('TestUser');
            expect(parsed.tags['subscriber']).toBe('1');
        });

        it('should parse PING message', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.Ping);

            expect(parsed.command).toBe('PING');
            expect(parsed.trailing).toBe('tmi.twitch.tv');
        });

        it('should parse JOIN message without tags', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.Join);

            expect(parsed.command).toBe('JOIN');
            expect(parsed.params).toContain('#streamerchannel');
            expect(parsed.prefix).toBe('testuser!testuser@testuser.tmi.twitch.tv');
            expect(Object.keys(parsed.tags)).toHaveLength(0);
        });

        it('should maintain backwards compatibility with meta property', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PrivMsg);

            expect(parsed.meta).toBe(parsed.tags);
            expect(parsed.meta['display-name']).toBe('TestUser');
        });
    });

    describe('extractUsername', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
        });

        it('should extract username from full prefix', () => {
            expect(twitch.extractUsername('testuser!testuser@testuser.tmi.twitch.tv')).toBe('testuser');
        });

        it('should return prefix if no bang', () => {
            expect(twitch.extractUsername('tmi.twitch.tv')).toBe('tmi.twitch.tv');
        });

        it('should return null for null input', () => {
            expect(twitch.extractUsername(null)).toBeNull();
        });
    });

    describe('hasBadge', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
        });

        it('should detect broadcaster badge', () => {
            expect(twitch.hasBadge('broadcaster/1,subscriber/99', 'broadcaster')).toBe(true);
        });

        it('should detect moderator badge', () => {
            expect(twitch.hasBadge('moderator/1,subscriber/24', 'moderator')).toBe(true);
        });

        it('should return false for missing badge', () => {
            expect(twitch.hasBadge('subscriber/12', 'moderator')).toBe(false);
        });

        it('should handle empty badges', () => {
            expect(twitch.hasBadge('', 'broadcaster')).toBe(false);
            expect(twitch.hasBadge(null, 'broadcaster')).toBe(false);
        });
    });

    describe('updateChannelFromParams', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
            twitch.channel = 'oldchannel';
            twitch.log = vi.fn();
        });

        it('should update channel from IRC params', () => {
            twitch.updateChannelFromParams(['#newchannel']);
            expect(twitch.channel).toBe('newchannel');
            expect(twitch.log).toHaveBeenCalledWith('Channel changed: oldchannel → newchannel');
        });

        it('should not update if channel is the same', () => {
            twitch.updateChannelFromParams(['#oldchannel']);
            expect(twitch.channel).toBe('oldchannel');
            expect(twitch.log).not.toHaveBeenCalled();
        });

        it('should handle empty params', () => {
            twitch.updateChannelFromParams([]);
            expect(twitch.channel).toBe('oldchannel');

            twitch.updateChannelFromParams(null);
            expect(twitch.channel).toBe('oldchannel');
        });

        it('should handle params without # prefix', () => {
            twitch.updateChannelFromParams(['nochannel']);
            expect(twitch.channel).toBe('oldchannel');
        });
    });

    describe('parseEmotes', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
        });

        it('should parse single emote', () => {
            const emotes = twitch.parseEmotes('25:0-4', 'Kappa this is great');

            expect(emotes).toHaveLength(1);
            expect(emotes[0][0]).toBe('Kappa');
            expect(emotes[0][1]).toContain('25');
            expect(emotes[0][2]).toBe('Kappa');
        });

        it('should parse multiple emotes', () => {
            const emotes = twitch.parseEmotes('25:0-4/1902:10-14', 'Kappa and Keepo are emotes');

            expect(emotes).toHaveLength(2);
        });

        it('should parse same emote multiple times', () => {
            const emotes = twitch.parseEmotes('25:0-4,10-14', 'Kappa and Kappa again');

            expect(emotes).toHaveLength(2);
            expect(emotes[0][0]).toBe('Kappa');
            expect(emotes[1][0]).toBe('Kappa');
        });

        it('should return empty array for no emotes', () => {
            expect(twitch.parseEmotes('', 'Hello world')).toHaveLength(0);
            expect(twitch.parseEmotes(null, 'Hello world')).toHaveLength(0);
        });
    });

    describe('prepareChatMessage', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
            twitch.platform = 'Twitch';
            twitch.channel = 'streamerchannel';
            twitch.namespace = Twitch.namespace;
            twitch.log = vi.fn();
            twitch.warn = vi.fn();
        });

        it('should convert PRIVMSG to ChatMessage', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PrivMsg);
            const message = twitch.prepareChatMessage(parsed);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.id).toBe('abc123-def456');
            expect(message.username).toBe('TestUser');
            expect(message.message).toBe('Hello chat!');
            expect(message.is_sub).toBe(true);
        });

        it('should identify moderator', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.ModeratorMessage);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.is_mod).toBe(true);
            expect(message.is_sub).toBe(true);
        });

        it('should identify broadcaster', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.BroadcasterMessage);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.is_owner).toBe(true);
        });

        it('should identify partner as verified', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PartnerMessage);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.is_verified).toBe(true);
        });

        it('should parse emotes', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PrivMsgWithEmotes);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.emojis).toHaveLength(1);
            expect(message.emojis[0][0]).toBe('Kappa');
        });

        it('should include user color in extra data', () => {
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.PrivMsg);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.extra.color).toBe('#FF4500');
        });

        it('should return null for message without id', () => {
            const parsed = {
                tags: { 'display-name': 'TestUser' },
                trailing: 'Hello'
            };

            const message = twitch.prepareChatMessage(parsed);

            expect(message).toBeNull();
            expect(twitch.warn).toHaveBeenCalled();
        });
    });

    describe('Real recording data tests', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
            twitch.platform = 'Twitch';
            twitch.channel = 'k3soju';
            twitch.namespace = Twitch.namespace;
            twitch.log = vi.fn();
            twitch.warn = vi.fn();
        });

        it('should parse all real recorded messages without errors', () => {
            const realMessages = twitchEvents.realRecordingMessages;

            for (const ircMessage of realMessages) {
                const parsed = twitch.parseIrcMessageToJson(ircMessage);
                const message = twitch.prepareChatMessage(parsed);

                expect(message).toBeInstanceOf(ChatMessage);
                expect(message.username).toBeTruthy();
                expect(message.id).toBeTruthy();
            }
        });

        it('should correctly parse real message with no color', () => {
            // kylords has no color set
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[0]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('kylords');
            expect(message.message).toBe('REAL MMR?');
            expect(message.extra.color).toBe('');
        });

        it('should correctly parse real message with subscriber badge', () => {
            // ChewyHiraeth is a 40-month subscriber
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[2]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('ChewyHiraeth');
            expect(message.is_sub).toBe(true);
        });

        it('should correctly parse real moderator message', () => {
            // bullettrain69 is a moderator
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[3]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('bullettrain69');
            expect(message.is_mod).toBe(true);
            expect(message.is_sub).toBe(true);
        });

        it('should correctly parse Nightbot message', () => {
            // Nightbot is a bot moderator
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[4]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('Nightbot');
            expect(message.is_mod).toBe(true);
        });

        it('should correctly parse unicode display name', () => {
            // 大場薰 has a unicode display name
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[5]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('大場薰');
            expect(message.message).toBe('imoqtpo > sojo');
        });

        it('should correctly parse message with predictions badge', () => {
            // Ranomane has a predictions badge
            const parsed = twitch.parseIrcMessageToJson(twitchEvents.realRecordingMessages[6]);
            const message = twitch.prepareChatMessage(parsed);

            expect(message.username).toBe('Ranomane');
            expect(message.is_sub).toBe(true);
        });
    });

    describe('Fuzzing: IRC parsing robustness', () => {
        let twitch;

        beforeEach(() => {
            twitch = Object.create(Twitch.prototype);
            twitch.platform = 'Twitch';
            twitch.channel = 'streamerchannel';
            twitch.namespace = Twitch.namespace;
            twitch.log = vi.fn();
            twitch.warn = vi.fn();
        });

        it('should not crash on random IRC-like strings', () => {
            fc.assert(
                fc.property(fc.string(), (input) => {
                    try {
                        twitch.parseIrcMessageToJson(input);
                        return true;
                    } catch (e) {
                        console.error('Crash on input:', input);
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should not crash on malformed tag values', () => {
            fc.assert(
                fc.property(
                    fc.array(fc.tuple(fc.string(), fc.string())),
                    (pairs) => {
                        const tagsStr = pairs.map(([k, v]) => `${k}=${v}`).join(';');
                        try {
                            twitch.parseIrcTags(tagsStr);
                            return true;
                        } catch (e) {
                            console.error('Crash on tags:', tagsStr);
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should not crash on malformed emote positions', () => {
            fc.assert(
                fc.property(
                    fc.string(),
                    fc.string(),
                    (emotesStr, message) => {
                        try {
                            twitch.parseEmotes(emotesStr, message);
                            return true;
                        } catch (e) {
                            console.error('Crash on emotes:', emotesStr, message);
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real IRC message tags', () => {
            const baseMessage = twitchEvents.realRecordingMessages[0];
            const parsed = twitch.parseIrcMessageToJson(baseMessage);

            fc.assert(
                fc.property(
                    fc.record({
                        'display-name': fc.string(),
                        'color': fc.string(),
                        'id': fc.string(),
                        'mod': fc.constantFrom('0', '1'),
                        'subscriber': fc.constantFrom('0', '1'),
                        'tmi-sent-ts': fc.integer({ min: 0 }).map(n => String(n))
                    }),
                    (tags) => {
                        const mutatedParsed = {
                            ...parsed,
                            tags: { ...parsed.tags, ...tags },
                            meta: { ...parsed.tags, ...tags }
                        };

                        try {
                            twitch.prepareChatMessage(mutatedParsed);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated tags:', JSON.stringify(tags));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
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
