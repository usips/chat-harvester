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

const { streamerSlugFromPath, slugFromTipsUrl, RECENT_TIP_WINDOW_MS } = await import('../../src/platforms/xmrchat.js');
const { uuidv5 } = await import('../../src/core/uuid.js');

/** An XMRChat instance with no constructor side effects and observable outputs. */
function makeXmr(overrides = {}) {
    const x = Object.create(XMRChat.prototype);
    Object.assign(x, {
        platform: 'XMRChat',
        channel: null,
        namespace: XMRChat.namespace,
        xmrPrice: 200,
        pricePromise: null,
        sentTipIds: new Set(),
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        sendChatMessages: vi.fn(),
        recorder: { record: vi.fn(), recordXhr: vi.fn() },
    }, overrides);
    x.setChannel = vi.fn(channel => { x.channel = channel; });
    return x;
}

const realTips = () => JSON.parse(JSON.stringify(xmrchatEvents.RealTipsPage));

describe('XMRChat page detection', () => {
    it('reads the streamer slug from public page paths', () => {
        expect(streamerSlugFromPath('/monerotalk')).toBe('monerotalk');
        expect(streamerSlugFromPath('/fr/monerotalk')).toBe('monerotalk');
        expect(streamerSlugFromPath('/monerotalk/super-dm/12')).toBe('monerotalk');
    });

    it('returns null for site routes', () => {
        for (const path of ['/', '/streamer', '/streamer/obs', '/auth/login', '/de/streamer', '/admin/pages/x', '/fr']) {
            expect(streamerSlugFromPath(path)).toBeNull();
        }
    });

    it('reads the slug from a tips request URL', () => {
        expect(slugFromTipsUrl('https://nest.xmrchat.com/tips/page/monerotalk')).toBe('monerotalk');
        expect(slugFromTipsUrl('https://nest.xmrchat.com/tips/page/some%20page?x=1')).toBe('some page');
        expect(slugFromTipsUrl('https://nest.xmrchat.com/tips/total')).toBeNull();
    });
});

describe('XMRChat real tips', () => {
    it('values a real tip from its paid amount and stamps it in milliseconds', () => {
        const x = makeXmr({ channel: 'monerotalk' });
        const message = x.prepareChatMessage(realTips()[0]);

        expect(message.id).toBe(uuidv5('XMRCHAT-7479', XMRChat.namespace));
        expect(message.username).toBe('Ruja Ignatova');
        // 100000000 piconero = 0.0001 XMR, at $200/XMR = $0.02
        expect(message.amount).toBeCloseTo(0.02, 6);
        expect(message.currency).toBe('USD');
        expect(message.sent_at).toBe(Date.parse('2026-09-05T19:01:23.362Z'));
    });

    it('names an unnamed tip Anonymous', () => {
        const message = makeXmr().prepareChatMessage({ id: 1, name: '  ', payment: { amount: '0' } });
        expect(message.username).toBe('Anonymous');
        expect(message.message).toBe('');
    });
});

