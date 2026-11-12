/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * YouTube platform scraper
 *
 * Features:
 * - Capture new messages
 * - Capture sent messages
 * - Capture emotes
 * - Capture view counts
 * - Capture SuperChats with currency parsing
 * - Capture membership gifts
 */

import { Seed, ChatMessage, uuidv5, WINDOW, EventStatus, parseAmount } from '../core/index.js';

interface YTWindow extends Window {
    ytInitialData?: YTInitialData;
    ytInitialPlayerResponse?: YTPlayerResponse;
}

/** The fields of `ytInitialPlayerResponse` that say whether a video is live right now. */
interface YTPlayerResponse {
    videoDetails?: {
        videoId?: string;
        isLive?: boolean;
        isLiveContent?: boolean;
    };
    microformat?: {
        playerMicroformatRenderer?: {
            liveBroadcastDetails?: {
                isLiveNow?: boolean;
            };
        };
    };
}

/** `detail` of the `yt-navigate-finish` event YouTube fires after an SPA navigation. */
interface YTNavigateDetail {
    pageType?: string;
    response?: {
        playerResponse?: YTPlayerResponse;
    };
}

/** The `#movie_player` element, which exposes the current video's player response. */
interface YTPlayerElement extends Element {
    getPlayerResponse?: () => YTPlayerResponse | null | undefined;
}

/** YouTube's view-count block, shared by the watch page and `updated_metadata`. */
interface YTViewCountRenderer {
    viewCount?: {
        simpleText?: string;
        runs?: { text?: string }[];
    };
    /** Present and true only while a stream is live; absent on videos and ended streams. */
    isLive?: boolean;
    /** The count as a plain number string, e.g. "16037". */
    originalViewCount?: string;
}

interface YTInitialData {
    continuationContents?: {
        liveChatContinuation?: {
            actions?: YTAction[];
            header?: {
                liveChatHeaderRenderer?: {
                    overflowMenu?: {
                        menuRenderer?: {
                            items?: {
                                menuServiceItemRenderer?: {
                                    serviceEndpoint?: {
                                        popoutLiveChatEndpoint?: {
                                            url?: string;
                                        };
                                    };
                                };
                            }[];
                        };
                    };
                };
            };
            continuations?: {
                invalidationContinuationData?: {
                    invalidationId?: {
                        topic?: string;
                    };
                };
            }[];
        };
    };
    contents?: {
        liveChatRenderer?: {
            /** The chat frame's initial messages. */
            actions?: YTAction[];
            continuations?: {
                invalidationContinuationData?: {
                    invalidationId?: {
                        topic?: string;
                    };
                };
            }[];
        };
    };
}

interface YTThumbnail {
    url: string;
}

interface YTAuthorBadge {
    liveChatAuthorBadgeRenderer?: {
        icon?: {
            iconType?: string;
        };
        customThumbnail?: unknown;
    };
}

interface YTRun {
    text?: string;
    emoji?: {
        /** The character itself for a standard emoji; "UC…/…" for a custom one. */
        emojiId: string;
        /** e.g. [":_wave:", ":wave:"] */
        shortcuts?: string[];
        isCustomEmoji?: boolean;
        image?: {
            thumbnails?: YTThumbnail[];
        };
    };
}

/** Text that YouTube sends either as `simpleText` or as `runs`. */
interface YTText {
    simpleText?: string;
    runs?: { text?: string }[];
}

/** Fields every chat item may carry about its author. */
interface YTItemBase {
    id?: string;
    authorName?: {
        simpleText?: string;
    };
    authorPhoto?: {
        thumbnails?: YTThumbnail[];
    };
    timestampUsec?: string;
    authorExternalChannelId?: string;
    authorBadges?: YTAuthorBadge[];
}

interface YTRenderer extends YTItemBase {
    id: string;
    authorName: {
        simpleText: string;
    };
    authorPhoto: {
        thumbnails: YTThumbnail[];
    };
    timestampUsec: string;
    message?: {
        runs?: YTRun[];
    };
}

/** Price fields shared by paid messages and paid stickers. */
interface YTPurchase {
    purchaseAmountText?: {
        simpleText?: string;
    };
    /** Structured amount, when present: micros of `currency`. */
    purchaseAmountMicros?: string | number;
    currency?: string;
}

interface YTPaidStickerRenderer extends YTItemBase, YTPurchase {
    sticker?: {
        thumbnails?: YTThumbnail[];
        accessibility?: { accessibilityData?: { label?: string } };
    };
}

/** New member ("Welcome to …") or a membership milestone ("Member for 6 months"). */
interface YTMembershipItemRenderer extends YTItemBase {
    headerPrimaryText?: YTText;
    headerSubtext?: YTText;
    message?: {
        runs?: YTRun[];
    };
}

interface YTGiftingEventRenderer extends YTItemBase {
    numGiftedMembers?: number;
}

