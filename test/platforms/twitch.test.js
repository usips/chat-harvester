/**
 * CHUCK - Twitch Platform Tests
 * Tests for Twitch IRC-over-WebSocket message parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import twitchEvents from '../fixtures/twitch-events.json';

// Mock browser globals before importing Twitch
vi.stubGlobal('window', {
    location: { href: 'https://www.twitch.tv/streamerchannel', pathname: '/streamerchannel' },
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
const { uuidv5 } = await import('../../src/core/uuid.js');
const { Twitch, channelFromPath, SUB_PRICE_USD } = await import('../../src/platforms/twitch.js');

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
            expect(message.id).toBe(uuidv5('abc123-def456', Twitch.namespace));
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

    describe('channelFromPath', () => {
        it('reads the login from channel, popout, embed and moderator paths', () => {
            expect(channelFromPath('/hasanabi')).toBe('hasanabi');
            expect(channelFromPath('/HasanAbi/')).toBe('hasanabi');
            expect(channelFromPath('/popout/hasanabi/chat')).toBe('hasanabi');
            expect(channelFromPath('/embed/hasanabi/chat')).toBe('hasanabi');
            expect(channelFromPath('/moderator/hasanabi')).toBe('hasanabi');
        });

        it('returns null for pages without a live chat', () => {
            for (const path of ['/', '/directory', '/directory/category/just-chatting', '/settings/profile',
                '/videos/2345678901', '/hasanabi/videos', '/hasanabi/clip/SomeClip', '/p/en/legal/terms',
                '/popout/hasanabi/poll', '/search', '/not-a-login!']) {
                expect(channelFromPath(path)).toBeNull();
            }
        });
    });

    describe('Live payloads (2026-11)', () => {
        const live = twitchEvents.live;
        let twitch;

        /** A Twitch scraper on `login` that records what it would send. */
        function makeTwitch(login) {
            window.location.pathname = `/${login}`;
            const t = Object.create(Twitch.prototype);
            t.platform = 'Twitch';
            t.channel = login;
            t.channelId = null;
            t.viewers = null;
            t.hermesViewers = null;
            t.namespace = Twitch.namespace;
            t.chatSocket = null;
            t.log = vi.fn();
            t.warn = vi.fn();
            t.error = vi.fn();
            t.sent = [];
            t.removed = [];
            t.counts = [];
            t.sendChatMessages = vi.fn((messages) => t.sent.push(...messages));
            t.sendRemoveMessages = vi.fn((ids) => t.removed.push(...ids));
            t.sendViewerCount = vi.fn((count) => { t.viewers = count; t.counts.push(count); });
            t.pollViewers = vi.fn(() => Promise.resolve());
            t.recordWebSocketHandled = vi.fn();
            t.recordWebSocketIgnored = vi.fn();
            return t;
        }

        function feed(t, line) {
            return t.handleIrcCommand(t.parseIrcMessageToJson(line));
        }

        afterEach(() => {
            window.location.pathname = '/streamerchannel';
        });

        describe('chat messages', () => {
            beforeEach(() => {
                twitch = makeTwitch('zackrawrr');
            });

            it('uses a uuidv5 of the Twitch message id', () => {
                feed(twitch, live.HighlightedMessage);
                expect(twitch.sent).toHaveLength(1);
                expect(twitch.sent[0].id).toBe(uuidv5('a306431b-932c-4f99-a46f-7858b9535664', Twitch.namespace));
                expect(twitch.sent[0].username).toBe('GutsyGrim');
                expect(twitch.sent[0].sent_at).toBe(1794513008099);
            });

            it('keeps the text of a reply and learns the room id', () => {
                feed(twitch, live.Reply);
                expect(twitch.sent[0].message).toBe('@cm_punk90 yes he stepped down');
                expect(twitch.channelId).toBe('552120296');
            });

            it('maps v1 and emotesv2 ids to CDN urls', () => {
                feed(twitch, live.EmotesV2);
                const emojis = twitch.sent[0].emojis;
                expect(emojis.map(e => e[0])).toEqual(['LUL', 'LUL', 'assmondUp']);
                expect(emojis[0][1]).toBe('https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/1.0');
                expect(emojis[2][1]).toBe('https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_8ffb8ed8bf784d828fd9405d622207e6/default/dark/1.0');
            });

            it('counts emote positions in code points, not UTF-16 units', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.EmoteAfterEmoji);
                feed(twitch, live.EmoteAfterFlag);
                expect(twitch.sent[0].emojis.map(e => e[0])).toEqual(['LUL', 'hasFlex', 'hasFlex', 'hasFlex', 'hasFlex']);
                expect(twitch.sent[1].emojis.map(e => e[0])).toEqual(['hasRight', 'hasLeft']);
            });

            it('flags a bot moderator', () => {
                feed(twitch, live.BotModerator);
                expect(twitch.sent[0].is_mod).toBe(true);
                expect(twitch.sent[0].is_sub).toBe(true);
                expect(twitch.sent[0].username).toBe('Fossabot');
            });

            it('unwraps /me actions, keeping emote positions', () => {
                twitch = makeTwitch('sodapoppin');
                feed(twitch, live.Action);
                expect(twitch.sent[0].message).toBe('licks his knife');

                twitch = makeTwitch('hasanabi');
                feed(twitch, live.ActionWithEmotes);
                expect(twitch.sent[0].message).toBe('BegWan yoteSip dviperUp ffoxesSip nukkSnug');
                expect(twitch.sent[0].emojis.map(e => e[0])).toEqual(['BegWan', 'yoteSip', 'dviperUp', 'ffoxesSip', 'nukkSnug']);
            });

            it('values cheers at one cent per bit', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.Cheer);
                expect(twitch.sent[0].amount).toBe(1);
                expect(twitch.sent[0].currency).toBe('USD');

                twitch = makeTwitch('jynxzi');
                feed(twitch, live.CheerWithText);
                expect(twitch.sent[0].amount).toBe(0.2);
                expect(twitch.sent[0].message).toBe('Cheer20 When will Mike and Ronnie return also you should play plague Inc and Planet zoo 2');
            });

            it('keeps shared-chat messages but not a partner channel\'s bits', () => {
                twitch = makeTwitch('qtcinderella');
                feed(twitch, live.SharedChatMessage);
                expect(twitch.sent).toHaveLength(1);

                const partnerCheer = live.Cheer
                    .replace('room-id=207813352', 'room-id=207813352;source-room-id=1526864365');
                twitch = makeTwitch('hasanabi');
                feed(twitch, partnerCheer);
                expect(twitch.sent[0].amount).toBe(0);
            });

            it('ignores lines for another channel', () => {
                twitch = makeTwitch('hasanabi');
                expect(feed(twitch, live.Reply).status).toBe('ignored');
                expect(twitch.sent).toHaveLength(0);
            });

            it('ignores connection and state lines', () => {
                twitch = makeTwitch('sodapoppin');
                for (const line of [live.Join, live.Names, live.EndOfNames, twitchEvents.Ping]) {
                    expect(feed(twitch, line).status).toBe('ignored');
                }
                feed(twitch, live.RoomState);
                expect(twitch.channelId).toBe('26301881');
            });
        });

        describe('subscriptions and notices', () => {
            it('values a new Tier 1 sub at one month', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.Sub);
                const [message] = twitch.sent;
                expect(message.is_subscription).toBe(true);
                expect(message.amount).toBe(SUB_PRICE_USD['1000']);
                expect(message.currency).toBe('USD');
                expect(message.username).toBe('kylomellnuzzo');
                expect(message.message).toBe('kylomellnuzzo subscribed at Tier 1.');
                expect(message.id).toBe(uuidv5('947c2d0c-8ed1-42bd-8390-78050103d566', Twitch.namespace));
            });

            it('appends the user\'s resub message and its emotes', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.ResubPrime);
                const [message] = twitch.sent;
                expect(message.amount).toBe(SUB_PRICE_USD.Prime);
                expect(message.message).toBe("Erigel subscribed with Prime. They've subscribed for 41 months, currently on a 24 month streak! hasRaid hasRaid hasRaid hasRaid hasRaid");
                expect(message.emojis).toHaveLength(5);
                expect(message.emojis[0][0]).toBe('hasRaid');
            });

            it('values a monthly notice of a prepaid multi-month sub at one month', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.ResubMultiMonthTenure);
                expect(twitch.sent[0].amount).toBe(SUB_PRICE_USD['1000']);
            });

            it('values a new prepaid multi-month sub at its full duration', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.ResubMultiMonthTenure.replace('msg-param-multimonth-tenure=3', 'msg-param-multimonth-tenure=0'));
                expect(twitch.sent[0].amount).toBeCloseTo(SUB_PRICE_USD['1000'] * 6, 2);
            });

            it('counts a mystery gift once, not again per recipient', () => {
                twitch = makeTwitch('stableronaldo');
                feed(twitch, live.SubMysteryGift);
                expect(feed(twitch, live.SubGiftFromMystery).status).toBe('ignored');
                expect(twitch.sent).toHaveLength(1);
                expect(twitch.sent[0].is_subscription).toBe(true);
                expect(twitch.sent[0].amount).toBe(SUB_PRICE_USD['1000']);
                expect(twitch.sent[0].username).toBe('ghtzzi');
            });

            it('counts a mass gift by its gift count', () => {
                twitch = makeTwitch('stableronaldo');
                feed(twitch, live.SubMysteryGift.replace('msg-param-mass-gift-count=1', 'msg-param-mass-gift-count=10'));
                expect(twitch.sent[0].amount).toBeCloseTo(SUB_PRICE_USD['1000'] * 10, 2);
            });

            it('counts a direct gift whose mystery notice was not seen', () => {
                twitch = makeTwitch('stableronaldo');
                feed(twitch, live.SubGiftFromMystery);
                expect(twitch.sent).toHaveLength(1);
                expect(twitch.sent[0].message).toBe('ghtzzi gifted a Tier 1 sub to itsboogie!');
                expect(twitch.sent[0].amount).toBe(SUB_PRICE_USD['1000']);
            });

            it('skips another channel\'s gifts shown in a shared chat', () => {
                twitch = makeTwitch('qtcinderella');
                expect(feed(twitch, live.SharedChatMysteryGift).status).toBe('ignored');
                expect(twitch.sent).toHaveLength(0);
            });

            it('shows raids and announcements as plain messages', () => {
                twitch = makeTwitch('hasanabi');
                feed(twitch, live.Raid);
                feed(twitch, live.Announcement);
                expect(twitch.sent[0].message).toBe('33 raiders from HasanAbi_Waiting_Room_ have joined!');
                expect(twitch.sent[0].is_subscription).toBe(false);
                expect(twitch.sent[0].amount).toBe(0);
                expect(twitch.sent[1].username).toBe('Fossabot');
                expect(twitch.sent[1].is_mod).toBe(true);
                expect(twitch.sent[1].message).toMatch(/^Confused why people/);
            });

            it('shows a watch streak only with the user\'s message', () => {
                twitch = makeTwitch('zackrawrr');
                feed(twitch, live.ViewerMilestone);
                expect(twitch.sent[0].message).toBe('Lets go');
                expect(feed(twitch, live.ViewerMilestone.replace(' :Lets go', '')).status).toBe('ignored');
            });
        });

        describe('removals', () => {
            it('removes a deleted message by its uuid', () => {
                twitch = makeTwitch('realkatieb');
                feed(twitch, live.ClearMsg);
                expect(twitch.removed).toEqual([uuidv5('38672ce6-33d9-4680-892a-80e309f5e9ea', Twitch.namespace)]);
            });

            it('removes what a timed-out user sent, and only theirs', () => {
                twitch = makeTwitch('zackrawrr');
                const victim = live.HighlightedMessage.replace('user-id=43375955', 'user-id=1424313863');
                feed(twitch, victim);
                feed(twitch, live.Reply);
                feed(twitch, live.ClearChatTimeout);
                expect(twitch.removed).toEqual([uuidv5('a306431b-932c-4f99-a46f-7858b9535664', Twitch.namespace)]);

                // Nothing left to remove a second time.
                expect(feed(twitch, live.ClearChatTimeout).status).toBe('ignored');
            });

            it('removes everything sent on a full chat clear', () => {
                twitch = makeTwitch('zackrawrr');
                feed(twitch, live.HighlightedMessage);
                feed(twitch, live.Reply);
                feed(twitch, '@room-id=552120296;tmi-sent-ts=1794513000000 :tmi.twitch.tv CLEARCHAT #zackrawrr');
                expect(twitch.removed).toHaveLength(2);
            });

            it('bounds the per-user id map', () => {
                twitch = makeTwitch('zackrawrr');
                for (let i = 0; i < 2100; i++) {
                    feed(twitch, live.Reply.replace('user-id=984484139', `user-id=${i}`).replace('id=f91a0430', `id=${i}-f91a0430`));
                }
                expect(twitch.sentByUser.size).toBe(2000);
                expect(twitch.sentByUser.has('0')).toBe(false);
            });
        });

        describe('viewer counts', () => {
            function hermesFeed(t, frame) {
                t.processHermesMessage({ url: 'wss://hermes.twitch.tv/v1?clientId=x' }, frame);
            }

            beforeEach(() => {
                twitch = makeTwitch('sodapoppin');
                twitch.recordWebSocketHandled = vi.fn();
                twitch.recordWebSocketIgnored = vi.fn();
            });

            it('accepts a viewcount for the subscribed playback topic of this channel', () => {
                twitch.channelId = '26301881';
                twitch.learnHermesFrame(live.HermesSubscribePlayback);
                hermesFeed(twitch, live.HermesViewcount);
                expect(twitch.counts).toEqual([18018]);
            });

            it('ignores a viewcount for another channel\'s topic', () => {
                twitch.channelId = '26301881';
                twitch.learnHermesFrame(live.HermesSubscribePlayback.replace('video-playback-by-id.26301881', 'video-playback-by-id.552120296'));
                hermesFeed(twitch, live.HermesViewcount);
                // An unknown subscription (here: the previous channel's) is not ours either.
                hermesFeed(twitch, live.HermesViewcountZackrawrr);
                expect(twitch.counts).toEqual([]);
            });

            it('forgets unsubscribed topics', () => {
                twitch = makeTwitch('zackrawrr');
                twitch.recordWebSocketIgnored = vi.fn();
                twitch.channelId = '552120296';
                twitch.learnHermesFrame(JSON.stringify({ type: 'subscribe', id: 'a', subscribe: { id: 'q02fML4InfI7DcjvwqmOD', type: 'pubsub', pubsub: { topic: 'video-playback-by-id.552120296' } } }));
                twitch.learnHermesFrame(live.HermesUnsubscribe);
                hermesFeed(twitch, live.HermesViewcountZackrawrr);
                expect(twitch.counts).toEqual([]);
            });

            it('sends 0 when the stream goes down', () => {
                twitch.channelId = '26301881';
                twitch.learnHermesFrame(live.HermesSubscribePlayback);
                hermesFeed(twitch, JSON.stringify({ type: 'notification', notification: { subscription: { id: 'beCyAmH-VOpXGw2TT9FyO' }, type: 'pubsub', pubsub: '{"type":"stream-down","server_time":1794513300}' } }));
                expect(twitch.counts).toEqual([0]);
            });

            it('treats control frames as ignored', () => {
                hermesFeed(twitch, live.HermesUnsubscribeResponse);
                expect(twitch.counts).toEqual([]);
                expect(twitch.recordWebSocketIgnored).toHaveBeenCalled();
            });

            it('reports GQL\'s count when Hermes is quiet, and learns the channel id', () => {
                const user = { id: '26301881', login: 'sodapoppin', stream: { id: '322202520409', type: 'live', viewersCount: 15938 } };
                expect(twitch.receiveStreamInfo('sodapoppin', user)).toBe(15938);
                expect(twitch.channelId).toBe('26301881');
            });

            it('re-sends the fresher Hermes count on a GQL poll', () => {
                twitch.channelId = '26301881';
                twitch.learnHermesFrame(live.HermesSubscribePlayback);
                hermesFeed(twitch, live.HermesViewcount);
                const user = { id: '26301881', login: 'sodapoppin', stream: { id: '1', type: 'live', viewersCount: 15938 } };
                twitch.receiveStreamInfo('sodapoppin', user);
                expect(twitch.counts).toEqual([18018, 18018]);
            });

            it('sends 0 once for an offline channel', () => {
                const user = { id: '71092938', login: 'sodapoppin', stream: null };
                twitch.receiveStreamInfo('sodapoppin', user);
                twitch.receiveStreamInfo('sodapoppin', user);
                expect(twitch.counts).toEqual([0]);
            });

            it('ignores GQL answers about another channel or a missing user', () => {
                expect(twitch.receiveStreamInfo('sodapoppin', { id: '1', login: 'xqc', stream: { viewersCount: 5 } })).toBeNull();
                expect(twitch.receiveStreamInfo('xqc', { id: '1', login: 'xqc', stream: { viewersCount: 5 } })).toBeNull();
                expect(twitch.receiveStreamInfo('sodapoppin', null)).toBeNull();
                expect(twitch.counts).toEqual([]);
            });

            it('polls GQL with the unpatched fetch and the web Client-ID', async () => {
                const fetchSpy = vi.fn(() => Promise.resolve({
                    json: () => Promise.resolve({ data: { user: { id: '26301881', login: 'sodapoppin', stream: { id: '1', type: 'live', viewersCount: 777 } } } }),
                }));
                window.fetch.oldFetch = fetchSpy;
                try {
                    await Twitch.prototype.pollViewers.call(twitch);
                } finally {
                    delete window.fetch.oldFetch;
                }
                expect(fetchSpy).toHaveBeenCalledTimes(1);
                const [url, init] = fetchSpy.mock.calls[0];
                expect(url).toBe('https://gql.twitch.tv/gql');
                expect(init.headers['Client-ID']).toBe('kimne78kx3ncx6brgo4mv6wki5h1ko');
                expect(JSON.parse(init.body).variables).toEqual({ login: 'sodapoppin' });
                expect(twitch.counts).toEqual([777]);
            });

            it('reads the stream record out of the page\'s own GQL answers', async () => {
                twitch.recordFetchHandled = vi.fn();
                twitch.recordFetchIgnored = vi.fn();
                const body = [{ data: { user: { id: '26301881', login: 'sodapoppin', stream: { id: '1', viewersCount: 16001 } } } },
                    { data: { sideNav: { sections: [{ content: { edges: [{ node: { broadcaster: { login: 'sodapoppin' }, viewersCount: 1 } }] } }] } } }];
                await twitch.onFetchResponse({ url: 'https://gql.twitch.tv/gql', status: 200, json: () => Promise.resolve(body) });
                expect(twitch.counts).toEqual([16001]);
            });
        });

        describe('navigation', () => {
            it('switches channel when the address bar changes, zeroing the old count', () => {
                twitch = makeTwitch('zackrawrr');
                twitch.setChannel = vi.fn((c) => { twitch.channel = c; });
                twitch.chatSocket = { readyState: 1 };
                twitch.viewers = 42478;
                twitch.channelId = '552120296';
                window.location.pathname = '/sodapoppin';

                twitch.onWebSocketSend({ url: 'wss://irc-ws.chat.twitch.tv/' }, 'JOIN #sodapoppin');

                expect(twitch.counts).toEqual([0]);
                expect(twitch.channel).toBe('sodapoppin');
                expect(twitch.channelId).toBeNull();
                expect(twitch.viewers).toBeNull();
                expect(twitch.pollViewers).toHaveBeenCalled();
            });

            it('stops scraping on a page without chat', async () => {
                twitch = makeTwitch('zackrawrr');
                window.location.pathname = '/directory';
                // The next poll notices the page change before it would fetch.
                await Twitch.prototype.pollViewers.call(twitch);
                expect(feed(twitch, live.Reply).status).toBe('ignored');
                expect(twitch.channel).toBeNull();
                expect(twitch.sent).toHaveLength(0);
            });
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
