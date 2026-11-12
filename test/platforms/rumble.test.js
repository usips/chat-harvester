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
});