/** A gift purchase: the gifter is in the header, "Sent 5 … gift memberships" in primaryText. */
interface YTGiftPurchaseRenderer extends YTItemBase {
    header?: {
        liveChatSponsorshipsHeaderRenderer?: YTItemBase & {
            primaryText?: YTText;
        };
    };
}

interface YTGiftReceivedRenderer extends YTItemBase {
    numGiftedMembers?: number;
}

interface YTPlaceholderRenderer {
    id: string;
    timestampUsec: string;
}

interface YTAction {
    item?: {
        liveChatTextMessageRenderer?: YTRenderer;
        liveChatPaidMessageRenderer?: YTRenderer & YTPurchase;
        liveChatPaidStickerRenderer?: YTPaidStickerRenderer;
        liveChatMembershipItemRenderer?: YTMembershipItemRenderer;
        liveChatMembershipGiftingEventRenderer?: YTGiftingEventRenderer;
        liveChatSponsorshipsGiftPurchaseAnnouncementRenderer?: YTGiftPurchaseRenderer;
        liveChatGiftMembershipReceivedEventRenderer?: YTGiftReceivedRenderer;
        liveChatSponsorshipsGiftRedemptionAnnouncementRenderer?: YTGiftReceivedRenderer;
        liveChatPlaceholderItemRenderer?: YTPlaceholderRenderer;
    };
    addChatItemAction?: YTAction;
    addLiveChatMembershipItemAction?: YTAction;
    replaceChatItemAction?: {
        targetItemId?: string;
        replacementItem?: YTAction['item'];
    };
    removeChatItemAction?: {
        targetItemId: string;
    };
    markChatItemAsDeletedAction?: {
        targetItemId?: string;
    };
    removeChatItemByAuthorAction?: {
        externalChannelId?: string;
    };
    markChatItemsByAuthorAsDeletedAction?: {
        externalChannelId?: string;
    };
    addLiveChatTickerItemAction?: unknown;
    updateLiveChatPollAction?: unknown;
}

/** Live-chat actions that only drive YouTube's UI and carry no messages. */
const YT_IGNORED_ACTIONS = [
    'addLiveChatTickerItemAction',
    'updateLiveChatPollAction',
    'addBannerToLiveChatCommand',
    'removeBannerForLiveChatCommand',
    'liveChatReportModerationStateCommand',
    'replayChatItemAction',
    'showLiveChatTooltipCommand',
    'showLiveChatActionPanelAction',
    'closeLiveChatActionPanelAction',
];

/** Value of one gifted membership; YouTube does not say what the gifter paid. */
const GIFT_MEMBERSHIP_USD = 5.00;

function hasBadge(badges: YTAuthorBadge[] | undefined, iconType: string): boolean {
    return Array.isArray(badges) && badges.some(badge =>
        badge?.liveChatAuthorBadgeRenderer?.icon?.iconType === iconType
    );
}

/** Channel members wear the channel's own badge image. */
function isMember(badges: YTAuthorBadge[] | undefined): boolean {
    return Array.isArray(badges) && badges.some(badge =>
        badge?.liveChatAuthorBadgeRenderer?.customThumbnail !== undefined
    );
}

function textOf(text: YTText | undefined): string {
    if (!text) return '';
    if (typeof text.simpleText === 'string') return text.simpleText;
    return Array.isArray(text.runs) ? text.runs.map(run => run?.text ?? '').join('') : '';
}

function positiveInt(value: unknown): number | null {
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** Bounds for the author → message ids map used by "remove by author" actions. */
const MAX_TRACKED_AUTHORS = 2000;
const MAX_IDS_PER_AUTHOR = 50;

interface YTLiveChatResponse {
    continuationContents?: {
        liveChatContinuation?: {
            actions?: YTAction[];
        };
    };
}

/**
 * The view count in `updated_metadata`'s entity store (2026-11). Unlike the old
 * renderer it has no isLive flag, so it may only be trusted on a known-live page.
 */
interface YTViewCountEntity {
    viewCount?: { simpleText?: string };
    extraShortViewCount?: { simpleText?: string };
    unlabeledViewCountValue?: { simpleText?: string };
    /** The count as a plain number string, e.g. "45479". */
    viewCountNumber?: string;
}

interface YTUpdatedMetadataResponse {
    actions?: {
        updateViewershipAction?: {
            viewCount?: {
                videoViewCountRenderer?: YTViewCountRenderer;
            };
        };
    }[];
    frameworkUpdates?: {
        entityBatchUpdate?: {
            mutations?: {
                payload?: {
                    viewCountEntity?: YTViewCountEntity;
                };
            }[];
        };
    };
}

/** Number in a `viewCountEntity` (viewCountNumber, else the unlabeled count's digits). */
export function viewerCountFromEntity(entity: YTViewCountEntity): number | null {
    const raw = entity.viewCountNumber ?? entity.unlabeledViewCountValue?.simpleText ?? '';
    const digits = String(raw).replace(/[^\d]/g, '');
    if (digits.length === 0) return null;
    const count = parseInt(digits, 10);
    return Number.isFinite(count) ? count : null;
}

/**
 * Whether the page's video is live now: true for a live stream, false for a regular
 * video or a finished stream, null when the player data is unavailable.
 */
export function liveStateFromPlayerResponse(playerResponse: YTPlayerResponse | undefined): boolean | null {
    if (!playerResponse?.videoDetails) return null;
    return playerResponse.videoDetails.isLive === true
        || playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true;
}

/** Number in a view-count block ("16,037 watching now", runs, or originalViewCount). */
export function viewerCountFromRenderer(renderer: YTViewCountRenderer): number | null {
    const raw = renderer.originalViewCount
        ?? renderer.viewCount?.simpleText
        ?? renderer.viewCount?.runs?.map(run => run.text ?? '').join('')
        ?? '';
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length === 0) return null;
    const count = parseInt(digits, 10);
    return Number.isFinite(count) ? count : null;
}

