/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * XMRChat platform scraper
 *
 * XMRChat (xmrchat.com) is a Monero tipping page. A streamer's tips are public:
 *
 *   GET https://nest.xmrchat.com/tips/page/{slug}
 *   -> XMRTip[]  (newest first, full history, amounts in piconero, no login needed)
 *
 * The site requests it with axios (XHR) and re-polls it every 8 s on the streamer
 * dashboard (`/streamer`) and every 10 s on the public page (`/{slug}`, also
 * `/{locale}/{slug}`). Its live Socket.IO events need a login, so CHUCK reads the
 * polls instead.
 *
 * On a public page CHUCK also fetches the list itself on load, so recent tips show
 * up immediately. On the dashboard the slug is only known from the page's own first
 * poll, which happens on load anyway.
 *
 * Only paid, public tips from the last `RECENT_TIP_WINDOW_MS` are sent, each once
 * per page session. The window matters because the list is the full history: SNEED
 * re-broadcasts anything it receives, and its overlay only drops a repeat while the
 * earlier copy is still on screen.
 */

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';

interface XMRTip {
    id: string | number;
    name?: string | null;
    message?: string | null;
    createdAt?: string;
    private?: boolean;
    payment?: {
        amount?: string | null;
        paidAmount?: string | null;
        paidAt?: string | null;
    } | null;
}

const API_BASE = 'https://nest.xmrchat.com';
const PICONERO_PER_XMR = 1e12;
const FALLBACK_XMR_PRICE_USD = 200;

/** Only tips paid this recently are sent; matches SNEED's 24 h reload of paid messages. */
export const RECENT_TIP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Locale prefixes used by the site's router (`/fr/{slug}` etc.). */
const LOCALES: ReadonlySet<string> = new Set(['en', 'fr', 'es', 'de', 'ru', 'fi', 'pcm', 'ko', 'ar', 'cs', 'fa']);

/** First path segments that are site routes rather than streamer pages. */
const RESERVED_PATHS: ReadonlySet<string> = new Set([
    'streamer', 'auth', 'admin', 'obs', 'creators', 'faq', 'terms', 'privacy',
    'accept-invitation', 'reset-password', 'login', 'signup', 'images', 'thumbnails', '_nuxt',
]);

/** Streamer slug of a public page path (`/monerotalk`, `/fr/monerotalk`), else null. */
export function streamerSlugFromPath(pathname: string): string | null {
    const segments = pathname.split('/').filter(segment => segment.length > 0);
    if (segments.length > 0 && LOCALES.has(segments[0])) segments.shift();

    const slug = segments[0];
    if (slug === undefined || RESERVED_PATHS.has(slug.toLowerCase())) return null;
    return decodeURIComponent(slug);
}

