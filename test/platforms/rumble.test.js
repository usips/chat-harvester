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
const { uuidv5 } = await import('../../src/core/uuid.js');

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
    describe('Emote extraction', () => {
        let rumble;

        // Shape of the real page: the payload is an argument to a minified
        // RumbleChat() call, so parentheses surround it on both sides.
        const payload = 'RumbleChat("https://web7.rumble.com/chat/api",\n'
            + '\t{items:[{id:79764180,title:"Mad at the Internet Emotes",channel_id:1978152,emotes:['
            + '{name:"hamroll",is_subs_only:false,position:4,file:"https://hugh.cdn.rumble.cloud/video/z12/w/F/s/W/wFsWe.baa.gif"},'
            + '{name:"hamjam",is_subs_only:false,position:6,file:"https://hugh.cdn.rumble.cloud/video/z12/J/D/m/8/JDm8m.baa.gif"}'
            + ']},{id:1881816,title:"Rumble Emotes",channel_id:null,emotes:['
            + '{name:"r+pugdance",is_subs_only:false,position:0,file:"https://hugh.cdn.rumble.cloud/video/z12/S/1/x/Y/S1xYQ.baa.gif"}'
            + ']}]},\n\t0,\n);';

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.emotes = {};
            rumble.log = vi.fn();
            rumble._debug = vi.fn();
        });

        const stubScripts = (...bodies) => {
            document.querySelectorAll = vi.fn(() => bodies.map((textContent) => ({ textContent })));
        };

        it('extracts every emote pack from the payload', () => {
            const items = Rumble.extractEmoteItems(payload);

            expect(items).toHaveLength(2);
            expect(items[1].emotes[0].name).toBe('r+pugdance');
        });

        it('returns null for a script without an emote payload', () => {
            expect(Rumble.extractEmoteItems('(function (w, d) { w.rumblePodscribe = {e:"73c4"}; })')).toBeNull();
        });

        it('ignores an items payload that carries no emotes', () => {
            expect(Rumble.extractEmoteItems('f({items:[{id:1,title:"Playlist"}]})')).toBeNull();
        });

        it('loads emotes from a later inline script', () => {
            // Regression: fetchEmotes only read the first inline script in the
            // body, which on a live page is an unrelated analytics snippet.
            stubScripts('(function (w, d) { w.rumblePodscribe = {e:"73c4"}; })(window, document);', payload);

            rumble.fetchEmotes();

            expect(rumble.emotes.hamroll).toBe('https://hugh.cdn.rumble.cloud/video/z12/w/F/s/W/wFsWe.baa.gif');
            expect(rumble.emotes.hamjam).toBeDefined();
            expect(rumble.emotes['r+pugdance']).toBeDefined();
        });

        it('replaces emote codes in a message once emotes are loaded', async () => {
            stubScripts(payload);
            rumble.fetchEmotes();

            rumble.platform = 'Rumble';
            rumble.channel = 1978152;
            rumble.namespace = Rumble.namespace;

            const messages = await rumble.prepareChatMessages(
                [{ id: '1', user_id: '2', text: 'nice :hamroll: :r+pugdance: :nothere:', time: '2026-10-02T12:00:00+00:00' }],
                [{ id: '2', username: 'tester' }]
            );

            expect(messages[0].emojis).toEqual([
                [':hamroll:', 'https://hugh.cdn.rumble.cloud/video/z12/w/F/s/W/wFsWe.baa.gif', ':hamroll:'],
                [':r+pugdance:', 'https://hugh.cdn.rumble.cloud/video/z12/S/1/x/Y/S1xYQ.baa.gif', ':r+pugdance:']
            ]);
            expect(rumble.log).toHaveBeenCalledWith('no emote for nothere');
        });

        it('does not log emotes when none are found', () => {
            stubScripts('var x = 1;');

            rumble.fetchEmotes();

            expect(rumble.emotes).toEqual({});
            expect(rumble._debug).toHaveBeenCalledWith('No emotes found on the page.');
        });
    });
    describe('Fetch responses', () => {
        let rumble;

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.emotes = {};
            rumble.log = vi.fn();
            rumble.recordFetchHandled = vi.fn();
            rumble.recordFetchIgnored = vi.fn();
            rumble.recorder = { record: vi.fn() };
        });

        it('ignores opaque responses without logging an error', async () => {
            // Opaque (no-cors) responses report an empty url.
            await rumble.onFetchResponse({ url: '', status: 0, clone: vi.fn() });

            expect(rumble.log).not.toHaveBeenCalled();
            expect(rumble.recorder.record).not.toHaveBeenCalled();
            expect(rumble.recordFetchIgnored).toHaveBeenCalledWith('', 'GET', 0, 'Response has no URL');
        });

        it('collects emotes from the emote list', async () => {
            const json = { data: { items: [{ emotes: [{ name: ':pop:', file: 'https://rumble.com/pop.png' }] }] } };
            const response = {
                url: 'https://rumble.com/service.php?name=emote.list',
                status: 200,
                clone: () => ({ json: () => Promise.resolve(json) })
            };

            await rumble.onFetchResponse(response);

            expect(rumble.emotes[':pop:']).toBe('https://rumble.com/pop.png');
            expect(rumble.recordFetchHandled).toHaveBeenCalledWith(response.url, 'GET', 200, json, { emoteCount: 1 });
        });
    });

    describe('Viewer counts', () => {
        // Captured from wn0.rumble.com during the audit.
        const watchingNow = {
            data: {
                video_id: 443918684,
                num_watching_now: 5997,
                viewer_count: 5997,
                livestream_status: 2,
                scheduled_on_ts: null,
                ls_streamed_on_ts: 1787332435,
                ls_first_heartbeat_ts: 1787332434
            }
        };

        let rumble;

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.platform = 'Rumble';
            rumble.channel = '443918684';
            rumble.viewers = null;
            rumble.log = vi.fn();
            rumble.error = vi.fn();
            rumble.recordFetchHandled = vi.fn();
            rumble.recordFetchIgnored = vi.fn();
            rumble.recorder = { record: vi.fn() };
            rumble.sendViewerCount = vi.fn(function (count) { this.viewers = count; });
        });

        it('polls on a one minute interval', async () => {
            const { VIEWER_POLL_MS } = await import('../../src/platforms/rumble.js');
            expect(VIEWER_POLL_MS).toBe(60_000);
        });

        it('sends the count from a watching-now answer', () => {
            expect(rumble.receiveWatchingNow(watchingNow)).toBe(5997);
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(5997);
        });

        it('falls back to num_watching_now and accepts numeric strings', () => {
            rumble.receiveWatchingNow({ data: { num_watching_now: '42', livestream_status: 2 } });
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(42);
        });

        it('keeps a zero viewer_count instead of falling through', () => {
            // Regression: `viewer_count || num_watching_now` skipped a real 0.
            rumble.receiveWatchingNow({ data: { viewer_count: 0, num_watching_now: 12, livestream_status: 2 } });
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(0);
        });

        it('sends 0 once when the video is not live', () => {
            rumble.viewers = 5997;
            const ended = { data: { ...watchingNow.data, livestream_status: 3 } };

            expect(rumble.receiveWatchingNow(ended)).toBe(0);
            expect(rumble.receiveWatchingNow(ended)).toBe(0);
            expect(rumble.sendViewerCount).toHaveBeenCalledTimes(1);
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(0);
        });

        it('ignores answers about another video', () => {
            rumble.channel = '1';
            expect(rumble.receiveWatchingNow(watchingNow)).toBeNull();
            expect(rumble.sendViewerCount).not.toHaveBeenCalled();
        });

        it('ignores answers without data', () => {
            expect(rumble.receiveWatchingNow({})).toBeNull();
            expect(rumble.receiveWatchingNow(null)).toBeNull();
            expect(rumble.receiveWatchingNow({ data: { livestream_status: 2 } })).toBeNull();
            expect(rumble.sendViewerCount).not.toHaveBeenCalled();
        });

        it('polls watching-now through the unpatched fetch with credentials', async () => {
            const oldFetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(watchingNow) }));
            window.fetch.oldFetch = oldFetch;
            try {
                await rumble.pollViewers();
            } finally {
                delete window.fetch.oldFetch;
            }

            expect(oldFetch).toHaveBeenCalledWith(
                'https://wn0.rumble.com/service.php?name=video.watching-now&video_id=443918684',
                { credentials: 'include' }
            );
            expect(window.fetch).not.toHaveBeenCalled();
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(5997);
        });

        it('does not poll before the video id is known', async () => {
            rumble.channel = null;
            const oldFetch = vi.fn();
            window.fetch.oldFetch = oldFetch;
            try {
                await rumble.pollViewers();
            } finally {
                delete window.fetch.oldFetch;
            }
            expect(oldFetch).not.toHaveBeenCalled();
        });

        it('logs a failed poll instead of throwing', async () => {
            window.fetch.oldFetch = vi.fn(() => Promise.reject(new Error('offline')));
            try {
                await rumble.pollViewers();
            } finally {
                delete window.fetch.oldFetch;
            }
            expect(rumble.error).toHaveBeenCalled();
            expect(rumble.sendViewerCount).not.toHaveBeenCalled();
        });

        it('reads the page XHR whatever its responseType', () => {
            const done = { readyState: 4 };

            rumble.onXhrServiceReadyStateChange({ ...done, responseType: 'json', response: watchingNow });
            rumble.onXhrServiceReadyStateChange({ ...done, responseType: '', responseText: JSON.stringify(watchingNow) });
            rumble.onXhrServiceReadyStateChange({ ...done, responseType: 'text', responseText: 'not json' });
            rumble.onXhrServiceReadyStateChange({ readyState: 3, responseType: 'json', response: watchingNow });

            expect(rumble.sendViewerCount).toHaveBeenCalledTimes(2);
        });

        it('hooks only the watching-now service XHR', () => {
            const xhr = { addEventListener: vi.fn() };
            rumble.onXhrOpen(xhr, 'GET', 'https://wn0.rumble.com/service.php?name=video.watching-now&video_id=443918684');
            rumble.onXhrOpen(xhr, 'GET', 'https://wn0.rumble.com/service.php?name=user.get');
            expect(xhr.addEventListener).toHaveBeenCalledTimes(1);
        });

        it('reads a watching-now fetch response', async () => {
            const response = {
                url: 'https://wn0.rumble.com/service.php?name=video.watching-now&video_id=443918684',
                status: 200,
                clone: () => ({ json: () => Promise.resolve(watchingNow) })
            };
            await rumble.onFetchResponse(response);
            expect(rumble.sendViewerCount).toHaveBeenCalledWith(5997);
            expect(rumble.recordFetchHandled).toHaveBeenCalledWith(response.url, 'GET', 200, watchingNow, { viewers: 5997 });
        });
    });

    describe('Deletions and mutes', () => {
        let rumble;
        const es = { url: 'https://web7.rumble.com/chat/api/chat/450251162/stream' };
        const frame = (json) => ({ data: JSON.stringify(json) });

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.platform = 'Rumble';
            rumble.channel = '443918684';
            rumble.namespace = Rumble.namespace;
            rumble.emotes = {};
            rumble.log = vi.fn();
            rumble._debug = vi.fn();
            rumble.recorder = { recordEventSource: vi.fn() };
            rumble.sendChatMessages = vi.fn();
            rumble.receiveSubscriptions = vi.fn();
            rumble.sendRemoveMessages = vi.fn();
        });

        const chat = (id, userId) => ({ id, user_id: userId, text: `hi ${id}`, time: '2026-11-12T19:10:25+00:00', type: 'regular' });

        it('removes deleted messages by their uuid', () => {
            rumble.onEventSourceMessage(es, frame({ type: 'delete_messages', data: { message_ids: ['2830115483605692472'] } }));

            expect(rumble.sendRemoveMessages).toHaveBeenCalledWith([uuidv5('2830115483605692472', Rumble.namespace)]);
            expect(rumble.recorder.recordEventSource).toHaveBeenCalledWith(
                es.url, expect.any(String), 'handled', expect.anything(), 'delete_messages'
            );
        });

        it('removes every message a muted user sent', () => {
            rumble.onEventSourceMessage(es, frame({
                type: 'messages',
                data: {
                    messages: [chat('1', '286098814'), chat('2', '7'), chat('3', '286098814')],
                    users: [{ id: '286098814', username: 'muted' }, { id: '7', username: 'other' }],
                    channels: []
                }
            }));

            // Captured live: user ids arrive as numbers here, strings in messages.
            rumble.onEventSourceMessage(es, frame({ type: 'mute_users', data: { user_ids: [286098814] } }));

            expect(rumble.sendRemoveMessages).toHaveBeenCalledWith([
                uuidv5('1', Rumble.namespace),
                uuidv5('3', Rumble.namespace)
            ]);
        });

        it('sends nothing when a muted user has no known messages', () => {
            rumble.onEventSourceMessage(es, frame({ type: 'mute_users', data: { user_ids: [1] } }));
            expect(rumble.sendRemoveMessages).not.toHaveBeenCalled();
        });

        it('does not track the same message twice', () => {
            rumble.rememberSentMessages([chat('1', '5')]);
            rumble.rememberSentMessages([chat('1', '5')]);
            rumble.receiveMutedUsers(['5']);
            expect(rumble.sendRemoveMessages).toHaveBeenCalledWith([uuidv5('1', Rumble.namespace)]);
        });

        it('bounds the ids kept per user', () => {
            rumble.rememberSentMessages(Array.from({ length: 250 }, (_, i) => chat(String(i), '5')));
            expect(rumble.receiveMutedUsers(['5'])).toHaveLength(200);
        });

        it('records pin frames as ignored', () => {
            rumble.onEventSourceMessage(es, frame({ type: 'pin_message', data: {} }));
            expect(rumble.recorder.recordEventSource).toHaveBeenCalledWith(
                es.url, expect.any(String), 'ignored', null, 'pin_message', expect.any(String)
            );
        });
    });

    describe('Channel personas', () => {
        let rumble;

        beforeEach(() => {
            rumble = Object.create(Rumble.prototype);
            rumble.platform = 'Rumble';
            rumble.channel = '443918684';
            rumble.namespace = Rumble.namespace;
            rumble.emotes = {};
            rumble.log = vi.fn();
        });

        // Shape from the audit: Rumble shows channel "Orlaghs" for account "OrlynDp".
        const users = [{
            id: '286098814', username: 'OrlynDp', link: '/user/OrlynDp',
            'image.1': 'https://hugh.cdn.rumble.cloud/user.jpeg', badges: ['verified']
        }];
        const channels = [{
            id: '7984292', username: 'Orlaghs', link: '/c/Orlaghs',
            'image.1': 'https://hugh.cdn.rumble.cloud/channel.png'
        }];
        const message = (extra) => ({
            id: '2830115483605692472', user_id: '286098814', text: 'hello',
            time: '2026-11-12T19:10:25+00:00', type: 'regular', ...extra
        });

        it('shows the channel a message was posted as', async () => {
            const [out] = await rumble.prepareChatMessages([message({ channel_id: 7984292 })], users, channels);

            expect(out.username).toBe('Orlaghs');
            expect(out.avatar).toBe('https://hugh.cdn.rumble.cloud/channel.png');
            expect(out.is_verified).toBe(true); // badges stay with the account
        });

        it('shows the account when no channel is set', async () => {
            const [out] = await rumble.prepareChatMessages([message({})], users, channels);
            expect(out.username).toBe('OrlynDp');
            expect(out.avatar).toBe('https://hugh.cdn.rumble.cloud/user.jpeg');
        });

        it('falls back to the account when the channel is missing', async () => {
            const [out] = await rumble.prepareChatMessages([message({ channel_id: '1' })], users, []);
            expect(out.username).toBe('OrlynDp');
        });

        it('matches user ids of either type', async () => {
            const [out] = await rumble.prepareChatMessages([message({ user_id: 286098814 })], users);
            expect(out?.username).toBe('OrlynDp');
        });

        it('names a gift buyer by channel too', async () => {
            const gift = message({ text: '', channel_id: '7984292', gift_purchase_notification: { total_gifts: 2 } });
            const [sub] = await rumble.prepareSubscriptions([gift], users, channels);
            expect(sub.buyer).toBe('Orlaghs');
        });

        it('passes channels from a messages frame through', () => {
            rumble.receiveChatPairs = vi.fn();
            rumble.recorder = { recordEventSource: vi.fn() };
            const data = { messages: [message({ channel_id: '7984292' })], users, channels };
            rumble.onEventSourceMessage({ url: '' }, { data: JSON.stringify({ type: 'messages', data }) });
            expect(rumble.receiveChatPairs).toHaveBeenCalledWith(data.messages, users, channels);
        });
    });

    describe('Channel detection', () => {
        it('reads the video id from a pop-out chat path', () => {
            expect(Rumble.popupVideoId('/chat/popup/443918684')).toBe('443918684');
            expect(Rumble.popupVideoId('/chat/popup/443918684/')).toBe('443918684');
        });

        it('returns null rather than "NaN" for a malformed pop-out path', () => {
            expect(Rumble.popupVideoId('/chat/popup/')).toBeNull();
            expect(Rumble.popupVideoId('/chat/popup/abc')).toBeNull();
        });
    });
});