interface YTOembedResponse {
    author_url: string;
}

export class YouTube extends Seed {
    static hostname = 'youtube.com';
    static altHostname = 'www.youtube.com';
    static namespace = 'fd60ac36-d6b5-49dc-aee6-b0d87d130582';

    private _cssInjected = false;

    private _viewCountObserver: MutationObserver | null = null;
    private _viewCountElem: Element | null = null;
    private _viewCountTimer: ReturnType<typeof setInterval> | null = null;

    /** Author channel id → ids of messages sent for them (bounded, oldest author dropped). */
    private _authorMessages: Map<string, string[]> | null = null;

    /**
     * Whether this tab's video is live: null until known. A regular video's "views"
     * must never be reported as live viewers, and SNEED keeps one viewer count per
     * platform, so only a live tab may send or clear YouTube's count.
     */
    liveState: boolean | null = null;

    /** The video this tab is on (watch page or chat frame); null on pages without one. */
    videoId: string | null = null;

    /** Record a live-state change; a stream that ends in this tab clears SNEED's count once. */
    setLiveState(live: boolean | null, source: string): void {
        if (live === null || live === this.liveState) return;

        const wasLive = this.liveState === true;
        this.liveState = live;
        this.log(`Live state from ${source}: ${live ? 'live' : 'not live'}.`);

        if (wasLive && !live) {
            this.log('Stream ended; clearing the viewer count.');
            this.sendViewerCount(0);
        }
    }

    onBeforeUnload(_event: BeforeUnloadEvent): void {
        // Closing a video tab must not zero the count of a live YouTube tab.
        if (this.liveState === true) {
            this.sendViewerCount(0);
        }
    }

    constructor() {
        // Extract video ID from URL immediately to use as channel
        // This prevents race conditions where messages arrive before DOMContentLoaded
        const channel = YouTube._extractVideoIdFromUrl();
        super(YouTube.namespace, 'YouTube', channel!);

        if (channel) {
            this.log('Extracted video ID from URL:', channel);
        }
    }

    /**
     * Extract video ID from current URL for immediate use
     */
    private static _extractVideoIdFromUrl(): string | null {
        const url = new URL(window.location.href);

        // /watch?v=VIDEO_ID
        if (url.pathname.startsWith('/watch')) {
            return url.searchParams.get('v');
        }

        // /live/VIDEO_ID
        if (url.pathname.startsWith('/live/')) {
            const pathPart = url.pathname.split('/live/')[1];
            return pathPart ? pathPart.split('/')[0].split('?')[0] : null;
        }

        // /live_chat?v=VIDEO_ID (chat popup)
        if (url.pathname.includes('/live_chat')) {
            return url.searchParams.get('v');
        }

        return null;
    }

    /**
     * Inject CSS styles for external messages
     */
    private _injectCSS(): void {
        if (this._cssInjected) return;

        const style = document.createElement('style');
        style.textContent = `
            .chuck-external {
                background-color: rgba(128, 0, 128, 0.3) !important;
            }
        `;
        document.head.appendChild(style);
        this._cssInjected = true;
    }

    /**
     * Find the chat items container
     */
    private _getChatContainer(): Element | null {
        return document.querySelector('yt-live-chat-item-list-renderer #items');
    }