/** Slug in a tips-list request URL (`.../tips/page/{slug}`), else null. */
export function slugFromTipsUrl(url: string): string | null {
    const match = /\/tips\/page\/([^/?#]+)/.exec(url);
    return match ? decodeURIComponent(match[1]) : null;
}

function isTip(value: unknown): value is XMRTip {
    return typeof value === 'object' && value !== null
        && (typeof (value as XMRTip).id === 'string' || typeof (value as XMRTip).id === 'number');
}

function parseTimestamp(value: unknown): number {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isNaN(parsed) ? Date.now() : parsed;
}

export class XMRChat extends Seed {
    static hostname = 'xmrchat.com';
    static namespace = '806b15e6-d8fe-4344-b66d-9604b5d60241';

    /** Tip ids already decided on this session (sent, private, or too old). */
    sentTipIds = new Set<string>();
    xmrPrice = FALLBACK_XMR_PRICE_USD;
    /** Resolves once the XMR price request settles, so tips are valued with it. */
    pricePromise: Promise<void> | null = null;

    constructor() {
        const slug = streamerSlugFromPath(new URL(window.location.href).pathname);
        // On the dashboard the slug is learned from the page's first tips request.
        super(XMRChat.namespace, 'XMRChat', slug!);

        this.pricePromise = this.fetchPrice();
        if (slug !== null) void this.fetchTips(slug);
    }

    //
    // Data sources
    //

    async fetchPrice(): Promise<void> {
        try {
            const text = await (await fetch(`${API_BASE}/prices/xmr`)).text();
            const price = parseFloat(text);
            if (Number.isFinite(price) && price > 0) {
                this.xmrPrice = price;
                this.log('Fetched XMR price:', price);
            } else {
                this.warn('Unexpected XMR price response; using fallback.', text);
            }
        } catch (error) {
            this.warn('Failed to fetch XMR price; using fallback.', error);
        }
    }

    /** Load a streamer's tips on page load instead of waiting for the site's next poll. */
    async fetchTips(slug: string): Promise<void> {
        try {
            const response = await fetch(`${API_BASE}/tips/page/${encodeURIComponent(slug)}`);
            if (!response.ok) {
                this.warn(`Tips request failed with HTTP ${response.status}.`);
                return;
            }
            const sent = await this.receiveTips(await response.json(), slug);
            this.log(`Loaded tips on page load; sent ${sent}.`);
        } catch (error) {
            this.error('Failed to fetch tips.', error);
        }
    }

    /**
     * Send every recent, paid, public tip not sent before, oldest first.
     * Returns how many were sent.
     */
    async receiveTips(json: unknown, slug: string | null): Promise<number> {
        if (!Array.isArray(json)) return 0;
        if (slug !== null && slug !== this.channel) this.setChannel(slug);

        await this.pricePromise;

        const cutoff = Date.now() - RECENT_TIP_WINDOW_MS;
        const messages: ChatMessage[] = [];

        for (const tip of json) {
            if (!isTip(tip)) continue;
            const id = String(tip.id);
            if (this.sentTipIds.has(id)) continue;

            // Unpaid tips are left undecided so a later poll can send them once paid.
            const paidAt = tip.payment?.paidAt;
            if (!paidAt) continue;

            this.sentTipIds.add(id);
            if (tip.private === true) continue;
            if (parseTimestamp(paidAt) < cutoff) continue;

            messages.push(this.prepareChatMessage(tip));
        }

        if (messages.length > 0) {
            messages.reverse(); // the API is newest first
            this.sendChatMessages(messages);
        }
        return messages.length;
    }

    prepareChatMessage(tip: XMRTip): ChatMessage {
        const message = new ChatMessage(
            uuidv5(`XMRCHAT-${tip.id}`, this.namespace!),
            this.platform!,
            this.channel!
        );
        message.username = tip.name?.trim() || 'Anonymous';
        message.message = tip.message ?? '';
        message.sent_at = parseTimestamp(tip.payment?.paidAt ?? tip.createdAt);

        const piconero = Number(tip.payment?.paidAmount || tip.payment?.amount || 0);
        message.amount = Number.isFinite(piconero) ? this.xmrPrice * (piconero / PICONERO_PER_XMR) : 0;
        message.currency = 'USD';

        return message;
    }

    //
    // Transport hooks
    //

    onXhrReadyStateChange(xhr: XMLHttpRequest, _event: Event): void {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;

        const slug = slugFromTipsUrl(xhr.responseURL);
        if (slug === null) {
            this.recorder.recordXhr(xhr.responseURL, 'GET', xhr.status, null, EventStatus.IGNORED, null, 'Not tips endpoint');
            return;
        }

        let json: unknown;
        try {
            json = typeof xhr.response === 'string' ? JSON.parse(xhr.response) : xhr.response;
        } catch (error) {
            this.error('Tips response is not JSON.', error);
            this.recorder.recordXhr(xhr.responseURL, 'GET', xhr.status, null, EventStatus.ERROR, null, (error as Error).message);
            return;
        }

        void this.receiveTips(json, slug)
            .then(sent => {
                this.recorder.recordXhr(xhr.responseURL, 'GET', xhr.status, json, EventStatus.HANDLED, {
                    tips: Array.isArray(json) ? json.length : 0,
                    sent,
                });
            })
            .catch(error => this.error('Failed to process tips.', error));
    }
}

export default XMRChat;