describe('XMRChat receiveTips', () => {
    afterEach(() => vi.useRealTimers());

    it('sends recent public paid tips oldest first and skips private ones', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        const x = makeXmr();
        const tips = realTips();
        tips[2].payment.paidAt = '2026-09-05T17:00:00Z'; // make the private tip recent too

        expect(await x.receiveTips(tips, 'monerotalk')).toBe(2);

        const [[messages]] = x.sendChatMessages.mock.calls;
        expect(messages.map(m => m.id)).toEqual([
            uuidv5('XMRCHAT-7478', XMRChat.namespace),
            uuidv5('XMRCHAT-7479', XMRChat.namespace),
        ]);
        expect(x.setChannel).toHaveBeenCalledWith('monerotalk');
        expect(messages.every(m => m.channel === 'monerotalk')).toBe(true);
    });

    it('sends each tip once across repeated polls', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        const x = makeXmr();

        await x.receiveTips(realTips(), 'monerotalk');
        expect(await x.receiveTips(realTips(), 'monerotalk')).toBe(0);
        expect(x.sendChatMessages).toHaveBeenCalledTimes(1);
    });

    it('does not replay tips older than the window', async () => {
        vi.useFakeTimers({ now: Date.parse('2026-09-05T19:01:23.362Z') + RECENT_TIP_WINDOW_MS + 1 });
        const x = makeXmr();

        expect(await x.receiveTips(realTips(), 'monerotalk')).toBe(0);
        expect(x.sendChatMessages).not.toHaveBeenCalled();
    });

    it('sends an unpaid tip once a later poll shows it paid', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        const x = makeXmr();
        const pending = { ...realTips()[0], id: 9001, payment: { amount: '100000000', paidAmount: '0', paidAt: null } };

        expect(await x.receiveTips([pending], 'monerotalk')).toBe(0);
        const paid = { ...pending, payment: { amount: '100000000', paidAmount: '100000000', paidAt: '2026-09-05T19:59:00Z' } };
        expect(await x.receiveTips([paid], 'monerotalk')).toBe(1);
    });

    it('waits for the XMR price before valuing tips', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        let settle;
        const x = makeXmr({ pricePromise: new Promise(resolve => { settle = resolve; }) });

        const pending = x.receiveTips(realTips(), 'monerotalk');
        x.xmrPrice = 500;
        settle();
        await pending;

        const [[messages]] = x.sendChatMessages.mock.calls;
        expect(messages[0].amount).toBeCloseTo(0.05, 6);
    });

    it('ignores non-array and malformed payloads', async () => {
        const x = makeXmr();
        for (const body of [null, {}, 'x', [null, 3, { nope: true }]]) {
            expect(await x.receiveTips(body, 'monerotalk')).toBe(0);
        }
        expect(x.sendChatMessages).not.toHaveBeenCalled();
    });
});

describe('XMRChat transport', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    const xhr = (url, response) => ({ readyState: XMLHttpRequest.DONE, responseURL: url, response, status: 200 });

    it('handles the site\'s own tips poll', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        const x = makeXmr();

        x.onXhrReadyStateChange(xhr('https://nest.xmrchat.com/tips/page/monerotalk', JSON.stringify(realTips())), {});
        await vi.runAllTimersAsync();

        expect(x.sendChatMessages).toHaveBeenCalledTimes(1);
        expect(x.recorder.recordXhr).toHaveBeenCalledWith(
            'https://nest.xmrchat.com/tips/page/monerotalk', 'GET', 200, expect.any(Array), 'handled', { tips: 3, sent: 2 }
        );
    });

    it('records a non-JSON tips response as an error without throwing', () => {
        const x = makeXmr();
        expect(() => x.onXhrReadyStateChange(xhr('https://nest.xmrchat.com/tips/page/monerotalk', '<html>'), {})).not.toThrow();
        expect(x.recorder.recordXhr).toHaveBeenCalledWith(
            'https://nest.xmrchat.com/tips/page/monerotalk', 'GET', 200, null, 'error', null, expect.any(String)
        );
    });

    it('ignores other requests', () => {
        const x = makeXmr();
        x.onXhrReadyStateChange(xhr('https://nest.xmrchat.com/tips/total', '{}'), {});
        expect(x.sendChatMessages).not.toHaveBeenCalled();
    });

    it('fetches tips on page load by slug', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-05T20:00:00Z') });
        const x = makeXmr();
        const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(realTips()) }));
        vi.stubGlobal('fetch', fetchSpy);

        await x.fetchTips('monerotalk');

        expect(fetchSpy).toHaveBeenCalledWith('https://nest.xmrchat.com/tips/page/monerotalk');
        expect(x.sendChatMessages).toHaveBeenCalledTimes(1);
    });

    it('survives a failing tips or price request', async () => {
        const x = makeXmr();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

        await expect(x.fetchTips('monerotalk')).resolves.toBeUndefined();
        await expect(x.fetchPrice()).resolves.toBeUndefined();
        expect(x.xmrPrice).toBe(200);
    });
});
