/**
 * CHUCK - Kick Platform Tests
 *
 * Covers both realtime providers: Centrifugo (current) and Pusher (fallback).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import kickEvents from '../fixtures/kick-events.json';

// Mock browser globals before importing Kick
vi.stubGlobal('window', {
    location: { href: 'https://kick.com/testchannel', pathname: '/testchannel' },
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
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { uuidv5 } = await import('../../src/core/uuid.js');
const { Kick, parseChannelScope, channelSlugFromPath } = await import('../../src/platforms/kick.js');

/** Pretend the user navigated client-side to another channel. */
function setPath(pathname) {
    window.location.pathname = pathname;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A Kick instance with no constructor side effects and everything observable. */
function makeKick() {
    const kick = Object.create(Kick.prototype);
    kick.platform = 'Kick';
    kick.channel = 'testchannel';
    kick.namespace = Kick.namespace;
    kick.channel_id = null;
    kick.chatroom_id = null;
    kick.livestream_id = null;
    kick.idsFromRest = false;
    kick.unknownBadges = new Set();
    kick.viewers = null;
    kick.chatSocket = null;
    kick.updateQueue = [];
    kick.chatMessageQueue = [];
    kick.log = vi.fn();
    kick.warn = vi.fn();
    kick.error = vi.fn();
    kick._debug = vi.fn();
    kick.recorder = { record: vi.fn(), recordChatMessage: vi.fn(), recordWebSocket: vi.fn(), recordFetch: vi.fn() };
    return kick;
}

/** A Kick instance whose outbound calls are spies rather than queued updates. */
function makeSpyKick() {
    const kick = makeKick();
    kick.sendChatMessages = vi.fn();
    kick.sendRemoveMessages = vi.fn();
    kick.sendViewerCount = vi.fn();
    kick.receiveSubscriptions = vi.fn();
    return kick;
}

const fakeWs = { _chuck_url: 'wss://realtime.us-west-2.platform.kick.com/connection/websocket' };

/** Feed a raw frame through the full websocket path. */
function feed(kick, raw) {
    kick.recordWebSocketHandled = vi.fn();
    kick.recordWebSocketIgnored = vi.fn();
    kick.recordWebSocketUnhandled = vi.fn();
    kick.onWebSocketMessage(fakeWs, { data: raw });
    return kick;
}

describe('Kick envelope normalization', () => {
    it('normalizes a Centrifugo chat push', () => {
        const frames = Kick.normalizeFrame(kickEvents.centrifugo.chatMessage);

        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('event');
        expect(frames[0].channel).toBe('chatrooms.26581095.v2');
        expect(frames[0].event).toBe('App\\Events\\ChatMessageEvent');
        expect(frames[0].data.id).toBe('22fc20f6-8bd3-46d6-88dc-11cbd4b54043');
    });

    it('accepts a push whose data is already an object', () => {
        const raw = JSON.stringify({
            push: {
                channel: 'chatrooms.1.v2',
                pub: { data: { event: 'App\\Events\\ChatMessageEvent', data: { id: 'x', content: 'hi' } } },
            },
        });

        const [frame] = Kick.normalizeFrame(raw);
        expect(frame.kind).toBe('event');
        expect(frame.data.content).toBe('hi');
    });

    it('splits newline-batched frames', () => {
        const frames = Kick.normalizeFrame(kickEvents.centrifugo.batchedTwoPushes);

        expect(frames).toHaveLength(2);
        expect(frames.every(f => f.kind === 'event')).toBe(true);
        expect(frames[0].data.type).toBe('message');
        expect(frames[1].data.type).toBe('reply');
    });

    it('classifies the empty-object heartbeat as ignored', () => {
        const [frame] = Kick.normalizeFrame(kickEvents.centrifugo.ping);
        expect(frame.kind).toBe('ignored');
        expect(frame.reason).toMatch(/heartbeat/i);
    });

    it('classifies Centrifugo replies as ignored', () => {
        for (const raw of [kickEvents.centrifugo.connectReply, kickEvents.centrifugo.subscribeReply]) {
            const [frame] = Kick.normalizeFrame(raw);
            expect(frame.kind).toBe('ignored');
            expect(frame.reason).toMatch(/command\/reply/i);
        }
    });

    it('classifies non-publication pushes as ignored', () => {
        const [frame] = Kick.normalizeFrame(kickEvents.centrifugo.joinPush);
        expect(frame.kind).toBe('ignored');
        expect(frame.reason).toBe('Centrifugo push: join');
    });

    it('normalizes the Pusher envelope', () => {
        const [frame] = Kick.normalizeFrame(kickEvents.pusherFrame);
        expect(frame.kind).toBe('event');
        expect(frame.channel).toBe('chatrooms.2507974.v2');
        expect(frame.event).toBe('App\\Events\\ChatMessageEvent');
        expect(frame.data.content).toBe('Hello world!');
    });

    it('classifies viewer-socket frames as ignored', () => {
        for (const raw of Object.values(kickEvents.viewerSocket)) {
            const [frame] = Kick.normalizeFrame(raw);
            expect(frame.kind).toBe('ignored');
            expect(frame.reason).toBe('Viewer socket frame');
        }
    });

    it('classifies unparseable frames as unhandled without throwing', () => {
        const [frame] = Kick.normalizeFrame(kickEvents.centrifugo.garbage);
        expect(frame.kind).toBe('unhandled');
        expect(frame.reason).toBe('Frame is not JSON');
    });

    it('handles non-string frames', () => {
        expect(Kick.normalizeFrame(new ArrayBuffer(4))[0].kind).toBe('ignored');
        expect(Kick.normalizeFrame(null)[0].kind).toBe('ignored');
        expect(Kick.normalizeFrame('[1,2,3]')[0].kind).toBe('ignored');
        expect(Kick.normalizeFrame('{"foo":"bar"}')[0].kind).toBe('unhandled');
    });
});

describe('Kick channel scopes', () => {
    it('parses every observed channel shape', () => {
        expect(parseChannelScope('chatrooms.26581095.v2')).toEqual({ chatroomId: 26581095, channelId: null });
        expect(parseChannelScope('chatrooms.26581095')).toEqual({ chatroomId: 26581095, channelId: null });
        expect(parseChannelScope('chatroom_26581095')).toEqual({ chatroomId: 26581095, channelId: null });
        expect(parseChannelScope('channel_67152631')).toEqual({ chatroomId: null, channelId: 67152631 });
        expect(parseChannelScope('channel.14899489')).toEqual({ chatroomId: null, channelId: 14899489 });
        expect(parseChannelScope('predictions-channel-5')).toEqual({ chatroomId: null, channelId: null });
        expect(parseChannelScope(null)).toEqual({ chatroomId: null, channelId: null });
    });

    it('learns the chatroom id from an outbound Centrifugo subscribe', () => {
        const kick = makeSpyKick();
        kick.recordWebSocketHandled = vi.fn();
        kick.recordWebSocketIgnored = vi.fn();
        kick.recordWebSocketUnhandled = vi.fn();

        kick.onWebSocketSend(fakeWs, kickEvents.centrifugo.outboundSubscribeChatroom);
        kick.onWebSocketSend(fakeWs, kickEvents.centrifugo.outboundSubscribeChannel);

        expect(kick.chatroom_id).toBe(26581095);
        expect(kick.channel_id).toBe(67152631);
        expect(kick.recordWebSocketHandled).toHaveBeenCalledTimes(2);
    });

    it('learns the chatroom id from an outbound Pusher subscribe', () => {
        const kick = makeSpyKick();
        kick.recordWebSocketHandled = vi.fn();
        kick.onWebSocketSend(fakeWs, kickEvents.pusherSubscribe);
        expect(kick.chatroom_id).toBe(2507974);
    });

    it('does not let learned ids override REST ids', () => {
        const kick = makeSpyKick();
        kick.recordWebSocketHandled = vi.fn();
        kick.recordWebSocketIgnored = vi.fn();
        kick.applyChannelInfo({ id: 1, chatroom: { id: 2 }, livestream: null });

        kick.onWebSocketSend(fakeWs, kickEvents.centrifugo.outboundSubscribeChatroom);

        expect(kick.chatroom_id).toBe(2);
        expect(kick.channel_id).toBe(1);
    });

    it('drops chat events belonging to another chatroom', () => {
        const kick = makeSpyKick();
        kick.chatroom_id = 999;
        feed(kick, kickEvents.centrifugo.chatMessage);

        expect(kick.sendChatMessages).not.toHaveBeenCalled();
        expect(kick.recordWebSocketIgnored).toHaveBeenCalledWith(
            fakeWs, 'in', kickEvents.centrifugo.chatMessage,
            'App\\Events\\ChatMessageEvent', 'Event for another chatroom'
        );
    });

    it('accepts chat events while the chatroom id is unknown', () => {
        const kick = makeSpyKick();
        feed(kick, kickEvents.centrifugo.chatMessage);
        expect(kick.sendChatMessages).toHaveBeenCalledTimes(1);
    });
});

describe('Kick channel slug', () => {
    afterEach(() => setPath('/testchannel'));

    it('reads the slug from a pathname', () => {
        expect(channelSlugFromPath('/absi')).toBe('absi');
        expect(channelSlugFromPath('/absi/videos')).toBe('absi');
        expect(channelSlugFromPath('/popout/absi/chat')).toBe('absi');
        expect(channelSlugFromPath('/ABSI')).toBe('absi');
        expect(channelSlugFromPath('/')).toBe(null);
        expect(channelSlugFromPath('')).toBe(null);
        expect(channelSlugFromPath('/popout')).toBe(null);
        expect(channelSlugFromPath(null)).toBe(null);
        expect(channelSlugFromPath(undefined)).toBe(null);
    });

    it('re-bootstraps when the user navigates to another channel', () => {
        const kick = makeSpyKick();
        kick.fetchChatHistory = vi.fn();
        kick.recordWebSocketHandled = vi.fn();
        kick.applyChannelInfo({ id: 1, slug: 'testchannel', chatroom: { id: 111 }, livestream: { id: 9 } });

        setPath('/popout/otherchannel/chat');
        kick.onWebSocketSend(fakeWs, '{"id":9,"subscribe":{"channel":"chatrooms.222.v2"}}');

        expect(kick.channel).toBe('otherchannel');
        expect(kick.chatroom_id).toBe(222);
        expect(kick.channel_id).toBe(null);
        expect(kick.livestream_id).toBe(null);
        expect(kick.fetchChatHistory).toHaveBeenCalledTimes(1);

        feed(kick, JSON.stringify({
            event: 'App\\Events\\ChatMessageEvent',
            channel: 'chatrooms.222.v2',
            data: JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', content: 'hi there' }),
        }));

        expect(kick.sendChatMessages).toHaveBeenCalledTimes(1);
    });

    it('stays put when the slug is unchanged', () => {
        const kick = makeSpyKick();
        kick.fetchChatHistory = vi.fn();
        kick.recordWebSocketHandled = vi.fn();
        kick.applyChannelInfo({ id: 1, slug: 'testchannel', chatroom: { id: 111 }, livestream: { id: 9 } });

        kick.onWebSocketSend(fakeWs, '{"id":9,"subscribe":{"channel":"chatrooms.111.v2"}}');

        expect(kick.channel).toBe('testchannel');
        expect(kick.chatroom_id).toBe(111);
        expect(kick.livestream_id).toBe(9);
        expect(kick.fetchChatHistory).not.toHaveBeenCalled();
    });
});

describe('Kick dispatch', () => {
    let kick;

    beforeEach(() => {
        kick = makeSpyKick();
    });

    it('sends a chat message from a Centrifugo push', () => {
        feed(kick, kickEvents.centrifugo.chatMessage);

        const [[messages]] = kick.sendChatMessages.mock.calls;
        expect(messages).toHaveLength(1);
        expect(messages[0].username).toBe('obood_12');
        expect(kick.recordWebSocketHandled).toHaveBeenCalledTimes(1);
    });

    it('sends both messages of a batched frame', () => {
        feed(kick, kickEvents.centrifugo.batchedTwoPushes);
        expect(kick.sendChatMessages).toHaveBeenCalledTimes(2);
    });

    it('sends a chat message from a Pusher frame', () => {
        feed(kick, kickEvents.pusherFrame);
        expect(kick.sendChatMessages).toHaveBeenCalledTimes(1);
    });

    it('removes a deleted message even when aiModerated is true', () => {
        feed(kick, kickEvents.centrifugo.messageDeleted);

        expect(kick.sendRemoveMessages).toHaveBeenCalledWith(['5e3bfc62-349f-46c3-9451-c9b77d9ead22']);
    });

    it('uuidv5s a non-uuid removal id', () => {
        const kick2 = makeSpyKick();
        const raw = JSON.stringify({
            event: 'App\\Events\\MessageDeletedEvent',
            channel: 'chatrooms.1.v2',
            data: JSON.stringify({ message: { id: 'legacy-numeric-id' } }),
        });
        feed(kick2, raw);

        const [[ids]] = kick2.sendRemoveMessages.mock.calls;
        expect(ids[0]).toBe(uuidv5('legacy-numeric-id', Kick.namespace));
        expect(ids[0]).toMatch(UUID_RE);
    });

    it('records a deletion without a message id as unhandled', () => {
        const raw = JSON.stringify({
            event: 'App\\Events\\MessageDeletedEvent',
            channel: 'chatrooms.1.v2',
            data: '{"aiModerated":true}',
        });
        feed(kick, raw);

        expect(kick.sendRemoveMessages).not.toHaveBeenCalled();
        expect(kick.recordWebSocketUnhandled).toHaveBeenCalled();
    });

    it('announces a direct subscription', () => {
        const event = kickEvents.SubscriptionEvent;
        feed(kick, JSON.stringify({ event: event.event, data: event.data, channel: event.channel }));

        const [[sub]] = kick.receiveSubscriptions.mock.calls;
        expect(sub.buyer).toBe('feepsyy');
        expect(sub.count).toBe(2);
        expect(sub.gifted).toBe(false);
        expect(sub.value).toBe(5);
    });

    it('sends a Kicks gift', () => {
        feed(kick, kickEvents.centrifugo.kicksGifted);

        const [[messages]] = kick.sendChatMessages.mock.calls;
        expect(messages[0].username).toBe('Ching26');
        expect(messages[0].currency).toBe('KICKS');
    });

    it('updates viewers from a livestream update', () => {
        const event = kickEvents.LivestreamUpdated;
        feed(kick, JSON.stringify({ event: event.event, data: event.data, channel: event.channel }));

        expect(kick.sendViewerCount).toHaveBeenCalledWith(1234);
    });

    it('records known noise events as ignored', () => {
        const noisy = [
            kickEvents.centrifugo.rewardRedeemed,
            kickEvents.centrifugo.kicksLeaderboardUpdated,
            kickEvents.centrifugo.giftsLeaderboardUpdated,
            kickEvents.centrifugo.chatroomUpdated,
            kickEvents.centrifugo.chatSettingsChanged,
            kickEvents.centrifugo.userBanned,
            kickEvents.centrifugo.userUnbanned,
            kickEvents.centrifugo.goalProgress,
        ];

        for (const raw of noisy) {
            feed(kick, raw);
            expect(kick.recordWebSocketIgnored).toHaveBeenCalledTimes(1);
            expect(kick.recordWebSocketUnhandled).not.toHaveBeenCalled();
        }

        expect(kick.sendChatMessages).not.toHaveBeenCalled();
    });

    it('never fabricates a message from a malformed payload', () => {
        const malformed = [
            ['App\\Events\\ChatMessageEvent', '"just a string"'],
            ['App\\Events\\ChatMessageEvent', '[1,2,3]'],
            ['App\\Events\\ChatMessageEvent', '{"content":"no id here"}'],
            ['App\\Events\\ChatMessageEvent', '{"id":12345,"content":"numeric id"}'],
            ['KicksGifted', '"not an object"'],
            ['KicksGifted', '[]'],
        ];

        for (const [event, data] of malformed) {
            const outcome = kick.handleEvent('chatrooms.1.v2', event, JSON.parse(data));
            expect(outcome.status).toBe('unhandled');
        }

        expect(kick.sendChatMessages).not.toHaveBeenCalled();
    });

    it('records a truly unknown event as unhandled', () => {
        feed(kick, JSON.stringify({ event: 'App\\Events\\BrandNewEvent', data: '{}', channel: 'chatrooms.1.v2' }));
        expect(kick.recordWebSocketUnhandled).toHaveBeenCalled();
    });

    it('never throws on garbage frames and records them', () => {
        expect(() => feed(kick, kickEvents.centrifugo.garbage)).not.toThrow();
        expect(kick.recordWebSocketUnhandled).toHaveBeenCalled();
    });

    it('records ERROR when a handler throws, without rethrowing', () => {
        kick.sendChatMessages = vi.fn(() => { throw new Error('backend exploded'); });

        expect(() => feed(kick, kickEvents.centrifugo.chatMessage)).not.toThrow();
        expect(kick.recorder.record).toHaveBeenCalledWith(
            'ws_message', expect.anything(), 'error', null, 'backend exploded'
        );
    });
});

describe('Kick prepareChatMessage', () => {
    let kick;

    beforeEach(() => {
        kick = makeKick();
    });

    const dataOf = raw => Kick.normalizeFrame(raw)[0].data;

    it('parses a standard chat message', () => {
        const message = kick.prepareChatMessage(JSON.parse(kickEvents.ChatMessageEvent.data));

        expect(message).toBeInstanceOf(ChatMessage);
        expect(message.username).toBe('TestUser');
        expect(message.message).toBe('Hello world!');
        expect(message.is_sub).toBe(true);
        expect(message.amount).toBe(0);
    });

    it('parses a live message with badges_v2 present', () => {
        const data = dataOf(kickEvents.centrifugo.chatMessage);
        expect(data.sender.identity.badges_v2).toBeDefined();

        const message = kick.prepareChatMessage(data);
        expect(message.id).toBe('22fc20f6-8bd3-46d6-88dc-11cbd4b54043');
        expect(message.is_sub).toBe(true);
        expect(message.is_mod).toBe(false);
        expect(message.sent_at).toBe(Date.parse('2026-09-10T12:29:24+00:00'));
    });

    it('parses a reply message', () => {
        const data = dataOf(kickEvents.centrifugo.chatMessageReply);
        expect(data.type).toBe('reply');

        const message = kick.prepareChatMessage(data);
        expect(message.message).toBe('LOL');
        expect(message.username).toBe('Carter917');
    });

    it('gives a celebration message text of its own', () => {
        const data = dataOf(kickEvents.centrifugo.chatMessageCelebration);
        const message = kick.prepareChatMessage(data);

        expect(message.message).toBe('obood_12 celebrated: subscription renewed');
    });

    it('tolerates metadata arriving as a JSON string', () => {
        const data = dataOf(kickEvents.centrifugo.chatMessageCelebration);
        data.metadata = JSON.stringify(data.metadata);

        expect(kick.prepareChatMessage(data).message).toBe('obood_12 celebrated: subscription renewed');
    });

    it('converts gift cents to USD', () => {
        const message = kick.prepareChatMessage(JSON.parse(kickEvents.ChatMessageWithGift.data));

        expect(message.amount).toBe(5);
        expect(message.currency).toBe('USD');
    });

    it('extracts emotes', () => {
        const message = kick.prepareChatMessage({
            id: '0e7bd4a9-0e6f-4a55-9c0e-5f2b45d0a111',
            content: 'Hello [emote:37221:EZ] world [emote:12345:Kappa]',
            sender: { username: 'EmoteUser', identity: { badges: [] } },
        });

        expect(message.emojis).toHaveLength(2);
        expect(message.emojis[0]).toEqual(['[emote:37221:EZ]', 'https://files.kick.com/emotes/37221/fullsize', 'EZ']);
    });

    it('maps role badges to flags and ignores cosmetic ones', () => {
        const flags = badges => kick.prepareChatMessage({
            id: 'badge-test',
            content: 'hi',
            sender: { username: 'U', identity: { badges: badges.map(type => ({ type })) } },
        });

        expect(flags(['broadcaster']).is_owner).toBe(true);
        expect(flags(['moderator']).is_mod).toBe(true);
        expect(flags(['verified']).is_verified).toBe(true);
        expect(flags(['subscriber']).is_sub).toBe(true);
        expect(flags(['sub_gifter']).is_sub).toBe(true);

        const cosmetic = flags(['vip', 'og', 'founder', 'bot']);
        expect([cosmetic.is_owner, cosmetic.is_mod, cosmetic.is_sub, cosmetic.is_verified]).toEqual([false, false, false, false]);
        expect(kick.log).not.toHaveBeenCalled();
    });

    it('logs an unknown badge type only once', () => {
        const data = { id: 'x', content: 'hi', sender: { username: 'U', identity: { badges: [{ type: 'space_marine' }] } } };
        kick.prepareChatMessage(data);
        kick.prepareChatMessage(data);

        expect(kick.log).toHaveBeenCalledTimes(1);
    });

    it('passes native uuids through and uuidv5s everything else', () => {
        const native = kick.prepareChatMessage({ id: '22fc20f6-8bd3-46d6-88dc-11cbd4b54043' });
        expect(native.id).toBe('22fc20f6-8bd3-46d6-88dc-11cbd4b54043');

        const legacy = kick.prepareChatMessage({ id: '123456' });
        expect(legacy.id).toBe(uuidv5('123456', Kick.namespace));
        expect(legacy.id).toMatch(UUID_RE);
    });

    it('parses every real recorded message', () => {
        for (const event of kickEvents.realRecordingMessages) {
            const message = kick.prepareChatMessage(JSON.parse(event.data));
            expect(message.id).toMatch(UUID_RE);
            expect(message.username).toBeTruthy();
        }

        const first = kick.prepareChatMessage(JSON.parse(kickEvents.realRecordingMessages[0].data));
        expect(first.username).toBe('CrispyLegs');
        expect(first.is_mod).toBe(true);
        expect(first.emojis[0][2]).toBe('OuttaPocket');
    });
});

describe('Kick prepareKicksGiftedMessage', () => {
    let kick;

    beforeEach(() => {
        kick = makeKick();
    });

    it('uses gift_transaction_id when it is a uuid', () => {
        const data = JSON.parse(kickEvents.KicksGiftedLevelUp.data);
        const message = kick.prepareKicksGiftedMessage(data);

        expect(message.id).toBe('c3aad5e3-688d-413a-9f93-4834413f750c');
        expect(message.username).toBe('alalisa11');
        expect(message.amount).toBe(1000);
        expect(message.currency).toBe('KICKS');
        expect(message.avatar).toBe('https://kick.com/img/default-profile-pictures/default-avatar-4.webp');
        expect(message.sent_at).toBe(Date.parse('2026-01-14T17:58:57.996338008Z'));
    });

    it('derives a uuid when gift_transaction_id is missing', () => {
        const data = JSON.parse(kickEvents.KicksGifted.data);
        const message = kick.prepareKicksGiftedMessage(data);

        expect(message.id).toMatch(UUID_RE);
        expect(message.username).toBe('Reds_cat');
        expect(message.amount).toBe(1);
        expect(message.message).toContain('Hell Yeah');
    });

    it('parses the live BASIC-tier gift', () => {
        const data = Kick.normalizeFrame(kickEvents.centrifugo.kicksGifted)[0].data;
        const message = kick.prepareKicksGiftedMessage(data);

        expect(message.id).toBe('b5672ba5-f3a9-4102-9211-77376b082e43');
        expect(message.message).toBe('Sent a Hell Yeah!');
        expect(message.sent_at).toBe(Date.parse('2026-09-10T12:30:56.786327703Z'));
    });

    it('falls back to now on an unparseable created_at', () => {
        const message = kick.prepareKicksGiftedMessage({ created_at: 'not a date', gift: { amount: 5 } });
        expect(Number.isNaN(message.sent_at)).toBe(false);
    });
});

describe('Kick gifted subscriptions', () => {
    let kick;

    beforeEach(() => {
        kick = makeSpyKick();
    });

    const dispatch = raw => {
        const frame = Kick.normalizeFrame(raw)[0];
        return kick.handleEvent(frame.channel, frame.event, frame.data);
    };

    it('handles the modern SubscriptionGifted shape', () => {
        const event = kickEvents.SubscriptionGifted;
        dispatch(JSON.stringify({ event: event.event, data: event.data, channel: event.channel }));

        const [[sub]] = kick.receiveSubscriptions.mock.calls;
        expect(sub).toMatchObject({ id: '328bc7ec-1ffe-48f2-ab09-abd5998b63b8', buyer: 'Profileo', count: 5, gifted: true });
    });

    it('handles the prefixed legacy shape', () => {
        const event = kickEvents.GiftedSubscriptionsEventLegacy;
        dispatch(JSON.stringify({ event: event.event, data: event.data, channel: event.channel }));

        const [[sub]] = kick.receiveSubscriptions.mock.calls;
        expect(sub.buyer).toBe('court');
        expect(sub.count).toBe(1);
    });

    it('handles the live unprefixed shape and prefers gifted_total', () => {
        dispatch(kickEvents.centrifugo.giftedSubscriptions);

        const [[sub]] = kick.receiveSubscriptions.mock.calls;
        expect(sub.buyer).toBe('Masri');
        expect(sub.count).toBe(1);
        expect(sub.id).toBe('dHJhbnNhY3Rpb25fNHo5MHR2cmM');
    });

    it('prefers gifted_total over a truncated username list', () => {
        dispatch(JSON.stringify({
            event: 'GiftedSubscriptionsEvent',
            channel: 'chatroom_1',
            data: JSON.stringify({
                gifter_username: 'WhaleSub',
                gifted_usernames: ['a', 'b', 'c'],
                gifted_total: 100,
            }),
        }));

        expect(kick.receiveSubscriptions.mock.calls[0][0].count).toBe(100);
    });

    it('gives every chunk of one drop the same id', () => {
        const chunk = index => JSON.stringify({
            event: 'GiftedSubscriptionsEvent',
            channel: 'chatroom_26581095',
            data: JSON.stringify({
                correlation_id: 'dHJhbnNhY3Rpb25fY2h1bms',
                gifter_username: 'Masri',
                gifted_usernames: ['a', 'b'],
                gifted_total: 50,
                chunk_details: { correlation_id: 'dHJhbnNhY3Rpb25fY2h1bms', chunk_index: index, total_chunks: 3 },
            }),
        });

        dispatch(chunk(0));
        dispatch(chunk(1));
        dispatch(chunk(2));

        const ids = kick.receiveSubscriptions.mock.calls.map(([sub]) => sub.id);
        expect(new Set(ids).size).toBe(1);
    });

    it('produces a uuid message id through receiveSubscriptions', () => {
        const real = makeKick();
        real.handleEvent('chatroom_26581095', 'GiftedSubscriptionsEvent', {
            correlation_id: 'dHJhbnNhY3Rpb25fNHo5MHR2cmM',
            gifter_username: 'Masri',
            gifted_usernames: ['Salem5nz'],
            gifted_total: 1,
        });

        const message = real.updateQueue[0].messages[0];
        expect(message.id).toMatch(UUID_RE);
        expect(message.amount).toBe(5);
        expect(message.is_subscription).toBe(true);
        expect(message.message).toBe('Masri gifted a subscription!');
    });

    it('announces a 100-sub drop at $500', () => {
        const real = makeKick();
        real.receiveSubscriptions({ id: 'drop', gifted: true, buyer: 'BigTipper', count: 100, value: 5 });

        const message = real.updateQueue[0].messages[0];
        expect(message.amount).toBe(500);
        expect(message.message).toBe('BigTipper gifted 100 subscriptions!');
    });

    it('records an unrecognized gift shape as unhandled', () => {
        const outcome = kick.handleEvent('chatroom_1', 'GiftedSubscriptionsEvent', { mystery: true });
        expect(outcome.status).toBe('unhandled');
        expect(kick.receiveSubscriptions).not.toHaveBeenCalled();
    });
});

describe('Kick HTTP intercept', () => {
    const jsonResponse = (url, body) => ({
        url,
        status: 200,
        clone: () => ({ json: () => Promise.resolve(body) }),
    });

    it('sends viewer counts from /current-viewers', async () => {
        const kick = makeSpyKick();
        kick.recordFetchHandled = vi.fn();
        kick.livestream_id = 77;

        await kick.onFetchResponse(jsonResponse('https://kick.com/current-viewers?ids[]=77', [
            { livestream_id: 12, viewers: 5 },
            { livestream_id: 77, viewers: 4321 },
        ]));

        expect(kick.sendViewerCount).toHaveBeenCalledWith(4321);
    });

    it('learns ids and viewers from channel info', async () => {
        const kick = makeSpyKick();
        kick.recordFetchHandled = vi.fn();

        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/testchannel', {
            id: 67152631,
            slug: 'testchannel',
            chatroom: { id: 26581095 },
            livestream: { id: 9001, viewer_count: 1500 },
        }));

        expect(kick.channel_id).toBe(67152631);
        expect(kick.chatroom_id).toBe(26581095);
        expect(kick.livestream_id).toBe(9001);
        expect(kick.sendViewerCount).toHaveBeenCalledWith(1500);
    });

    it('leaves ids alone for the followed-channels list', async () => {
        const kick = makeSpyKick();
        kick.recordFetchIgnored = vi.fn();
        kick.channel_id = 67152631;
        kick.chatroom_id = 26581095;
        kick.livestream_id = 9001;

        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/followed', [
            { id: 1, slug: 'someone-else', livestream: null },
        ]));

        expect(kick.channel_id).toBe(67152631);
        expect(kick.chatroom_id).toBe(26581095);
        expect(kick.livestream_id).toBe(9001);
        expect(kick.recordFetchIgnored).toHaveBeenCalled();
    });

    it('ignores channel info belonging to another slug', async () => {
        const kick = makeSpyKick();
        kick.recordFetchIgnored = vi.fn();
        kick.channel_id = 67152631;
        kick.livestream_id = 9001;

        // A URL that does name our channel, but a payload that does not.
        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/testchannel', {
            id: 5,
            slug: 'someone-else',
            chatroom: { id: 6 },
            livestream: null,
        }));

        expect(kick.channel_id).toBe(67152631);
        expect(kick.livestream_id).toBe(9001);
        expect(kick.recordFetchIgnored).toHaveBeenCalledWith(
            expect.any(String), 'GET', 200, 'Channel info for another channel'
        );
    });

    it('keeps the livestream id when the payload omits livestream', async () => {
        const kick = makeSpyKick();
        kick.recordFetchHandled = vi.fn();
        kick.livestream_id = 9001;

        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/testchannel', {
            id: 42,
            slug: 'testchannel',
            chatroom: { id: 7 },
        }));

        expect(kick.livestream_id).toBe(9001);
        expect(kick.chatroom_id).toBe(7);
    });

    it('accepts channel info addressed by numeric id', async () => {
        const kick = makeSpyKick();
        kick.recordFetchHandled = vi.fn();
        kick.channel_id = 42;

        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/42', {
            id: 42,
            chatroom: { id: 7 },
            livestream: { id: 5, viewers: 12 },
        }));

        expect(kick.chatroom_id).toBe(7);
        expect(kick.livestream_id).toBe(5);
        expect(kick.sendViewerCount).toHaveBeenCalledWith(12);
    });

    it('ignores unmonitored endpoints', async () => {
        const kick = makeSpyKick();
        kick.recordFetchIgnored = vi.fn();

        await kick.onFetchResponse(jsonResponse('https://kick.com/api/v2/channels/1/messages', {}));

        expect(kick.recordFetchIgnored).toHaveBeenCalled();
    });

    it('records ERROR when a body cannot be read', async () => {
        const kick = makeSpyKick();
        const response = {
            url: 'https://kick.com/current-viewers',
            status: 200,
            clone: () => ({ json: () => Promise.reject(new Error('bad body')) }),
        };

        await expect(kick.onFetchResponse(response)).resolves.toBeUndefined();
        expect(kick.recorder.record).toHaveBeenCalledWith(
            'fetch_response', expect.anything(), 'error', null, 'bad body'
        );
    });
});