    /**
     * Inject an external message into the YouTube live chat
     */
    injectMessage(message: unknown): void {
        const msg = message as { id?: string; sent_at?: number; username?: string; avatar?: string; message?: string };
        if (!msg) {
            this.warn('injectMessage called with null/undefined message');
            return;
        }

        this._injectCSS();

        const container = this._getChatContainer();
        if (!container) {
            this.warn('Could not find chat container for message injection');
            return;
        }

        const id = msg.id || `chuck-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const timestamp = new Date(msg.sent_at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const username = msg.username || 'External';
        const avatar = msg.avatar || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const text = msg.message || '';

        // Create the message element
        const renderer = document.createElement('yt-live-chat-text-message-renderer');
        renderer.className = 'style-scope yt-live-chat-item-list-renderer chuck-external';
        renderer.setAttribute('modern', '');
        renderer.id = id;

        renderer.innerHTML = `
            <yt-img-shadow id="author-photo" class="no-transition style-scope yt-live-chat-text-message-renderer" height="24" width="24" style="background-color: transparent;">
                <img id="img" draggable="false" class="style-scope yt-img-shadow" alt="" height="24" width="24" src="${avatar}">
            </yt-img-shadow>
            <div id="content" class="style-scope yt-live-chat-text-message-renderer">
                <span id="timestamp" class="style-scope yt-live-chat-text-message-renderer">${timestamp}</span>
                <yt-live-chat-author-chip class="style-scope yt-live-chat-text-message-renderer">
                    <span id="prepend-chat-badges" class="style-scope yt-live-chat-author-chip"></span>
                    <span id="author-name" dir="auto" class="style-scope yt-live-chat-author-chip">${username}<span id="chip-badges" class="style-scope yt-live-chat-author-chip"></span></span>
                    <span id="chat-badges" class="style-scope yt-live-chat-author-chip"></span>
                </yt-live-chat-author-chip>
                <span id="message" dir="auto" class="style-scope yt-live-chat-text-message-renderer">${text}</span>
            </div>
        `;

        container.appendChild(renderer);

        // Scroll to bottom if user is near bottom
        const scroller = document.querySelector('yt-live-chat-item-list-renderer #item-scroller');
        if (scroller) {
            const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
            if (isNearBottom) {
                scroller.scrollTop = scroller.scrollHeight;
            }
        }

        this.log('Injected external message:', username, text);
    }

    /**
     * Set a paid item's amount and currency. Structured micros are preferred when
     * YouTube sends them; otherwise the display price ("CA$5.00") is parsed.
     */
    applyPurchase(message: ChatMessage, renderer: YTPurchase): void {
        const micros = Number(renderer.purchaseAmountMicros);
        if (renderer.purchaseAmountMicros !== undefined && Number.isFinite(micros)
            && typeof renderer.currency === 'string' && /^[A-Z]{3}$/.test(renderer.currency)) {
            message.amount = micros / 1_000_000;
            message.currency = renderer.currency;
            return;
        }

        const text = renderer.purchaseAmountText?.simpleText;
        const parsed = parseAmount(text);
        if (parsed === null) {
            this.warn('Could not parse SuperChat currency or amount.', text);
            return;
        }
        message.amount = parsed.amount;
        message.currency = parsed.currency;
    }

    /**
     * A message carrying an item's id, author and timestamp; null when the item lacks
     * an id. A missing author or photo keeps ChatMessage's defaults.
     */
    private _baseMessage(renderer: YTItemBase | undefined): ChatMessage | null {
        if (!renderer?.id) return null;

        const message = new ChatMessage(uuidv5(renderer.id, this.namespace!), this.platform!, this.channel!);
        const author = renderer.authorName?.simpleText;
        if (author) message.username = author;
        const avatar = renderer.authorPhoto?.thumbnails?.at(-1)?.url;
        if (avatar) message.avatar = avatar;
        const usec = parseInt(renderer.timestampUsec ?? '', 10);
        if (Number.isFinite(usec)) message.sent_at = Math.floor(usec / 1000);

        const badges = renderer.authorBadges;
        message.is_verified = hasBadge(badges, 'VERIFIED');
        message.is_sub = isMember(badges);
        message.is_mod = hasBadge(badges, 'MODERATOR');
        message.is_owner = hasBadge(badges, 'OWNER');

        this.trackAuthorMessage(renderer.authorExternalChannelId, message.id);
        return message;
    }

    /**
     * Append message runs as text. A standard emoji is its own character; a custom
     * emoji becomes its shortcut (":_name:") and an emoji entry with its image.
     */
    private _appendRuns(message: ChatMessage, runs: YTRun[] | undefined): void {
        if (!Array.isArray(runs)) return;

        for (const run of runs) {
            if (run?.text !== undefined) {
                message.message += run.text;
            } else if (run?.emoji !== undefined) {
                const emoji = run.emoji;
                const emojiId = String(emoji.emojiId ?? '');
                const custom = emoji.isCustomEmoji === true || emojiId.includes('/');
                if (!custom) {
                    message.message += emojiId;
                    continue;
                }
                const token = emoji.shortcuts?.find(s => typeof s === 'string' && s.length > 0) ?? `:${emojiId}:`;
                const url = emoji.image?.thumbnails?.at(-1)?.url || '';
                message.message += token;
                message.emojis.push([token, url, token.replace(/^:|:$/g, '')]);
            } else {
                this.log('[CHUCK::YouTube] Unknown run.', run);
            }
        }
    }

    prepareChatMessages(actions: YTAction[]): Promise<ChatMessage[]> {
        return Promise.all(actions.map(async (action) => {
            const item = action?.item;
            if (!item) {
                return null;
            }

            if (item.liveChatTextMessageRenderer !== undefined || item.liveChatPaidMessageRenderer !== undefined) {
                const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
                if (!renderer?.id || !renderer.authorName || !renderer.authorPhoto?.thumbnails?.length) {
                    return null; // Skip malformed messages
                }
                const message = this._baseMessage(renderer)!;
                if (item.liveChatPaidMessageRenderer !== undefined) {
                    this.applyPurchase(message, item.liveChatPaidMessageRenderer);
                }
                this._appendRuns(message, renderer.message?.runs);
                return message;
            }

            if (item.liveChatPaidStickerRenderer !== undefined) {
                const sticker = item.liveChatPaidStickerRenderer;
                const message = this._baseMessage(sticker);
                if (!message) return null;
                this.applyPurchase(message, sticker);
                message.message = sticker.sticker?.accessibility?.accessibilityData?.label ?? '';
                return message;
            }

            if (item.liveChatMembershipItemRenderer !== undefined) {
                const membership = item.liveChatMembershipItemRenderer;
                const message = this._baseMessage(membership);
                if (!message) return null;
                message.is_subscription = true;
                message.is_sub = true;
                // A milestone may carry the member's own message; otherwise use YouTube's header.
                if (membership.message?.runs?.length) {
                    this._appendRuns(message, membership.message.runs);
                } else {
                    message.message = textOf(membership.headerPrimaryText) || textOf(membership.headerSubtext);
                }
                return message;
            }

            if (item.liveChatMembershipGiftingEventRenderer !== undefined) {
                const giftingEvent = item.liveChatMembershipGiftingEventRenderer;
                const message = this._baseMessage(giftingEvent);
                if (!message) return null;
                const count = positiveInt(giftingEvent.numGiftedMembers) ?? 1;
                return this._giftPurchase(message, count);
            }

            if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer !== undefined) {
                const purchase = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
                const header = purchase.header?.liveChatSponsorshipsHeaderRenderer;
                const message = this._baseMessage({ ...header, ...purchase });
                if (!message) return null;
                const count = positiveInt(textOf(header?.primaryText).match(/\d[\d,.]*/)?.[0]?.replace(/\D/g, '')) ?? 1;
                return this._giftPurchase(message, count);
            }

            if (item.liveChatGiftMembershipReceivedEventRenderer !== undefined
                || item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer !== undefined) {
                // The recipient's notice is not a payment: the gifter's event carries the amount.
                const received = item.liveChatGiftMembershipReceivedEventRenderer
                    ?? item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer!;
                const message = this._baseMessage(received);
                if (!message) return null;
                message.is_sub = true;
                message.message = `${message.username} received a gifted membership!`;
                return message;
            }

            if (item.liveChatPlaceholderItemRenderer !== undefined) {
                const placeholder = item.liveChatPlaceholderItemRenderer;
                if (!placeholder.id) return null;
                const message = new ChatMessage(
                    uuidv5(placeholder.id, this.namespace!),
                    this.platform!,
                    this.channel!
                );
                message.sent_at = Math.floor(parseInt(placeholder.timestampUsec) / 1000);
                message.is_placeholder = true;
                return message;
            }

            return null;
        })).then((messages) => messages.filter((message): message is ChatMessage => message !== null));
    }

    /** A gifter's message: `count` memberships at the $5 unit price. */
    private _giftPurchase(message: ChatMessage, count: number): ChatMessage {
        message.is_subscription = true;
        message.message = count === 1
            ? `${message.username} gifted a membership!`
            : `${message.username} gifted ${count} memberships!`;
        message.currency = 'USD';
        message.amount = count * GIFT_MEMBERSHIP_USD;
        return message;
    }

    receiveChatMessages(json: YTAction[]): Promise<void> {
        return this.prepareChatMessages(json).then((data) => {
            this.sendChatMessages(data);
        });
    }

    bindEvents(): void {
        super.bindEvents();
        // YouTube is a single-page app: moving between videos fires this instead of a load.
        document.addEventListener('yt-navigate-finish', (event) => {
            void this.onNavigateFinish(event as CustomEvent<YTNavigateDetail>);
        });
    }

    async onDocumentReady(_event: Event): Promise<void> {
        this.log('Document ready, preparing to load channel information.');

        const url = new URL(window.location.href);

        if (url.pathname.includes('/live_chat')) {
            const video_id = this._chatVideoId(url);
            if (!video_id) {
                this.log('Cannot identify video ID.', { url: url.href, pathname: url.pathname });
                return;
            }
            this.log('Video ID:', video_id, 'Chat only:', true);
            await this.applyVideo(video_id, null, true);
            if (!url.pathname.includes('/live_chat_replay')) {
                this.receiveInitialChat();
            }
            return;
        }

        const video_id = YouTube._extractVideoIdFromUrl();
        if (!video_id) {
            // Home, search, a channel page...: nothing to report until a video opens.
            this.log('Not a video page.', { url: url.href, pathname: url.pathname });
            this.liveState = false;
            return;
        }

        this.log('Video ID:', video_id, 'Chat only:', false);
        await this.applyVideo(video_id, (WINDOW as YTWindow).ytInitialPlayerResponse ?? null);
    }

    /** The video id of a `live_chat` / `live_chat_replay` frame. */
    private _chatVideoId(url: URL): string | null {
        const yt = (WINDOW as unknown as YTWindow).ytInitialData;
        let video_id = url.searchParams.get('v');

        if (!video_id && yt?.continuationContents?.liveChatContinuation) {
            const chatContinuation = yt.continuationContents.liveChatContinuation;
            const menuItems = chatContinuation.header?.liveChatHeaderRenderer?.overflowMenu?.menuRenderer?.items || [];
            for (const item of menuItems) {
                const endpoint = item.menuServiceItemRenderer?.serviceEndpoint?.popoutLiveChatEndpoint;
                if (endpoint?.url) {
                    const popoutUrl = new URL(endpoint.url);
                    video_id = popoutUrl.searchParams.get('v');
                    if (video_id) break;
                }
            }

            if (!video_id) {
                const topic = chatContinuation.continuations?.[0]?.invalidationContinuationData?.invalidationId?.topic;
                if (topic) video_id = topic.split('~')[1];
            }
        } else if (!video_id && yt?.contents?.liveChatRenderer) {
            const topic = yt.contents.liveChatRenderer.continuations?.[0]?.invalidationContinuationData?.invalidationId?.topic;
            if (topic) video_id = topic.split('~')[1];
        }

        return video_id || null;
    }

    /**
     * Switch this tab to a video: reset per-video state, read its live state from the
     * player response, and resolve its channel. Updates sent while the channel is being
     * resolved queue and go out under the new channel, never the previous video's.
     */
    async applyVideo(videoId: string, playerResponse: YTPlayerResponse | null, chatOnly = false): Promise<void> {
        this.videoId = videoId;
        this.viewers = null;

        if (!chatOnly) {
            this.setLiveState(liveStateFromPlayerResponse(playerResponse ?? undefined), 'page');
            // Independent of the channel lookup below, which can fail.
            this.ensureViewCountObserver();
        }

        // The constructor already used this video's id; anything else is a previous video's channel.
        if (this.channel !== videoId) {
            this.channel = null;
        }

        const channel = await this.resolveChannel(videoId);
        if (this.videoId !== videoId) return; // navigated away while resolving

        this.setChannel(channel ?? videoId);
        this.log('Received channel info.', videoId, this.channel);
    }

    /** The channel handle or id of a video, from oembed; null when it cannot be found. */
    async resolveChannel(videoId: string): Promise<string | null> {
        let author_url: string | null = null;
        try {
            const oembedResponse = await fetch(`https://www.youtube.com/oembed?url=http%3A//youtube.com/watch%3Fv%3D${encodeURIComponent(videoId)}&format=json`);
            if (oembedResponse.ok) {
                const json = await oembedResponse.json() as YTOembedResponse;
                author_url = json.author_url;
            } else {
                this.warn('Oembed fetch failed with status:', oembedResponse.status);
            }
        } catch (e) {
            this.warn('Oembed fetch error:', e);
        }

