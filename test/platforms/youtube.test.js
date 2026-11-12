/**
 * CHUCK - YouTube Platform Tests
 * Tests for YouTube message parsing and injection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import youtubeEvents from '../fixtures/youtube-events.json';

// Mock DOM elements
const createMockElement = (tag) => {
    const children = [];
    return {
        tagName: tag,
        className: '',
        id: '',
        innerHTML: '',
        textContent: '',
        style: {},
        children,
        childNodes: children,
        setAttribute: vi.fn(),
        getAttribute: vi.fn(),
        appendChild: vi.fn((child) => {
            children.push(child);
            return child;
        }),
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
};

const mockChatContainer = createMockElement('div');
mockChatContainer.id = 'items';

const mockScroller = createMockElement('div');
mockScroller.id = 'item-scroller';
mockScroller.scrollHeight = 1000;
mockScroller.scrollTop = 900;
mockScroller.clientHeight = 100;

// Mock browser globals before importing YouTube
vi.stubGlobal('window', {
    location: { href: 'https://www.youtube.com/watch?v=test123' },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class {
            addEventListener() {}
            send() {}
        };
        readyState = 1;
        addEventListener() {}
        send = vi.fn();
    },
    fetch: vi.fn(() => Promise.resolve({
        json: () => Promise.resolve({ author_url: 'https://www.youtube.com/@TestChannel' })
    })),
    EventSource: class MockEventSource {
        addEventListener() {}
    },
    XMLHttpRequest: class MockXHR {
        prototype = { open: vi.fn(), send: vi.fn() };
    },
    ytInitialData: {},
});

const mockHead = createMockElement('head');

vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    createElement: vi.fn((tag) => createMockElement(tag)),
    head: mockHead,
    querySelector: vi.fn((selector) => {
        if (selector === 'yt-live-chat-item-list-renderer #items') {
            return mockChatContainer;
        }
        if (selector === 'yt-live-chat-item-list-renderer #item-scroller') {
            return mockScroller;
        }
        return null;
    }),
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { YouTube } = await import('../../src/platforms/youtube.js');
const { liveStateFromPlayerResponse, viewerCountFromRenderer, viewerCountFromEntity } = await import('../../src/platforms/youtube.js');

// Verbatim updateViewershipAction payloads from youtubei/v1/updated_metadata, 2026-09-11.
// QZucLvN3IDs was live; Mxc4L0fgw0s is a regular video.
const LIVE_METADATA = { actions: [
    { updateViewershipAction: { viewCount: { videoViewCountRenderer: {
        viewCount: { simpleText: '16,037 watching now' }, isLive: true,
        extraShortViewCount: { accessibility: { accessibilityData: { label: '16K' } }, simpleText: '16K' },
        unlabeledViewCountValue: { simpleText: '16,037' }, originalViewCount: '16037',
    } } } },
    { updateDateTextAction: {} },
] };
const VIDEO_METADATA = { actions: [
    { updateViewershipAction: { viewCount: { videoViewCountRenderer: {
        viewCount: { simpleText: '124 views' }, extraShortViewCount: { simpleText: '124' },
        unlabeledViewCountValue: { simpleText: '124' }, viewCountLabel: { simpleText: 'Views' }, originalViewCount: '124',
    } } } },
    { updateDateTextAction: {} },
] };
// Trimmed ytInitialPlayerResponse fields from the same two watch pages.
const LIVE_PLAYER = { videoDetails: { isLive: true, isLiveContent: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-09-11T10:04:42+00:00' } } } };
const VIDEO_PLAYER = { videoDetails: { isLiveContent: false }, microformat: { playerMicroformatRenderer: {} } };
const ENDED_PLAYER = { videoDetails: { isLiveContent: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, startTimestamp: '2026-09-10T10:00:00+00:00', endTimestamp: '2026-09-10T12:00:00+00:00' } } } };

describe('YouTube live viewer counts', () => {
    const metadataResponse = body => ({
        url: 'https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false',
        status: 200,
        json: () => Promise.resolve(body),
    });
    const makeYt = (liveState = null) => {
        const yt = Object.create(YouTube.prototype);
        Object.assign(yt, {
            platform: 'YouTube', channel: 'TestChannel', namespace: YouTube.namespace, liveState,
            log: vi.fn(), warn: vi.fn(), error: vi.fn(), _debug: vi.fn(),
            sendViewerCount: vi.fn(), recordFetchHandled: vi.fn(), recordFetchIgnored: vi.fn(),
            recorder: { record: vi.fn() },
        });
        return yt;
    };

    it('reads live state from the player response', () => {
        expect(liveStateFromPlayerResponse(LIVE_PLAYER)).toBe(true);
        expect(liveStateFromPlayerResponse(VIDEO_PLAYER)).toBe(false);
        expect(liveStateFromPlayerResponse(ENDED_PLAYER)).toBe(false);
        expect(liveStateFromPlayerResponse(undefined)).toBeNull();
    });

    it('reads counts from every view-count shape', () => {
        expect(viewerCountFromRenderer({ originalViewCount: '16037', viewCount: { simpleText: '16,037 watching now' } })).toBe(16037);
        expect(viewerCountFromRenderer({ viewCount: { runs: [{ text: '16,037' }, { text: ' watching now' }] } })).toBe(16037);
        expect(viewerCountFromRenderer({ viewCount: { simpleText: 'No views' } })).toBeNull();
        expect(viewerCountFromRenderer({})).toBeNull();
    });

    it('reports viewers from a live stream\'s metadata poll', async () => {
        const yt = makeYt();
        await yt.onFetchResponse(metadataResponse(LIVE_METADATA));

        expect(yt.sendViewerCount).toHaveBeenCalledWith(16037);
        expect(yt.liveState).toBe(true);
    });

    it('does not report a video\'s views as viewers', async () => {
        const yt = makeYt();
        await yt.onFetchResponse(metadataResponse(VIDEO_METADATA));

        expect(yt.sendViewerCount).not.toHaveBeenCalled();
        expect(yt.liveState).toBe(false);
        expect(yt.recordFetchHandled).toHaveBeenCalledWith(
            expect.any(String), 'POST', 200, VIDEO_METADATA, { actionCount: 2, live: false, viewerCount: null }
        );
    });

    it('clears the viewer count once when a live stream ends', async () => {
        const yt = makeYt();
        await yt.onFetchResponse(metadataResponse(LIVE_METADATA));
        await yt.onFetchResponse(metadataResponse(VIDEO_METADATA));
        await yt.onFetchResponse(metadataResponse(VIDEO_METADATA));

        expect(yt.sendViewerCount.mock.calls).toEqual([[16037], [0]]);
        expect(yt.liveState).toBe(false);
    });

    it('only clears the count on unload from a live tab', () => {
        const video = makeYt(false);
        video.onBeforeUnload({});
        expect(video.sendViewerCount).not.toHaveBeenCalled();

        const unknown = makeYt(null);
        unknown.onBeforeUnload({});
        expect(unknown.sendViewerCount).not.toHaveBeenCalled();

        const live = makeYt(true);
        live.onBeforeUnload({});
        expect(live.sendViewerCount).toHaveBeenCalledWith(0);
    });

    // The page's #view-count element as a MutationRecord target.
    const labelMutations = (text, times = 1) => {
        const target = { getAttribute: name => (name === 'aria-label' ? text : null) };
        return Array.from({ length: times }, () => ({ type: 'attributes', target }));
    };
    // Tracks sends the way Seed.sendViewerCount does.
    const trackViewers = yt => {
        yt.sendViewerCount = vi.fn(count => { yt.viewers = count; });
        return yt;
    };

    it('ignores the page\'s view counter unless live', () => {
        const video = makeYt(false);
        video.onViewCountChange(labelMutations('124 views'), null);
        expect(video.sendViewerCount).not.toHaveBeenCalled();

        const live = makeYt(true);
        live.onViewCountChange(labelMutations('16,037 watching now'), null);
        expect(live.sendViewerCount).toHaveBeenCalledWith(16037);
    });

    it('sends the page\'s view counter once per change', () => {
        const yt = trackViewers(makeYt(true));
        // YouTube sets the aria-label 8 times for one change.
        yt.onViewCountChange(labelMutations('45,479 watching now', 8), null);
        yt.onViewCountChange(labelMutations('45,479 watching now', 8), null);
        yt.onViewCountChange(labelMutations('45,480 watching now', 8), null);

        expect(yt.sendViewerCount.mock.calls).toEqual([[45479], [45480]]);
    });

    // updated_metadata as of 2026-11: no updateViewershipAction, the count lives in
    // frameworkUpdates' viewCountEntity, which carries no isLive.
    const ENTITY_METADATA = {
        actions: [{ updateDateTextAction: {} }],
        frameworkUpdates: { entityBatchUpdate: { mutations: [
            { entityKey: 'other', type: 'ENTITY_MUTATION_TYPE_REPLACE', payload: { likeCountEntity: {} } },
            { entityKey: 'Egt2aWV3Q291bnQ', type: 'ENTITY_MUTATION_TYPE_REPLACE', payload: { viewCountEntity: {
                viewCount: { simpleText: '45,479 watching now' }, extraShortViewCount: { simpleText: '45K' },
                unlabeledViewCountValue: { simpleText: '45,479' }, viewCountNumber: '45479',
            } } },
        ] } },
    };

    it('reads viewers from viewCountEntity on a live page', async () => {
        const yt = makeYt(true);
        await yt.onFetchResponse(metadataResponse(ENTITY_METADATA));
        await yt.onFetchResponse(metadataResponse(ENTITY_METADATA));

        // Every poll is sent: it is the heartbeat that keeps SNEED's entry fresh.
        expect(yt.sendViewerCount.mock.calls).toEqual([[45479], [45479]]);
        expect(yt.liveState).toBe(true);
    });

    it('ignores viewCountEntity unless the page is known live', async () => {
        for (const state of [null, false]) {
            const yt = makeYt(state);
            await yt.onFetchResponse(metadataResponse(ENTITY_METADATA));
            expect(yt.sendViewerCount).not.toHaveBeenCalled();
            expect(yt.liveState).toBe(state);
        }
    });

    it('falls back to the unlabeled count in viewCountEntity', () => {
        expect(viewerCountFromEntity({ unlabeledViewCountValue: { simpleText: '45,479' } })).toBe(45479);
        expect(viewerCountFromEntity({ viewCountNumber: '12' })).toBe(12);
        expect(viewerCountFromEntity({})).toBeNull();
    });

    it('observes the view counter even when the channel lookup fails', async () => {
        const yt = makeYt();
        yt.ensureViewCountObserver = vi.fn();
        yt.setChannel = vi.fn(channel => { yt.channel = channel; });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
        window.ytInitialPlayerResponse = LIVE_PLAYER;
        try {
            await yt.onDocumentReady({});
        } finally {
            globalThis.fetch = originalFetch;
            delete window.ytInitialPlayerResponse;
        }

        expect(yt.ensureViewCountObserver).toHaveBeenCalled();
        expect(yt.liveState).toBe(true);
        expect(yt.setChannel).toHaveBeenCalledWith('test123');
    });

    describe('SPA navigation', () => {
        const navigate = (href, playerResponse) => {
            window.location.href = href;
            return { detail: { pageType: 'watch', response: playerResponse ? { playerResponse } : {} } };
        };
        const oembed = handles => vi.fn(url => {
            const id = new URL(url).searchParams.get('url').split('v=')[1];
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ author_url: `https://www.youtube.com/@${handles[id]}` }) });
        });
        let originalFetch;
        let originalHref;
        beforeEach(() => {
            originalFetch = globalThis.fetch;
            originalHref = window.location.href;
        });
        afterEach(() => {
            globalThis.fetch = originalFetch;
            window.location.href = originalHref;
        });

        // Pat McAfee live → NBC News live: the old channel gets 0, the new one its own count.
        const makeNavYt = () => {
            const yt = trackViewers(makeYt(true));
            Object.assign(yt, { videoId: 'patLive', channel: 'ThePatMcAfeeShow', viewers: 12000 });
            yt.ensureViewCountObserver = vi.fn();
            yt.sendViewerCount = vi.fn(count => { yt.viewers = count; yt.sent.push([yt.channel, count]); });
            yt.sent = [];
            yt.setChannel = vi.fn(channel => { yt.channel = channel; });
            return yt;
        };

        it('clears the old live video under its own channel and switches channel', async () => {
            const yt = makeNavYt();
            globalThis.fetch = oembed({ nbcLive: 'NBCNews' });
            const LIVE_NBC = { ...LIVE_PLAYER, videoDetails: { ...LIVE_PLAYER.videoDetails, videoId: 'nbcLive' } };
            const pending = yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=nbcLive', LIVE_NBC));

            // While the channel resolves, nothing may be attributed to the old one.
            expect(yt.channel).toBeNull();
            await pending;

            expect(yt.sent).toEqual([['ThePatMcAfeeShow', 0]]);
            expect(yt.channel).toBe('NBCNews');
            expect(yt.videoId).toBe('nbcLive');
            expect(yt.liveState).toBe(true);
            expect(yt.viewers).toBeNull();
            expect(yt.ensureViewCountObserver).toHaveBeenCalled();

            yt.onViewCountChange(labelMutations('3,881 watching now'), null);
            expect(yt.sent.at(-1)).toEqual(['NBCNews', 3881]);
        });

        it('does not report a VOD reached by navigation', async () => {
            const yt = makeNavYt();
            globalThis.fetch = oembed({ patVod: 'ThePatMcAfeeShow' });
            await yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=patVod',
                { ...VIDEO_PLAYER, videoDetails: { ...VIDEO_PLAYER.videoDetails, videoId: 'patVod' } }));

            expect(yt.liveState).toBe(false);
            yt.onViewCountChange(labelMutations('1,234,567 views'), null);
            expect(yt.sent).toEqual([['ThePatMcAfeeShow', 0]]);
        });

        it('falls back to #movie_player and ignores a stale player response', async () => {
            const yt = makeNavYt();
            globalThis.fetch = oembed({ nbcLive: 'NBCNews' });
            const spy = vi.spyOn(document, 'querySelector');
            spy.mockImplementation(sel => (sel === '#movie_player'
                ? { getPlayerResponse: () => ({ ...LIVE_PLAYER, videoDetails: { isLive: true, videoId: 'patLive' } }) }
                : null));
            try {
                await yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=nbcLive', null));
            } finally {
                spy.mockRestore();
            }
            // The player still described the old video, so the new one's state is unknown.
            expect(yt.liveState).toBeNull();
            expect(yt.channel).toBe('NBCNews');
        });

        it('sends nothing on pages without a video', async () => {
            const yt = makeNavYt();
            await yt.onNavigateFinish(navigate('https://www.youtube.com/results?search_query=news', null));

            expect(yt.sent).toEqual([['ThePatMcAfeeShow', 0]]);
            expect(yt.liveState).toBe(false);
            expect(yt.videoId).toBeNull();
            yt.onBeforeUnload({});
            expect(yt.sent).toHaveLength(1);
        });

        it('ignores a navigation event for the same video', async () => {
            const yt = makeNavYt();
            globalThis.fetch = vi.fn();
            await yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=patLive', LIVE_PLAYER));

            expect(yt.sent).toEqual([]);
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(yt.channel).toBe('ThePatMcAfeeShow');
        });

        it('drops a channel lookup that finishes after the next navigation', async () => {
            const yt = makeNavYt();
            let resolveSlow;
            globalThis.fetch = vi.fn(url => (url.includes('slowLive')
                ? new Promise(r => { resolveSlow = r; })
                : oembed({ nbcLive: 'NBCNews' })(url)));

            const first = yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=slowLive', null));
            await yt.onNavigateFinish(navigate('https://www.youtube.com/watch?v=nbcLive', null));
            resolveSlow({ ok: true, json: () => Promise.resolve({ author_url: 'https://www.youtube.com/@Slow' }) });
            await first;

            expect(yt.channel).toBe('NBCNews');
        });
    });

    it('does not flip to not-live on a page with no player data', () => {
        const yt = makeYt(true);
        yt.setLiveState(liveStateFromPlayerResponse(undefined), 'page');
        expect(yt.liveState).toBe(true);
        expect(yt.sendViewerCount).not.toHaveBeenCalled();
    });
});

describe('YouTube Platform', () => {
    describe('prepareChatMessages', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should parse a standard text message', async () => {
            const action = youtubeEvents.liveChatTextMessage.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toBeInstanceOf(ChatMessage);
            expect(messages[0].username).toBe('@TestUser');
            expect(messages[0].message).toBe('Hello world!');
        });

        it('should parse a paid message (SuperChat)', async () => {
            const action = youtubeEvents.liveChatPaidMessage.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].username).toBe('@SuperChatter');
            expect(messages[0].message).toBe('Thanks for the stream!');
            expect(messages[0].amount).toBe(5);
            expect(messages[0].currency).toBe('USD');
        });

        it.each([
            ['CA$5.00', 5, 'CAD'],
            ['R$10,00', 10, 'BRL'],
            ['5,00 €', 5, 'EUR'],
            ['€1.234,56', 1234.56, 'EUR'],
            ['₫20,000', 20000, 'VND'],
            ['THB 100.00', 100, 'THB'],
            ['zł20,00', 20, 'PLN'],
        ])('parses SuperChat price %s', async (text, amount, currency) => {
            const action = { item: { liveChatPaidMessageRenderer: {
                ...youtubeEvents.liveChatPaidMessage.addChatItemAction.item.liveChatPaidMessageRenderer,
                purchaseAmountText: { simpleText: text },
            } } };
            const [message] = await youtube.prepareChatMessages([action]);
            expect(message.amount).toBe(amount);
            expect(message.currency).toBe(currency);
        });

        it('prefers structured purchase micros over the display price', async () => {
            const action = { item: { liveChatPaidMessageRenderer: {
                ...youtubeEvents.liveChatPaidMessage.addChatItemAction.item.liveChatPaidMessageRenderer,
                purchaseAmountText: { simpleText: '¥1,000' },
                purchaseAmountMicros: '1000000000', currency: 'JPY',
            } } };
            const [message] = await youtube.prepareChatMessages([action]);
            expect(message.amount).toBe(1000);
            expect(message.currency).toBe('JPY');
        });

        it('should parse messages with emojis', async () => {
            const action = youtubeEvents.liveChatWithEmoji.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].message).toContain('Hello');
            expect(messages[0].message).toContain(':UC_happy:');
            expect(messages[0].message).toContain('world!');
            expect(messages[0].emojis).toHaveLength(1);
            expect(messages[0].emojis[0][2]).toBe('UC_happy');
        });

        it('should identify moderator badge', async () => {
            const action = youtubeEvents.liveChatWithBadges.addChatItemAction;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages).toHaveLength(1);
            expect(messages[0].is_mod).toBe(true);
            expect(messages[0].is_sub).toBe(true); // Has custom thumbnail = member
        });

        it('should handle empty actions array', async () => {
            const messages = await youtube.prepareChatMessages([]);
            expect(messages).toHaveLength(0);
        });

        it('should filter out null results from unknown action types', async () => {
            const unknownAction = {
                item: { unknownRenderer: {} }
            };
            const messages = await youtube.prepareChatMessages([unknownAction]);
            expect(messages).toHaveLength(0);
        });
    });

    describe('injectMessage', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = false;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();

            // Reset mocks
            mockChatContainer.appendChild.mockClear();
            mockHead.appendChild.mockClear();
        });

        it('should inject CSS on first message', () => {
            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(mockHead.appendChild).toHaveBeenCalled();
            expect(youtube._cssInjected).toBe(true);
        });

        it('should not inject CSS twice', () => {
            youtube._cssInjected = true;

            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(mockHead.appendChild).not.toHaveBeenCalled();
        });

        it('should create message element with correct structure', () => {
            const message = {
                id: 'test-id',
                username: '@TestUser',
                message: 'Hello world!',
                avatar: 'https://example.com/avatar.jpg',
                sent_at: Date.now(),
            };

            youtube.injectMessage(message);

            expect(mockChatContainer.appendChild).toHaveBeenCalled();
            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.tagName).toBe('yt-live-chat-text-message-renderer');
            expect(element.className).toContain('chuck-external');
            expect(element.id).toBe('test-id');
        });

        it('should generate ID if not provided', () => {
            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.id).toMatch(/^chuck-\d+-[a-z0-9]+$/);
        });

        it('should use default values for missing fields', () => {
            youtube.injectMessage({});

            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.innerHTML).toContain('External'); // Default username
        });

        it('should warn if chat container not found', () => {
            const originalQuery = document.querySelector;
            document.querySelector = vi.fn(() => null);

            youtube.injectMessage({ username: 'Test', message: 'Hello' });

            expect(youtube.warn).toHaveBeenCalledWith(
                'Could not find chat container for message injection'
            );

            document.querySelector = originalQuery;
        });

        it('should log successful injection', () => {
            youtube.injectMessage({ username: '@TestUser', message: 'Hello!' });

            expect(youtube.log).toHaveBeenCalledWith(
                'Injected external message:',
                '@TestUser',
                'Hello!'
            );
        });
    });

    describe('Fuzzing: prepareChatMessages robustness', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should not crash on malformed action data', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        item: fc.oneof(
                            fc.record({
                                liveChatTextMessageRenderer: fc.oneof(
                                    fc.record({
                                        message: fc.option(fc.record({
                                            runs: fc.option(fc.array(fc.record({
                                                text: fc.option(fc.string(), { nil: undefined }),
                                                emoji: fc.option(fc.record({
                                                    emojiId: fc.string(),
                                                    image: fc.record({
                                                        thumbnails: fc.array(fc.record({ url: fc.string() }))
                                                    })
                                                }), { nil: undefined })
                                            })), { nil: undefined })
                                        }), { nil: undefined }),
                                        authorName: fc.option(fc.record({
                                            simpleText: fc.string()
                                        }), { nil: undefined }),
                                        authorPhoto: fc.option(fc.record({
                                            thumbnails: fc.array(fc.record({
                                                url: fc.string(),
                                                width: fc.integer(),
                                                height: fc.integer()
                                            }))
                                        }), { nil: undefined }),
                                        id: fc.option(fc.string(), { nil: undefined }),
                                        timestampUsec: fc.option(fc.string(), { nil: undefined }),
                                        authorBadges: fc.option(fc.array(fc.record({
                                            liveChatAuthorBadgeRenderer: fc.record({
                                                icon: fc.option(fc.record({ iconType: fc.string() }), { nil: undefined }),
                                                customThumbnail: fc.option(fc.anything(), { nil: undefined })
                                            })
                                        })), { nil: undefined })
                                    }),
                                    fc.constant(undefined)
                                )
                            }),
                            fc.constant(undefined)
                        )
                    }),
                    async (action) => {
                        try {
                            await youtube.prepareChatMessages([action]);
                            return true;
                        } catch (e) {
                            console.error('Crash on action:', JSON.stringify(action));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle random message content without crashing', async () => {
            await fc.assert(
                fc.asyncProperty(fc.string(), async (content) => {
                    const action = {
                        item: {
                            liveChatTextMessageRenderer: {
                                message: { runs: [{ text: content }] },
                                authorName: { simpleText: '@FuzzUser' },
                                authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                                id: 'fuzz-test',
                                timestampUsec: '1234567890000000'
                            }
                        }
                    };

                    try {
                        const messages = await youtube.prepareChatMessages([action]);
                        return messages[0].message === content;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle unicode content', async () => {
            await fc.assert(
                fc.asyncProperty(fc.string(), async (content) => {
                    const action = {
                        item: {
                            liveChatTextMessageRenderer: {
                                message: { runs: [{ text: content }] },
                                authorName: { simpleText: '@UnicodeUser' },
                                authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                                id: 'unicode-test',
                                timestampUsec: '1234567890000000'
                            }
                        }
                    };

                    try {
                        await youtube.prepareChatMessages([action]);
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle various currency formats', async () => {
            const currencies = [
                '$5.00', '€10.00', '£5.00', '¥1000', '₹500',
                'US$5.00', 'A$10.00', 'C$5.00', 'HK$50.00',
                '5,00 €', '10.00 EUR', '500 INR', 'R$25.00'
            ];

            for (const currency of currencies) {
                const action = {
                    item: {
                        liveChatPaidMessageRenderer: {
                            message: { runs: [{ text: 'Thanks!' }] },
                            authorName: { simpleText: '@Donor' },
                            authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                            purchaseAmountText: { simpleText: currency },
                            id: 'currency-test',
                            timestampUsec: '1234567890000000'
                        }
                    }
                };

                // Should not throw
                await youtube.prepareChatMessages([action]);
            }
        });
    });

    describe('Fuzzing: injectMessage robustness', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = true; // Skip CSS injection
            youtube.log = vi.fn();
            youtube.warn = vi.fn();

            mockChatContainer.appendChild.mockClear();
        });

        it('should not crash on arbitrary message shapes', () => {
            const messageArbitrary = fc.record({
                id: fc.option(fc.string(), { nil: undefined }),
                username: fc.option(fc.string(), { nil: undefined }),
                message: fc.option(fc.string(), { nil: undefined }),
                avatar: fc.option(fc.string(), { nil: undefined }),
                sent_at: fc.option(fc.integer(), { nil: undefined }),
                amount: fc.option(fc.float(), { nil: undefined }),
                currency: fc.option(fc.string(), { nil: undefined }),
            });

            fc.assert(
                fc.property(messageArbitrary, (message) => {
                    try {
                        youtube.injectMessage(message);
                        return true;
                    } catch (e) {
                        console.error('Crash on message:', JSON.stringify(message));
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle XSS-like content safely', () => {
            const xssPayloads = [
                '<script>alert("xss")</script>',
                '"><script>alert(1)</script>',
                "javascript:alert('xss')",
                '<img src=x onerror=alert(1)>',
                '<svg onload=alert(1)>',
                '{{constructor.constructor("alert(1)")()}}',
                '${alert(1)}',
                '<iframe src="javascript:alert(1)">',
            ];

            for (const payload of xssPayloads) {
                expect(() => {
                    youtube.injectMessage({
                        username: payload,
                        message: payload,
                        avatar: payload,
                    });
                }).not.toThrow();
            }
        });

        it('should handle unicode usernames and messages', () => {
            fc.assert(
                fc.property(fc.string(), fc.string(), (username, message) => {
                    try {
                        youtube.injectMessage({ username, message });
                        return true;
                    } catch (e) {
                        return false;
                    }
                }),
                { numRuns: 200 }
            );
        });

        it('should handle very long messages', () => {
            fc.assert(
                fc.property(
                    fc.string({ minLength: 5000, maxLength: 50000 }),
                    (longMessage) => {
                        try {
                            youtube.injectMessage({ message: longMessage });
                            return true;
                        } catch (e) {
                            return false;
                        }
                    }
                ),
                { numRuns: 20 }
            );
        });

        it('should handle null and undefined gracefully', () => {
            expect(() => youtube.injectMessage(null)).not.toThrow();
            expect(youtube.warn).toHaveBeenCalledWith('injectMessage called with null/undefined message');

            youtube.warn.mockClear();
            expect(() => youtube.injectMessage(undefined)).not.toThrow();
            expect(youtube.warn).toHaveBeenCalledWith('injectMessage called with null/undefined message');

            youtube.warn.mockClear();
            expect(() => youtube.injectMessage({})).not.toThrow();
        });

        it('should handle messages with all edge case timestamps', () => {
            const edgeCases = [
                0,
                -1,
                Date.now(),
                Date.now() + 86400000, // Future
                Number.MAX_SAFE_INTEGER,
                Number.MIN_SAFE_INTEGER,
                NaN,
                Infinity,
                -Infinity,
            ];

            for (const timestamp of edgeCases) {
                expect(() => {
                    youtube.injectMessage({
                        username: 'Test',
                        message: 'Hello',
                        sent_at: timestamp,
                    });
                }).not.toThrow();
            }
        });
    });

    describe('Integration: full inject_message command flow', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube._cssInjected = true;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
            youtube._debug = vi.fn();

            mockChatContainer.appendChild.mockClear();
        });

        it('should handle full inject_message payload from server', () => {
            const payload = youtubeEvents.injectMessagePayload;

            // Simulate what handleServerCommand does
            youtube.injectMessage(payload.data);

            expect(mockChatContainer.appendChild).toHaveBeenCalled();
            const element = mockChatContainer.appendChild.mock.calls[0][0];
            expect(element.id).toBe('external-msg-123');
            expect(element.innerHTML).toContain('@ExternalUser');
            expect(element.innerHTML).toContain('Hello from another platform!');
        });
    });

    describe('Real recording data tests', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should parse all real recorded messages without errors', async () => {
            const realMessages = youtubeEvents.realRecordingMessages;

            for (const action of realMessages) {
                const messages = await youtube.prepareChatMessages([action]);

                expect(messages).toHaveLength(1);
                expect(messages[0]).toBeInstanceOf(ChatMessage);
                expect(messages[0].username).toBeTruthy();
                expect(messages[0].id).toBeTruthy();
            }
        });

        it('should correctly parse real text message', async () => {
            // First message: "Tom is Bulgarian so it's expected"
            const action = youtubeEvents.realRecordingMessages[0];
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages[0].username).toBe('@Orpheus5stargeneral');
            expect(messages[0].message).toBe("Tom is Bulgarian so it's expected ");
        });

        it('should correctly parse real message with member badge', async () => {
            // Second message has "Member (1 month)" badge
            const action = youtubeEvents.realRecordingMessages[1];
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages[0].username).toBe('@farflight00');
            expect(messages[0].is_sub).toBe(true);
        });

        it('should correctly parse real message with custom emojis', async () => {
            // Third message has two custom emojis
            const action = youtubeEvents.realRecordingMessages[2];
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages[0].username).toBe('@Afrosamurai469');
            expect(messages[0].emojis).toHaveLength(2);
        });

        it('should correctly parse real message with moderator badge', async () => {
            // Fourth message has moderator badge
            const action = youtubeEvents.realRecordingMessages[3];
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages[0].username).toBe('@Stylonuum');
            expect(messages[0].is_mod).toBe(true);
        });

        it('should correctly parse real SuperChat message', async () => {
            const action = youtubeEvents.realPaidMessage;
            const messages = await youtube.prepareChatMessages([action]);

            expect(messages[0].username).toBe('@babushkaposting');
            expect(messages[0].amount).toBe(10);
            expect(messages[0].currency).toBe('USD');
            expect(messages[0].message).toContain('guilty');
        });
    });

    describe('Real data mutation fuzzing', () => {
        let youtube;

        beforeEach(() => {
            youtube = Object.create(YouTube.prototype);
            youtube.platform = 'YouTube';
            youtube.channel = 'TestChannel';
            youtube.namespace = YouTube.namespace;
            youtube.log = vi.fn();
            youtube.warn = vi.fn();
        });

        it('should handle mutations of real message runs', async () => {
            const baseAction = youtubeEvents.realRecordingMessages[0];
            const renderer = baseAction.item.liveChatTextMessageRenderer;

            await fc.assert(
                fc.asyncProperty(
                    fc.array(
                        fc.oneof(
                            fc.record({ text: fc.string() }),
                            fc.record({
                                emoji: fc.record({
                                    emojiId: fc.string(),
                                    image: fc.record({
                                        thumbnails: fc.array(fc.record({ url: fc.string() }))
                                    })
                                })
                            })
                        )
                    ),
                    async (runs) => {
                        const mutatedAction = {
                            item: {
                                liveChatTextMessageRenderer: {
                                    ...renderer,
                                    message: { runs }
                                }
                            }
                        };

                        try {
                            await youtube.prepareChatMessages([mutatedAction]);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated runs:', JSON.stringify(runs));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real message author info', async () => {
            const baseAction = youtubeEvents.realRecordingMessages[0];
            const renderer = baseAction.item.liveChatTextMessageRenderer;

            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        authorName: fc.record({ simpleText: fc.string() }),
                        authorPhoto: fc.record({
                            thumbnails: fc.array(fc.record({
                                url: fc.string(),
                                width: fc.integer({ min: 1, max: 256 }),
                                height: fc.integer({ min: 1, max: 256 })
                            }), { minLength: 1 })
                        }),
                        authorExternalChannelId: fc.string()
                    }),
                    async (authorInfo) => {
                        const mutatedAction = {
                            item: {
                                liveChatTextMessageRenderer: {
                                    ...renderer,
                                    ...authorInfo
                                }
                            }
                        };

                        try {
                            await youtube.prepareChatMessages([mutatedAction]);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated author:', JSON.stringify(authorInfo));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real message badges', async () => {
            const baseAction = youtubeEvents.realRecordingMessages[3]; // Has moderator badge
            const renderer = baseAction.item.liveChatTextMessageRenderer;

            await fc.assert(
                fc.asyncProperty(
                    fc.array(
                        fc.record({
                            liveChatAuthorBadgeRenderer: fc.record({
                                icon: fc.option(fc.record({ iconType: fc.string() }), { nil: undefined }),
                                customThumbnail: fc.option(
                                    fc.record({
                                        thumbnails: fc.array(fc.record({ url: fc.string() }))
                                    }),
                                    { nil: undefined }
                                ),
                                tooltip: fc.option(fc.string(), { nil: undefined })
                            })
                        })
                    ),
                    async (badges) => {
                        const mutatedAction = {
                            item: {
                                liveChatTextMessageRenderer: {
                                    ...renderer,
                                    authorBadges: badges
                                }
                            }
                        };

                        try {
                            await youtube.prepareChatMessages([mutatedAction]);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated badges:', JSON.stringify(badges));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real paid message amounts', async () => {
            const baseAction = youtubeEvents.realPaidMessage;
            const renderer = baseAction.item.liveChatPaidMessageRenderer;

            const currencyFormats = [
                '$', '€', '£', '¥', '₹', 'US$', 'A$', 'C$', 'HK$',
                'R$', 'MX$', 'NZ$', 'S$', 'SEK', 'NOK', 'CHF', 'PLN'
            ];

            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        currency: fc.constantFrom(...currencyFormats),
                        amount: fc.float({ min: Math.fround(0.01), max: Math.fround(99999.99) })
                    }),
                    async ({ currency, amount }) => {
                        const amountStr = currency + amount.toFixed(2);
                        const mutatedAction = {
                            item: {
                                liveChatPaidMessageRenderer: {
                                    ...renderer,
                                    purchaseAmountText: { simpleText: amountStr }
                                }
                            }
                        };

                        try {
                            await youtube.prepareChatMessages([mutatedAction]);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated amount:', amountStr);
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