describe('Kick fetchChatHistory', () => {
    it('replays history oldest-first', async () => {
        const kick = makeSpyKick();
        const info = { id: 42, chatroom: { id: 7 }, livestream: null };
        const history = {
            data: {
                messages: [
                    { id: '11111111-1111-4111-8111-111111111111', content: 'newest' },
                    { id: '22222222-2222-4222-8222-222222222222', content: 'oldest' },
                ],
            },
        };

        vi.stubGlobal('fetch', vi.fn(url => Promise.resolve({
            json: () => Promise.resolve(url.includes('/messages') ? history : info),
        })));

        await kick.fetchChatHistory();

        const [[messages]] = kick.sendChatMessages.mock.calls;
        expect(messages.map(m => m.message)).toEqual(['oldest', 'newest']);
        vi.unstubAllGlobals();
    });

    it('swallows network failures', async () => {
        const kick = makeSpyKick();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

        await expect(kick.fetchChatHistory()).resolves.toBeUndefined();
        expect(kick.sendChatMessages).not.toHaveBeenCalled();
        expect(kick.error).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('Fuzzing: Kick robustness', () => {
    let kick;

    beforeEach(() => {
        kick = makeSpyKick();
    });

    it('normalizeFrame never throws on arbitrary strings', () => {
        fc.assert(
            fc.property(fc.string(), (raw) => {
                const frames = Kick.normalizeFrame(raw);
                return Array.isArray(frames) && frames.every(f => ['event', 'ignored', 'unhandled'].includes(f.kind));
            }),
            { numRuns: 300 }
        );
    });

    it('normalizeFrame never throws on arbitrary JSON', () => {
        fc.assert(
            fc.property(fc.jsonValue(), (value) => {
                Kick.normalizeFrame(JSON.stringify(value));
                return true;
            }),
            { numRuns: 300 }
        );
    });

    it('normalizeFrame never throws on arbitrary values', () => {
        fc.assert(
            fc.property(fc.anything(), (value) => {
                Kick.normalizeFrame(value);
                return true;
            }),
            { numRuns: 200 }
        );
    });

    /** Every message that reaches the backend must carry a UUID id. */
    const allSentIdsAreUuids = k => k.sendChatMessages.mock.calls.every(
        ([messages]) => (Array.isArray(messages) ? messages : [messages]).every(m => UUID_RE.test(m.id))
    );

    it('the full websocket path never throws on arbitrary strings', () => {
        fc.assert(
            fc.property(fc.string(), (raw) => {
                feed(kick, raw);
                return allSentIdsAreUuids(kick);
            }),
            { numRuns: 300 }
        );
    });

    it('the full websocket path never throws on arbitrary JSON', () => {
        fc.assert(
            fc.property(fc.jsonValue(), (value) => {
                feed(kick, JSON.stringify(value));
                return allSentIdsAreUuids(kick);
            }),
            { numRuns: 300 }
        );
    });

    it('the full websocket path survives arbitrary event payloads', () => {
        const events = [
            'App\\Events\\ChatMessageEvent',
            'App\\Events\\MessageDeletedEvent',
            'App\\Events\\SubscriptionEvent',
            'GiftedSubscriptionsEvent',
            'SubscriptionGifted',
            'KicksGifted',
            'App\\Events\\LivestreamUpdated',
        ];

        fc.assert(
            fc.property(fc.constantFrom(...events), fc.jsonValue(), (event, data) => {
                feed(kick, JSON.stringify({
                    push: { channel: 'chatrooms.1.v2', pub: { data: { event, data: JSON.stringify(data) } } },
                }));
                return allSentIdsAreUuids(kick);
            }),
            { numRuns: 300 }
        );
    });

    it('handleEvent never throws on arbitrary event names and payloads', () => {
        fc.assert(
            fc.property(fc.string(), fc.jsonValue(), (event, data) => {
                const outcome = kick.handleEvent('chatrooms.1.v2', event, data);
                return ['handled', 'ignored', 'unhandled'].includes(outcome.status);
            }),
            { numRuns: 200 }
        );
    });

    it('prepareChatMessage survives malformed message data', () => {
        fc.assert(
            fc.property(
                fc.record({
                    id: fc.oneof(fc.string(), fc.constant(undefined)),
                    content: fc.oneof(fc.string(), fc.constant(undefined)),
                    type: fc.oneof(fc.constantFrom('message', 'reply', 'celebration'), fc.constant(undefined)),
                    created_at: fc.oneof(fc.string(), fc.constant(undefined)),
                    metadata: fc.oneof(fc.jsonValue(), fc.constant(undefined)),
                    sender: fc.oneof(
                        fc.record({
                            username: fc.oneof(fc.string(), fc.constant(undefined)),
                            identity: fc.oneof(
                                fc.record({ badges: fc.oneof(fc.array(fc.record({ type: fc.string() })), fc.constant(undefined)) }),
                                fc.constant(undefined)
                            ),
                        }),
                        fc.constant(undefined)
                    ),
                    gift: fc.oneof(fc.record({ amount: fc.oneof(fc.integer(), fc.constant(undefined)) }), fc.constant(undefined)),
                }),
                (data) => {
                    const message = makeKick().prepareChatMessage(data);
                    return UUID_RE.test(message.id);
                }
            ),
            { numRuns: 200 }
        );
    });

    it('prepareKicksGiftedMessage survives mutated gift payloads', () => {
        const base = JSON.parse(kickEvents.realKicksGifted.data);

        fc.assert(
            fc.property(
                fc.record({
                    gift_id: fc.string(),
                    name: fc.string(),
                    amount: fc.integer(),
                    type: fc.constantFrom('BASIC', 'LEVEL_UP', 'PREMIUM'),
                    tier: fc.constantFrom('BASIC', 'MID', 'HIGH'),
                }),
                (gift) => {
                    const message = makeKick().prepareKicksGiftedMessage({ ...base, gift });
                    return UUID_RE.test(message.id);
                }
            ),
            { numRuns: 100 }
        );
    });
});