        if (!author_url) {
            this.warn('Could not get author URL from oembed, using video_id as channel fallback');
            return null;
        }

        const channel_match = author_url.match(/(?:\/channel\/|@)([^\/]+)/);
        if (!channel_match?.[1]) {
            this.log('Could not find a channel ID in the URL. URL:', author_url);
            return null;
        }
        return channel_match[1];
    }

    /**
     * After an SPA navigation: if the video changed, clear the old live video's count
     * under its own channel, then switch to the new one. Pages without a video send nothing.
     */
    async onNavigateFinish(event: CustomEvent<YTNavigateDetail> | null): Promise<void> {
        const videoId = YouTube._extractVideoIdFromUrl();

        let playerResponse: YTPlayerResponse | null = event?.detail?.response?.playerResponse ?? null;
        if (!playerResponse) {
            const player = document.querySelector('#movie_player') as YTPlayerElement | null;
            playerResponse = player?.getPlayerResponse?.() ?? null;
        }
        // A player response for some other video says nothing about this one.
        const responseVideoId = playerResponse?.videoDetails?.videoId;
        if (responseVideoId && responseVideoId !== videoId) {
            playerResponse = null;
        }

        if (videoId === this.videoId) {
            if (videoId && playerResponse) {
                this.setLiveState(liveStateFromPlayerResponse(playerResponse), 'navigation');
            }
            return;
        }

        this.log('Navigated from', this.videoId, 'to', videoId);
        if (this.liveState === true) {
            this.sendViewerCount(0);
        }
        this.liveState = null;
        this.viewers = null;

        if (!videoId) {
            this.videoId = null;
            this.liveState = false;
            return;
        }

        await this.applyVideo(videoId, playerResponse);
    }

    /**
     * Unwrap a batch of live-chat actions (from get_live_chat or the chat frame's
     * initial data): send removals, start parsing new items, and return what was
     * added and what was not understood.
     */
    processChatActions(actions: YTAction[]): { messagesToAdd: YTAction[]; unhandledActions: YTAction[] } {
        const unhandledActions: YTAction[] = [];
        const removals: string[] = [];
        const messagesToAdd: YTAction[] = [];

        for (const action of actions) {
            if (!action || typeof action !== 'object') continue;

            if (action.addChatItemAction) {
                messagesToAdd.push(action.addChatItemAction);
            } else if (action.addLiveChatMembershipItemAction) {
                messagesToAdd.push(action.addLiveChatMembershipItemAction);
            } else if (action.replaceChatItemAction?.replacementItem) {
                // A placeholder replaced by the real item, which keeps the placeholder's id.
                messagesToAdd.push({ item: action.replaceChatItemAction.replacementItem });
            } else if (action.removeChatItemAction?.targetItemId) {
                removals.push(uuidv5(action.removeChatItemAction.targetItemId, this.namespace!));
            } else if (action.markChatItemAsDeletedAction?.targetItemId) {
                removals.push(uuidv5(action.markChatItemAsDeletedAction.targetItemId, this.namespace!));
            } else if (action.removeChatItemByAuthorAction || action.markChatItemsByAuthorAsDeletedAction) {
                const author = (action.removeChatItemByAuthorAction ?? action.markChatItemsByAuthorAsDeletedAction)!.externalChannelId;
                removals.push(...this.takeAuthorMessages(author));
            } else if (YT_IGNORED_ACTIONS.some(key => key in action)) {
                // UI-only: tickers, polls, banners, moderation prompts, replay wrappers.
            } else {
                this.log('Unknown get_live_chat action.', action);
                unhandledActions.push(action);
            }
        }

        if (removals.length > 0) {
            this.sendRemoveMessages(removals);
        }
        if (messagesToAdd.length > 0) {
            this.receiveChatMessages(messagesToAdd);
        }

        return { messagesToAdd, unhandledActions };
    }

    /** Remember which messages an author sent, so "remove all by author" can name them. */
    private trackAuthorMessage(authorChannelId: string | undefined, messageId: string): void {
        if (!authorChannelId) return;
        this._authorMessages ??= new Map();

        const ids = this._authorMessages.get(authorChannelId) ?? [];
        this._authorMessages.delete(authorChannelId); // re-insert as most recent
        if (!ids.includes(messageId)) ids.push(messageId);
        if (ids.length > MAX_IDS_PER_AUTHOR) ids.shift();
        this._authorMessages.set(authorChannelId, ids);

        if (this._authorMessages.size > MAX_TRACKED_AUTHORS) {
            const oldest = this._authorMessages.keys().next().value;
            if (oldest !== undefined) this._authorMessages.delete(oldest);
        }
    }

    /** The message ids sent for an author (forgotten afterwards). */
    private takeAuthorMessages(authorChannelId: string | undefined): string[] {
        if (!authorChannelId || !this._authorMessages) return [];
        const ids = this._authorMessages.get(authorChannelId) ?? [];
        this._authorMessages.delete(authorChannelId);
        return ids;
    }

    /**
     * The chat frame's first batch of messages is in its ytInitialData, not a fetch.
     * Replayed through the same path once the channel is known; UUIDv5 ids make any
     * overlap with the first get_live_chat poll harmless.
     */
    receiveInitialChat(): void {
        const yt = (WINDOW as unknown as YTWindow).ytInitialData;
        const actions = yt?.contents?.liveChatRenderer?.actions
            ?? yt?.continuationContents?.liveChatContinuation?.actions;
        if (!Array.isArray(actions) || actions.length === 0) return;

        this.log('Replaying', actions.length, 'initial chat actions.');
        this.processChatActions(actions);
    }

    async onFetchResponse(response: Response): Promise<void> {
        if (response.url.includes('/updated_metadata')) {
            await this._handleUpdatedMetadata(response);
            return;
        }

        if (!response.url.includes('/get_live_chat')) {
            this.recordFetchIgnored(response.url, 'GET', response.status, 'Not monitored endpoint');
            return;
        }

        // A finished stream's chat replay is history, not live chat.
        if (response.url.includes('/get_live_chat_replay')) {
            this.recordFetchIgnored(response.url, 'GET', response.status, 'Chat replay');
            return;
        }

        try {
            const json = await response.json() as YTLiveChatResponse;
            const actions = json?.continuationContents?.liveChatContinuation?.actions;

            if (!Array.isArray(actions)) {
                this.recordFetchIgnored(response.url, 'GET', response.status, 'No actions in response');
                return;
            }

            const { messagesToAdd, unhandledActions } = this.processChatActions(actions);

            // Record the fetch with parsed data
            this.recordFetchHandled(response.url, 'GET', response.status, json, {
                actionCount: actions.length,
                messagesAdded: messagesToAdd.length,
                unhandledCount: unhandledActions.length,
                unhandledActions: unhandledActions
            });
        } catch (error) {
            this.warn('Failed to process live chat response:', error);
            this.recorder.record('fetch_response', {
                url: response.url,
                method: 'GET',
                statusCode: response.status,
                payload: (error as Error).message
            }, EventStatus.ERROR, null, (error as Error).message);
        }
    }

    /**
     * Handle /updated_metadata endpoint responses for live viewer counts
     */
    private async _handleUpdatedMetadata(response: Response): Promise<void> {
        try {
            const json = await response.json() as YTUpdatedMetadataResponse;
            const actions = Array.isArray(json?.actions) ? json.actions : null;
            const mutations = json?.frameworkUpdates?.entityBatchUpdate?.mutations;
            const entity = Array.isArray(mutations)
                ? mutations.find(mutation => mutation?.payload?.viewCountEntity)?.payload?.viewCountEntity
                : undefined;

            if (!actions && !entity) {
                this.recordFetchIgnored(response.url, 'POST', response.status, 'No view count in updated_metadata');
                return;
            }

            let viewerCount: number | null = null;
            let live: boolean | null = null;
            const renderer = actions
                ?.find(action => action?.updateViewershipAction)
                ?.updateViewershipAction?.viewCount?.videoViewCountRenderer;

            if (renderer) {
                // Only a live stream carries isLive; a video or a finished stream
                // reports its total views, which are not viewers.
                live = renderer.isLive === true;
                this.setLiveState(live, 'updated_metadata');
                if (live) viewerCount = viewerCountFromRenderer(renderer);
            } else if (entity) {
                // The entity has no isLive: trust it only once the page says live.
                live = this.liveState;
                if (live === true) viewerCount = viewerCountFromEntity(entity);
            }

            // Sent on every poll, changed or not: the poll is the live tab's heartbeat.
            if (viewerCount !== null) this.sendViewerCount(viewerCount);

            this.recordFetchHandled(response.url, 'POST', response.status, json, {
                actionCount: actions?.length ?? 0,
                live,
                viewerCount,
            });
        } catch (error) {
            this.warn('Failed to process updated_metadata response:', error);
            this.recorder.record('fetch_response', {
                url: response.url,
                method: 'POST',
                statusCode: response.status,
                payload: (error as Error).message
            }, EventStatus.ERROR, null, (error as Error).message);
        }
    }

    /**
     * Observe the watch page's `#view-count` label. One observer is kept for the
     * tab; when YouTube replaces the element it is re-queried and re-attached.
     * The label is a fallback for `updated_metadata`, which is the main source.
     */
    ensureViewCountObserver(): void {
        if (this._viewCountElem?.isConnected) return;

        const elem = document.querySelector('#view-count');
        if (elem) {
            this._viewCountObserver ??= new MutationObserver(this.onViewCountChange.bind(this));
            this._viewCountObserver.disconnect();
            this._viewCountObserver.observe(elem, {
                attributes: true,
                attributeFilter: ['aria-label'],
                characterData: false,
                childList: false,
                subtree: false
            });
            this._viewCountElem = elem;
        }

        // Keep checking: the element may not exist yet, or may be swapped out later.
        this._viewCountTimer ??= setInterval(() => this.ensureViewCountObserver(), 2000);
    }

    onViewCountChange(mutationsList: MutationRecord[], _observer: MutationObserver | null): void {
        // On a video or a finished stream this label is the total view count.
        if (this.liveState !== true) return;

        // YouTube sets the label several times per change; read the element once.
        const target = mutationsList.at(-1)?.target as Element | undefined;
        const label = target?.getAttribute?.('aria-label');
        if (!label) return;

        const digits = label.replace(/[^\d]/g, '');
        if (digits.length === 0) return;
        const viewers = parseInt(digits, 10);
        if (!Number.isFinite(viewers) || viewers === this.viewers) return;

        this.sendViewerCount(viewers);
    }
}

export default YouTube;
