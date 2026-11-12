/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Kick.com platform scraper
 *
 * Transport
 * ---------
 * Kick negotiates its realtime transport through a "realtime descriptor":
 *   POST https://web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection
 *   -> {"data":{"connections":[{"credentials":{"url":"wss://realtime.<region>.platform.kick.com/connection/websocket"},
 *                              "provider":"centrifugo"}],"mode":"websocket"}}
 *
 * Two providers are compiled into the site bundle and both must be supported:
 *
 * 1. Centrifugo (current default), JSON protocol v2 on
 *    `wss://realtime.<region>.platform.kick.com/connection/websocket`:
 *      {"push":{"channel":"chatrooms.123.v2","pub":{"data":{"event":"App\\Events\\ChatMessageEvent",
 *                                                          "data":"<json string>"}}}}
 *    `pub.data.data` is usually a JSON string but may be an object. A single frame may
 *    carry several newline-separated JSON objects (batching). `{}` is a ping/pong and
 *    `{"id":n,...}` is a command reply.
 * 2. Pusher (fallback), the historical envelope:
 *      {"event":"App\\Events\\ChatMessageEvent","data":"<json string>","channel":"chatrooms.123.v2"}
 *
 * A third socket, `wss://websockets.kick.com/viewer/v1/connect`, carries only presence
 * and analytics noise ({"type":"ping"}, "channel_handshake", ...) and is ignored.
 *
 * All envelopes are normalized by `Kick.normalizeFrame` into `{channel, event, data}`
 * records and dispatched through the single `handleEvent` method.
 *
 * Features:
 * - Capture new messages (message / reply / celebration)
 * - Capture chat history via REST
 * - Capture emotes, badges, paid messages, Kicks gifts and gifted subscriptions
 * - Capture view counts
 */

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';
import type { PatchedWebSocket } from '../core/index.js';

//
// Types
//

interface KickBadge {
    type?: string;
}

interface KickSender {
    id?: number | string;
    username?: string;
    profile_picture?: string;
    identity?: {
        badges?: KickBadge[];
    };
}

interface KickGift {
    amount?: number;
    name?: string;
    gift_id?: string;
}

interface KickChatMessageData {
    id?: string;
    content?: string;
    type?: string;
    created_at?: string;
    chatroom_id?: number;
    chat_id?: number;
    sender?: KickSender;
    gift?: KickGift;
    metadata?: unknown;
}

interface KickCelebrationMetadata {
    celebration?: { type?: string };
}

interface KickKicksGiftedData {
    gift_transaction_id?: string;
    message?: string;
    created_at?: string;
    /** Pinned gifts only: created_at + 2 h for HIGHER tier, + 10 min for MID. */
    expires_at?: string;
    sender?: KickSender;
    gift?: KickGift;
}

/** `KicksGiftedDeleted` on `channel_{id}`; note the field is spelled `gifted_`. */
interface KickKicksGiftedDeletedData {
    gifted_transaction_id?: string;
}

interface KickDeletedMessageData {
    message?: { id?: string };
    aiModerated?: boolean;
    violatedRules?: string[];
}

interface KickGiftedSubsLegacy {
    chatroom_id?: number;
    correlation_id?: string;
    gifter_username?: string;
    gifted_usernames?: string[];
    gifted_total?: number;
    gifter_total?: number;
    chunk_details?: { correlation_id?: string; chunk_index?: number; total_chunks?: number } | null;
}

interface KickGiftedSubsModern {
    id?: string;
    user?: { id?: number; slug?: string; username?: string };
    gift?: { tier?: number };
    gifted_users?: { id?: number; slug?: string; username?: string }[];
    created_at?: string;
}

interface KickSubscriptionData {
    id?: string | number;
    username?: string;
    months?: number;
    created_at?: string;
}

interface KickLivestreamUpdatedData {
    viewers?: number | string;
}

interface KickChannelInfo {
    id?: number;
    slug?: string;
    chatroom?: { id?: number };
    livestream?: { id?: number; viewer_count?: number; viewers?: number } | null;
}

interface KickMessagesResponse {
    data?: { messages?: KickChatMessageData[] };
}

/** `GET web.kick.com/api/v1/kicks/{channelId}/pinned-gifts`: same gift shape as `KicksGifted`. */
interface KickPinnedGiftsResponse {
    data?: { pinned_gifts?: KickKicksGiftedData[] };
}

interface KickViewersEntry {
    livestream_id?: number;
    viewers?: number;
}

/** `GET web.kick.com/api/v1/channels/{slug}/livestream`; `id` is a UUID, not the numeric id. */
interface KickLivestreamResponse {
    data?: { livestream?: { id?: string } | null };
}

/** `GET web.kick.com/api/v1/livestreams/{uuid}/viewer-count`. */
interface KickViewerCountResponse {
    data?: { show_view_count?: boolean; viewer_count?: number };
}

/** A single decoded realtime event, provider-independent. */
export interface KickEvent {
    kind: 'event';
    channel: string | null;
    event: string;
    data: unknown;
}

/** A frame that was understood but carries nothing we want. */
export interface KickIgnoredFrame {
    kind: 'ignored';
    event: string | null;
    reason: string;
}

/** A frame we could not make sense of. */
export interface KickUnknownFrame {
    kind: 'unhandled';
    event: string | null;
    reason: string;
}

export type KickFrame = KickEvent | KickIgnoredFrame | KickUnknownFrame;

/** What `handleEvent` decided to do with an event. */
export interface KickEventOutcome {
    status: 'handled' | 'ignored' | 'unhandled';
    parsed?: unknown;
    reason?: string;
}

/** Channel scope encoded in a Centrifugo/Pusher channel name. */
export interface KickScope {
    chatroomId: number | null;
    channelId: number | null;
}

//
// Constants
//

const EVENT = {
    CHAT_MESSAGE: 'App\\Events\\ChatMessageEvent',
    MESSAGE_DELETED: 'App\\Events\\MessageDeletedEvent',
    SUBSCRIPTION: 'App\\Events\\SubscriptionEvent',
    GIFTED_SUBS: 'GiftedSubscriptionsEvent',
    GIFTED_SUBS_PREFIXED: 'App\\Events\\GiftedSubscriptionsEvent',
    SUBSCRIPTION_GIFTED: 'SubscriptionGifted',
    KICKS_GIFTED: 'KicksGifted',
    KICKS_GIFTED_DELETED: 'KicksGiftedDeleted',
    LIVESTREAM_UPDATED: 'App\\Events\\LivestreamUpdated',
    UPDATED_LIVESTREAM: 'App\\Events\\UpdatedLiveStreamEvent',
} as const;

/** Events we recognize but deliberately do nothing with. */
const IGNORED_EVENTS: ReadonlySet<string> = new Set([
    'App\\Events\\ChatroomClearEvent',
    'App\\Events\\ChatroomUpdatedEvent',
    'App\\Events\\ChannelSubscriptionEvent',
    'App\\Events\\ChatMessageSentEvent',
    'App\\Events\\FollowersUpdated',
    'App\\Events\\GiftsLeaderboardUpdated',
    'App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent',
    'App\\Events\\PinnedMessageCreatedEvent',
    'App\\Events\\PinnedMessageDeletedEvent',
    'App\\Events\\StreamHostedEvent',
    'App\\Events\\UserBannedEvent',
    'App\\Events\\UserUnbannedEvent',
    'ChatSettingsChanged',
    'GiftsLeaderboardUpdated',
    'GoalAchievedEvent',
    'GoalCanceledEvent',
    'GoalProgressUpdateEvent',
    'GoalUpdatedEvent',
    'KicksLeaderboardUpdated',
    'PointsUpdated',
    'RewardRedeemedEvent',
    'pusher:connection_established',
    'pusher:error',
    'pusher:ping',
    'pusher:pong',
    'pusher:subscribe',
    'pusher:unsubscribe',
    'pusher_internal:subscription_succeeded',
]);

/** Role badges that map to no CHUCK flag. */
const COSMETIC_BADGES: ReadonlySet<string> = new Set(['vip', 'og', 'founder', 'bot']);

/** Kick tier 1 subscription is $4.99; SNEED wants a round USD value. */
const SUBSCRIPTION_VALUE_USD = 5;

/** Kicks are platform currency; SNEED converts at 0.01 USD/Kick. */
const KICKS_CURRENCY = 'KICKS';

/** How long a sent gift is remembered without `expires_at`; the longest pin is 2 h. */
const GIFT_MEMORY_MS = 2 * 60 * 60 * 1000;
/** Floor on a remembered gift's lifetime, absorbing clock skew against `expires_at`. */
const GIFT_MEMORY_MIN_MS = 10 * 60 * 1000;
/** sessionStorage key prefix for sent gift ids, followed by the channel slug. */
const SENT_GIFTS_KEY = 'chuck:kick:sent-gifts:';

const EMOTE_PATTERN =/\[emote:(\d+):([^\]]+)\]/g;
/** RFC 9562 versions 1-8: livestream ids are UUIDv7. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

//
// Small pure helpers
//

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Parse a value that may already be an object, a JSON string, or garbage. */
function decodePayload(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toFiniteNumber(value: unknown): number | null {
    const n = typeof value === 'string' ? parseInt(value, 10) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Timestamp of an ISO date, falling back to now for missing/invalid input. */
function parseTimestamp(value: unknown): number {
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now();
}

/** When a sent gift can be forgotten: once Kick has stopped serving it as pinned. */
function giftExpiry(gift: KickKicksGiftedData | null): number {
    const now = Date.now();
    let expiry = typeof gift?.expires_at === 'string' ? Date.parse(gift.expires_at) : NaN;
    if (Number.isNaN(expiry) && typeof gift?.created_at === 'string') {
        expiry = Date.parse(gift.created_at) + GIFT_MEMORY_MS;
    }
    if (Number.isNaN(expiry)) expiry = now + GIFT_MEMORY_MS;
    return Math.max(expiry, now + GIFT_MEMORY_MIN_MS);
}

/** The page's sessionStorage, or null where it is missing or blocked. */
function sessionStore(): Storage | null {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
        return null;
    }
}

/** `metadata` is an object on the socket and a JSON string over REST. */
function readMetadata(value: unknown): Record<string, unknown> | null {
    const decoded = decodePayload(value);
    return isRecord(decoded) ? decoded : null;
}

/** Extract the chatroom/channel id encoded in a realtime channel name. */
export function parseChannelScope(channel: string | null): KickScope {
    const scope: KickScope = { chatroomId: null, channelId: null };
    if (typeof channel !== 'string') return scope;

    // chatrooms.123.v2 | chatrooms.123 | chatroom_123
    const chatroom = /^chatrooms?[._](\d+)/.exec(channel);
    if (chatroom) {
        scope.chatroomId = parseInt(chatroom[1], 10);
        return scope;
    }

    // channel_123 | channel.123
    const chan = /^channel[._](\d+)/.exec(channel);
    if (chan) scope.channelId = parseInt(chan[1], 10);

    return scope;
}

/**
 * Channel slug for a kick.com pathname.
 * Normal watch pages are `/{slug}` or `/{slug}/videos`; the popout chat lives at
 * `/popout/{slug}/chat`. Query strings (Next.js appends `?_rsc=`) are not part of
 * a pathname, so callers should pass `location.pathname`, never `location.href`.
 */
export function channelSlugFromPath(pathname: string | null | undefined): string | null {
    if (typeof pathname !== 'string') return null;

    const segments = pathname.split('/').filter(segment => segment.length > 0);
    const slug = segments[0] === 'popout' ? segments[1] : segments[0];

    return typeof slug === 'string' && slug.length > 0 ? slug.toLowerCase() : null;
}

/** How often CHUCK checks the viewer count itself; see `pollViewers`. */
export const VIEWER_POLL_MS = 60_000;

export class Kick extends Seed {
    static hostname = 'kick.com';
    static namespace = '6efe7271-da75-4c2f-93fc-ddf37d02b8a9';

    /** Numeric channel id, from REST channel info or a `channel_{id}` subscription. */
    channel_id: number | null = null;
    /** Chatroom id, from REST channel info or a `chatrooms.{id}.v2` subscription. */
    chatroom_id: number | null = null;
    livestream_id: number | null = null;
    /**
     * UUID of the current livestream, distinct from the numeric `livestream_id`.
     * The page polls `/api/v1/livestreams/{uuid}/viewer-count` with it.
     */
    livestream_uuid: string | null = null;

    /** True once REST channel info landed; REST ids outrank learned ones. */
    private idsFromRest = false;
    /** Badge types we have already complained about, to keep the console quiet. */
    private unknownBadges = new Set<string>();
    /** Kicks gifts already sent, id -> expiry ms; see `markGiftSeen`. Lazily loaded. */
    private sentGiftIds?: Map<string, number>;
    /** Channel slug `sentGiftIds` was loaded for. */
    private sentGiftsChannel?: string | null;

    constructor() {
        super(Kick.namespace, 'Kick', channelSlugFromPath(window.location.pathname)!);
        // The home page has no channel; a later client-side navigation bootstraps one.
        if (this.channel !== null) void this.fetchChatHistory();
        setInterval(() => void this.pollViewers(), VIEWER_POLL_MS);
    }

    //
    // Envelope normalization
    //

    /**
     * Turn one raw websocket frame into zero or more classified records.
     * Never throws, whatever the input.
     */
    static normalizeFrame(raw: unknown): KickFrame[] {
        if (isRecord(raw)) return [Kick.classifyFrame(raw)];

        if (typeof raw !== 'string') {
            return [{ kind: 'ignored', event: null, reason: 'Non-text frame' }];
        }

        const lines = raw.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) {
            return [{ kind: 'ignored', event: null, reason: 'Empty frame' }];
        }

        return lines.map((line): KickFrame => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                return { kind: 'unhandled', event: null, reason: 'Frame is not JSON' };
            }
            if (!isRecord(parsed)) {
                return { kind: 'ignored', event: null, reason: 'Frame is not a JSON object' };
            }
            return Kick.classifyFrame(parsed);
        });
    }

    /** Classify one already-parsed frame object. */
    private static classifyFrame(frame: Record<string, unknown>): KickFrame {
        if (Object.keys(frame).length === 0) {
            return { kind: 'ignored', event: null, reason: 'Centrifugo heartbeat' };
        }

        // Centrifugo push
        if (isRecord(frame.push)) {
            const push = frame.push;
            const channel = typeof push.channel === 'string' ? push.channel : null;
            const pub = isRecord(push.pub) ? push.pub : null;
            const payload = pub && isRecord(pub.data) ? pub.data : null;

            if (payload && typeof payload.event === 'string') {
                return {
                    kind: 'event',
                    channel,
                    event: payload.event,
                    data: decodePayload(payload.data),
                };
            }

            const pushKind = Object.keys(push).find(key => key !== 'channel') ?? 'unknown';
            return { kind: 'ignored', event: null, reason: `Centrifugo push: ${pushKind}` };
        }

        // Pusher envelope
        if (typeof frame.event === 'string') {
            return {
                kind: 'event',
                channel: typeof frame.channel === 'string' ? frame.channel : null,
                event: frame.event,
                data: decodePayload(frame.data),
            };
        }

        // Viewer/presence socket
        if (typeof frame.type === 'string') {
            return { kind: 'ignored', event: frame.type, reason: 'Viewer socket frame' };
        }

        // Centrifugo command or reply
        if (typeof frame.id === 'number') {
            return { kind: 'ignored', event: null, reason: 'Centrifugo command/reply' };
        }

        return { kind: 'unhandled', event: null, reason: 'Unknown frame shape' };
    }

    /** Channel names this outbound frame subscribes to (Centrifugo or Pusher). */
    static extractSubscribeChannels(raw: unknown): string[] {
        const channels: string[] = [];

        for (const frame of Kick.normalizeFrame(raw)) {
            // Pusher: {"event":"pusher:subscribe","data":{"channel":"chatrooms.123.v2"}}
            if (frame.kind === 'event' && frame.event === 'pusher:subscribe') {
                const data = frame.data;
                if (isRecord(data) && typeof data.channel === 'string') channels.push(data.channel);
            }
        }

        // Centrifugo: {"id":1,"subscribe":{"channel":"chatrooms.123.v2"}} (possibly batched)
        if (typeof raw === 'string') {
            for (const line of raw.split('\n')) {
                if (line.trim().length === 0) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }
                if (isRecord(parsed) && isRecord(parsed.subscribe) && typeof parsed.subscribe.channel === 'string') {
                    channels.push(parsed.subscribe.channel);
                }
            }
        }

        return channels;
    }

    //
    // Event dispatch
    //

    /**
     * Single entry point for every realtime event, whatever provider delivered it.
     * Returns how the event was treated so the caller can record it.
     */
    handleEvent(channel: string | null, event: string, data: unknown): KickEventOutcome {
        const scope = parseChannelScope(channel);

        switch (event) {
            case EVENT.CHAT_MESSAGE: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another chatroom' };
                }
                if (!isRecord(data)) {
                    return { status: 'unhandled', reason: 'Chat message payload is not an object' };
                }
                const json = data as KickChatMessageData;
                // Without a real id we would invent one and send a blank message.
                if (typeof json.id !== 'string') {
                    return { status: 'unhandled', reason: 'Chat message without an id' };
                }
                const message = this.prepareChatMessage(json);
                this.sendChatMessages([message]);
                return { status: 'handled', parsed: json };
            }

            case EVENT.MESSAGE_DELETED: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another chatroom' };
                }
                const json = isRecord(data) ? data as KickDeletedMessageData : {};
                const deletedId = json.message?.id;
                if (typeof deletedId !== 'string' || deletedId.length === 0) {
                    return { status: 'unhandled', reason: 'MessageDeletedEvent without message id' };
                }
                // Removed regardless of who deleted it: the overlay must match the site.
                this.sendRemoveMessages([this.messageId(deletedId)]);
                return { status: 'handled', parsed: json };
            }

            case EVENT.SUBSCRIPTION: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another chatroom' };
                }
                const json = isRecord(data) ? data as KickSubscriptionData : {};
                if (typeof json.username !== 'string') {
                    return { status: 'unhandled', reason: 'SubscriptionEvent without username' };
                }
                const months = toFiniteNumber(json.months) ?? 1;
                // A stable id lets SNEED drop a repeated delivery; the clock is the last resort.
                const hasId = (typeof json.id === 'string' && json.id.length > 0) || typeof json.id === 'number';
                const id = hasId
                    ? `subscription:${json.id}`
                    : `subscription:${json.username}:${months}:${typeof json.created_at === 'string' ? json.created_at : Date.now()}`;
                this.receiveSubscriptions({
                    id,
                    gifted: false,
                    buyer: json.username,
                    count: months,
                    value: SUBSCRIPTION_VALUE_USD,
                });
                return { status: 'handled', parsed: json };
            }

            case EVENT.GIFTED_SUBS:
            case EVENT.GIFTED_SUBS_PREFIXED:
            case EVENT.SUBSCRIPTION_GIFTED: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another chatroom' };
                }
                return this.handleGiftedSubscriptions(data);
            }

            case EVENT.KICKS_GIFTED: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another channel' };
                }
                if (!isRecord(data)) {
                    return { status: 'unhandled', reason: 'Kicks gift payload is not an object' };
                }
                const json = data as KickKicksGiftedData;
                const gift = this.prepareKicksGiftedMessage(json);
                if (!this.markGiftSeen(gift.id, giftExpiry(json))) {
                    return { status: 'ignored', reason: 'Kicks gift already sent (pinned-gifts recovery)' };
                }
                this.sendChatMessages([gift]);
                return { status: 'handled', parsed: json };
            }

            case EVENT.KICKS_GIFTED_DELETED: {
                if (!this.inScope(scope)) {
                    return { status: 'ignored', reason: 'Event for another channel' };
                }
                const json = isRecord(data) ? data as KickKicksGiftedDeletedData : {};
                const id = json.gifted_transaction_id;
                if (!isUuid(id)) {
                    return { status: 'unhandled', reason: 'KicksGiftedDeleted without gifted_transaction_id' };
                }
                // Gift ids are the transaction ids; a later pinned-gifts copy must not revive it.
                this.markGiftSeen(id);
                this.sendRemoveMessages([id]);
                return { status: 'handled', parsed: json };
            }

            case EVENT.LIVESTREAM_UPDATED:
            case EVENT.UPDATED_LIVESTREAM: {
                const json = isRecord(data) ? data as KickLivestreamUpdatedData : {};
                const viewers = toFiniteNumber(json.viewers);
                if (viewers === null) {
                    return { status: 'unhandled', reason: 'Livestream update without viewers' };
                }
                this.sendViewerCount(viewers);
                return { status: 'handled', parsed: { viewers } };
            }

            default:
                if (IGNORED_EVENTS.has(event)) {
                    return { status: 'ignored', reason: 'Known event - intentionally ignored' };
                }
                this.log('Unknown realtime event.', event);
                return { status: 'unhandled', reason: 'Unknown event' };
        }
    }

    /** Gifted subscriptions arrive in three shapes; all three are supported. */
    private handleGiftedSubscriptions(data: unknown): KickEventOutcome {
        if (!isRecord(data)) {
            return { status: 'unhandled', reason: 'Gifted subscriptions payload is not an object' };
        }

        const modern = data as KickGiftedSubsModern;
        if (isRecord(modern.user) && Array.isArray(modern.gifted_users)) {
            const buyer = modern.user.username;
            if (typeof buyer !== 'string') {
                return { status: 'unhandled', reason: 'Gifted subscriptions without gifter' };
            }
            this.receiveSubscriptions({
                id: modern.id ?? `gift:${buyer}:${modern.created_at ?? Date.now()}`,
                gifted: true,
                buyer,
                count: modern.gifted_users.length,
                value: SUBSCRIPTION_VALUE_USD,
            });
            return { status: 'handled', parsed: modern };
        }

        const legacy = data as KickGiftedSubsLegacy;
        if (typeof legacy.gifter_username === 'string') {
            const buyer = legacy.gifter_username;
            const usernames = Array.isArray(legacy.gifted_usernames) ? legacy.gifted_usernames : [];
            // `gifted_total` covers the whole drop even when it is delivered in chunks,
            // and chunks share `correlation_id`, so every chunk produces the same id and
            // SNEED collapses them into one announcement.
            const count = toFiniteNumber(legacy.gifted_total) ?? usernames.length;
            const correlation = legacy.correlation_id ?? legacy.chunk_details?.correlation_id;
            this.receiveSubscriptions({
                id: correlation ?? `gift:${buyer}:${Date.now()}`,
                gifted: true,
                buyer,
                count,
                value: SUBSCRIPTION_VALUE_USD,
            });
            return { status: 'handled', parsed: legacy };
        }

        this.warn('Unknown gifted subscription format', data);
        return { status: 'unhandled', reason: 'Unknown gifted subscription format' };
    }

    //
    // Parsers
    //

    /** SNEED requires UUID message ids; pass native ones through, hash the rest. */
    messageId(id: unknown): string {
        if (isUuid(id)) return id;
        const name = typeof id === 'string' && id.length > 0 ? id : `kick:${Date.now()}:${Math.random()}`;
        return uuidv5(name, Kick.namespace);
    }

    prepareChatMessage(json: KickChatMessageData): ChatMessage {
        const message = new ChatMessage(this.messageId(json.id), this.platform!, this.channel!);
        message.sent_at = parseTimestamp(json.created_at);
        message.username = json.sender?.username ?? 'Unknown';
        message.avatar = json.sender?.profile_picture ?? message.avatar;
        message.message = typeof json.content === 'string' ? json.content : '';

        // Celebrations (e.g. a renewed subscription) usually carry no text of their own.
        if (json.type === 'celebration' && message.message.length === 0) {
            const metadata = readMetadata(json.metadata) as KickCelebrationMetadata | null;
            const kind = metadata?.celebration?.type;
            message.message = kind
                ? `${message.username} celebrated: ${kind.replace(/_/g, ' ')}`
                : `${message.username} celebrated!`;
        }

        // Paid chat messages carry the amount in cents.
        const cents = toFiniteNumber(json.gift?.amount);
        if (cents !== null && cents > 0) {
            message.amount = cents / 100;
            message.currency = 'USD';
        }

        // Emotes are supplied as bbcode: [emote:37221:EZ]
        for (const match of message.message.matchAll(EMOTE_PATTERN)) {
            message.emojis.push([match[0], `https://files.kick.com/emotes/${match[1]}/fullsize`, match[2]]);
        }

        this.applyBadges(message, json.sender?.identity?.badges);
        return message;
    }

    /** Role flags come from `identity.badges[].type`; `badges_v2` is purely cosmetic. */
    private applyBadges(message: ChatMessage, badges: KickBadge[] | undefined): void {
        if (!Array.isArray(badges)) return;

        for (const badge of badges) {
            const type = badge?.type;
            if (typeof type !== 'string') continue;

            switch (type) {
                case 'broadcaster':
                    message.is_owner = true;
                    break;
                case 'moderator':
                    message.is_mod = true;
                    break;
                case 'verified':
                    message.is_verified = true;
                    break;
                case 'subscriber':
                case 'sub_gifter':
                    message.is_sub = true;
                    break;
                default:
                    if (COSMETIC_BADGES.has(type)) break;
                    if (!this.unknownBadges.has(type)) {
                        this.unknownBadges.add(type);
                        this.log(`Unknown badge type: ${type}`);
                    }
                    break;
            }
        }
    }

    /**
     * Kicks are Kick's platform currency, gifted through the `KicksGifted` event.
     * BASIC tier gifts carry no message text; LEVEL_UP gifts do.
     */
    prepareKicksGiftedMessage(json: KickKicksGiftedData): ChatMessage {
        const fallbackName = `kicks:${json.sender?.id ?? 'unknown'}:${json.created_at ?? Date.now()}:${json.gift?.gift_id ?? 'unknown'}`;
        const id = isUuid(json.gift_transaction_id) ? json.gift_transaction_id : this.messageId(fallbackName);

        const message = new ChatMessage(id, this.platform!, this.channel!);
        message.sent_at = parseTimestamp(json.created_at);
        message.username = json.sender?.username ?? 'Unknown';
        message.avatar = json.sender?.profile_picture ?? message.avatar;
        message.message = (typeof json.message === 'string' && json.message.length > 0)
            ? json.message
            : `Sent a ${json.gift?.name ?? 'Kick'}!`;
        message.amount = toFiniteNumber(json.gift?.amount) ?? 0;
        message.currency = KICKS_CURRENCY;

        return message;
    }

    //
    // Channel / history bootstrap
    //

    /** True when an event's channel scope belongs to the stream we are watching. */
    private inScope(scope: KickScope): boolean {
        if (scope.chatroomId !== null && this.chatroom_id !== null) {
            return scope.chatroomId === this.chatroom_id;
        }
        if (scope.channelId !== null && this.channel_id !== null) {
            return scope.channelId === this.channel_id;
        }
        return true;
    }

    /**
     * Kick is a Next.js app: moving to another channel replaces the chat without a
     * page load. When the slug in the address bar no longer matches, forget every
     * learned id and re-bootstrap against the new channel.
     */
    private checkForNavigation(): void {
        const slug = channelSlugFromPath(window.location.pathname);
        if (slug === null || slug === this.channel) return;

        this.log(`Channel changed: ${this.channel} -> ${slug}`);
        this.channel_id = null;
        this.chatroom_id = null;
        this.livestream_id = null;
        this.livestream_uuid = null;
        this.idsFromRest = false;
        this.setChannel(slug);
        void this.fetchChatHistory();
    }

    /** Learn ids from an outbound subscribe frame; REST info always wins. */
    private learnScope(channel: string): void {
        if (this.idsFromRest) return;

        const scope = parseChannelScope(channel);
        if (scope.chatroomId !== null && this.chatroom_id === null) {
            this.chatroom_id = scope.chatroomId;
            this.log('Learned chatroom id from subscription:', scope.chatroomId);
        }
        if (scope.channelId !== null && this.channel_id === null) {
            this.channel_id = scope.channelId;
            this.log('Learned channel id from subscription:', scope.channelId);
        }
    }

    /**
     * Apply a REST channel-info payload; these ids outrank learned ones.
     * Rejects anything that is not this channel's own record, because
     * `/api/v2/channels/followed` and friends share the same URL prefix.
     */
    private applyChannelInfo(info: KickChannelInfo): boolean {
        if (typeof info !== 'object' || info === null) return false;

        const channelId = toFiniteNumber(info.id);
        if (channelId === null) return false;

        if (typeof info.slug === 'string' && this.channel !== null
            && info.slug.toLowerCase() !== this.channel.toLowerCase()) {
            this.log('Ignoring channel info for another channel:', info.slug);
            return false;
        }

        this.channel_id = channelId;
        const chatroomId = toFiniteNumber(info.chatroom?.id);
        if (chatroomId !== null) this.chatroom_id = chatroomId;
        this.idsFromRest = true;

        // Only a payload that actually carries a livestream may clear the id.
        if ('livestream' in info) {
            const livestreamId = toFiniteNumber(info.livestream?.id);
            // The UUID belongs to one livestream; a new or ended stream invalidates it.
            if (livestreamId !== this.livestream_id) this.livestream_uuid = null;
            const ended = this.livestream_id !== null && livestreamId === null;
            this.livestream_id = livestreamId;
            // Nothing else would ever replace the last count of a stream that is over.
            if (ended) this.sendViewerCount(0);
        }

        const viewers = toFiniteNumber(info.livestream?.viewer_count ?? info.livestream?.viewers);
        if (viewers !== null) this.sendViewerCount(viewers);

        return true;
    }

    /** True when a URL path is this channel's own `/api/v2/channels/{slug|id}` record. */
    private isChannelInfoPath(pathname: string): boolean {
        const match = /^\/api\/v2\/channels\/([^/]+)$/.exec(pathname);
        if (match === null) return false;

        const segment = decodeURIComponent(match[1]).toLowerCase();
        return segment === this.channel?.toLowerCase() || segment === String(this.channel_id);
    }

    /**
     * Fetch and apply this channel's REST record; false when that failed.
     * While live, also learns the livestream UUID the viewer-count endpoint needs.
     */
    async fetchChannelInfo(): Promise<boolean> {
        // Without a slug this would request `/api/v2/channels/null`.
        if (this.channel === null) return false;

        try {
            const response = await fetch(`https://kick.com/api/v2/channels/${this.channel}`);
            this.applyChannelInfo(await response.json() as KickChannelInfo);
        } catch (error) {
            this.error('Failed to fetch channel info.', error);
            return false;
        }

        if (this.livestream_id !== null && this.livestream_uuid === null) {
            await this.fetchLivestreamUuid();
        }
        return true;
    }

    /** Learn the livestream UUID from `web.kick.com/api/v1/channels/{slug}/livestream`. */
    async fetchLivestreamUuid(): Promise<void> {
        try {
            const response = await fetch(`https://web.kick.com/api/v1/channels/${this.channel}/livestream`);
            this.receiveLivestream(await response.json());
        } catch (error) {
            this.error('Failed to fetch livestream.', error);
        }
    }

    /** Apply a `/api/v1/channels/{slug}/livestream` payload; returns the UUID learned. */
    receiveLivestream(json: unknown): string | null {
        const data = isRecord(json) ? (json as KickLivestreamResponse).data : undefined;
        if (!isRecord(data) || !('livestream' in data)) return null;

        const id = data.livestream?.id;
        this.livestream_uuid = isUuid(id) ? id : null;
        return this.livestream_uuid;
    }

    /** True when a URL path is this channel's `/api/v1/channels/{slug}/livestream`. */
    private isLivestreamPath(pathname: string): boolean {
        const match = /^\/api\/v1\/channels\/([^/]+)\/livestream$/.exec(pathname);
        return match !== null && decodeURIComponent(match[1]).toLowerCase() === this.channel?.toLowerCase();
    }

    /** Fetch channel info, then replay existing chat history oldest-first. */
    async fetchChatHistory(): Promise<void> {
        if (!await this.fetchChannelInfo()) return;

        if (this.channel_id === null) {
            this.warn('No channel id; skipping chat history.');
            return;
        }

        // Independent of the history request: paid gifts sent before the page loaded.
        void this.fetchPinnedGifts();

        try {
            const response = await fetch(`https://kick.com/api/v2/channels/${this.channel_id}/messages`);
            const json = await response.json() as KickMessagesResponse;
            const messages = json?.data?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                this.log('No chat history available.');
                return;
            }

            // The endpoint returns newest first; the overlay wants oldest first.
            const prepared = messages.slice().reverse().map(entry => this.prepareChatMessage(entry));
            this.log(`Fetched ${prepared.length} history messages.`);
            this.sendChatMessages(prepared);
        } catch (error) {
            this.error('Failed to fetch chat history.', error);
        }
    }

    /**
     * Recover Kicks gifts sent before the page loaded. The history endpoint carries
     * only chat, but LEVEL_UP and higher gifts stay pinned for minutes to hours and
     * Kick serves them from this endpoint; BASIC gifts are never pinned.
     */
    async fetchPinnedGifts(): Promise<void> {
        if (this.channel_id === null) return;
        try {
            const response = await fetch(`https://web.kick.com/api/v1/kicks/${this.channel_id}/pinned-gifts`);
            this.receivePinnedGifts(await response.json());
        } catch (error) {
            this.error('Failed to fetch pinned gifts.', error);
        }
    }

    /** Send every not-yet-seen pinned gift; returns how many were sent. */
    receivePinnedGifts(json: unknown): number {
        const data = isRecord(json) ? (json as KickPinnedGiftsResponse).data : undefined;
        const gifts = Array.isArray(data?.pinned_gifts) ? data.pinned_gifts : [];

        const messages = gifts
            .filter(isRecord)
            .map(gift => gift as KickKicksGiftedData)
            .map(gift => ({ gift, message: this.prepareKicksGiftedMessage(gift) }))
            .filter(({ gift, message }) => this.markGiftSeen(message.id, giftExpiry(gift)))
            .map(({ message }) => message);

        if (messages.length > 0) {
            this.log(`Recovered ${messages.length} pinned Kicks gift(s).`);
            this.sendChatMessages(messages);
        }
        return messages.length;
    }

    /**
     * A gift can reach us up to three times: our own pinned-gifts fetch, the page's
     * copy of that fetch, and the live `KicksGifted` event. Pinned gifts also come
     * back on every reload for up to two hours, and each copy replays the overlay's
     * paid alert, so a paid message must be sent once. Returns false when the id was
     * already sent.
     *
     * Sent ids persist in sessionStorage per channel until the gift's `expires_at`,
     * so they survive a reload of the same tab; other tabs rely on SNEED's dedupe.
     */
    private markGiftSeen(id: string, expiresAt: number = giftExpiry(null)): boolean {
        const gifts = this.sentGifts();
        if (gifts.has(id)) return false;
        gifts.set(id, expiresAt);
        this.saveSentGifts(gifts);
        return true;
    }

    private sentGiftsKey(): string | null {
        return this.channel ? SENT_GIFTS_KEY + this.channel.toLowerCase() : null;
    }

    /** This channel's sent gifts, loaded from sessionStorage minus expired ones. */
    private sentGifts(): Map<string, number> {
        if (this.sentGiftIds !== undefined && this.sentGiftsChannel === this.channel) return this.sentGiftIds;

        const gifts = new Map<string, number>();
        const key = this.sentGiftsKey();
        const now = Date.now();
        try {
            const raw = key === null ? null : sessionStore()?.getItem(key);
            const stored: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
            if (isRecord(stored)) {
                for (const [id, expiry] of Object.entries(stored)) {
                    if (typeof expiry === 'number' && expiry > now) gifts.set(id, expiry);
                }
            }
        } catch {
            // Unreadable or corrupt storage: start empty.
        }

        this.sentGiftIds = gifts;
        this.sentGiftsChannel = this.channel;
        this.saveSentGifts(gifts);
        return gifts;
    }

    /** Persist unexpired sent gifts; storage failures only cost reload dedupe. */
    private saveSentGifts(gifts: Map<string, number>): void {
        const key = this.sentGiftsKey();
        if (key === null) return;

        const now = Date.now();
        const live: Record<string, number> = {};
        for (const [id, expiry] of gifts) {
            if (expiry > now) live[id] = expiry;
        }
        try {
            const store = sessionStore();
            if (Object.keys(live).length === 0) store?.removeItem(key);
            else store?.setItem(key, JSON.stringify(live));
        } catch {
            // Quota or access errors: in-memory dedupe still holds for this page.
        }
    }

    //
    // Viewer count
    //

    /** Apply a `/current-viewers` payload; returns the count sent, or null if none was ours. */
    receiveCurrentViewers(json: unknown): number | null {
        // Without our own livestream id every entry belongs to someone else
        // (sidebar and featured streams are polled through the same endpoint).
        if (this.livestream_id === null) return null;

        const entries = Array.isArray(json) ? json as KickViewersEntry[] : [];
        for (const entry of entries) {
            const viewers = toFiniteNumber(entry?.viewers);
            if (viewers === null) continue;
            if (toFiniteNumber(entry?.livestream_id) !== this.livestream_id) continue;
            this.sendViewerCount(viewers);
            return viewers;
        }
        return null;
    }

    /**
     * Apply a `/api/v1/livestreams/{uuid}/viewer-count` payload for our livestream;
     * returns the count sent, or null when it was not ours or carried no count.
     */
    receiveViewerCount(uuid: string, json: unknown): number | null {
        if (this.livestream_uuid === null || uuid.toLowerCase() !== this.livestream_uuid.toLowerCase()) return null;

        const data = isRecord(json) ? (json as KickViewerCountResponse).data : undefined;
        const viewers = toFiniteNumber(data?.viewer_count);
        if (viewers === null) return null;

        this.sendViewerCount(viewers);
        return viewers;
    }

    /**
     * The page polls `/api/v1/livestreams/{uuid}/viewer-count` through TanStack
     * Query, which pauses polling while the tab is hidden, and the
     * `LivestreamUpdated` push lives on a `private-livestream.{id}` channel
     * anonymous viewers may not join. A streamer's Kick tab is usually in the
     * background, so CHUCK asks for the count itself every interval, even while
     * the page is polling too. The older `/current-viewers` endpoint lags behind
     * and is only the fallback. Without a live livestream id it re-reads the
     * channel record, which notices a stream that started or ended after the
     * page loaded.
     */
    async pollViewers(): Promise<void> {
        if (this.livestream_id === null) {
            await this.fetchChannelInfo();
            return;
        }

        if (this.livestream_uuid === null) await this.fetchLivestreamUuid();
        if (this.livestream_uuid !== null) {
            const uuid = this.livestream_uuid;
            try {
                const response = await fetch(`https://web.kick.com/api/v1/livestreams/${uuid}/viewer-count`);
                if (response.ok !== false && this.receiveViewerCount(uuid, await response.json()) !== null) return;
            } catch (error) {
                this.log('Viewer-count poll failed; falling back to /current-viewers.', error);
            }
        }

        try {
            const response = await fetch(`https://kick.com/current-viewers?ids[]=${this.livestream_id}`);
            if (this.receiveCurrentViewers(await response.json()) === null) {
                // Our livestream is missing from the answer, so it has probably ended.
                await this.fetchChannelInfo();
            }
        } catch (error) {
            this.error('Failed to poll viewer count.', error);
        }
    }

    //
    // Transport hooks
    //

    onWebSocketMessage(ws: PatchedWebSocket, event: MessageEvent): void {
        try {
            for (const frame of Kick.normalizeFrame(event.data)) {
                if (frame.kind === 'ignored') {
                    this.recordWebSocketIgnored(ws, 'in', event.data, frame.event, frame.reason);
                    continue;
                }
                if (frame.kind === 'unhandled') {
                    this.recordWebSocketUnhandled(ws, 'in', event.data, frame.event);
                    continue;
                }

                const outcome = this.handleEvent(frame.channel, frame.event, frame.data);
                if (outcome.status === 'handled') {
                    this.recordWebSocketHandled(ws, 'in', event.data, outcome.parsed ?? frame.data, frame.event);
                } else if (outcome.status === 'ignored') {
                    this.recordWebSocketIgnored(ws, 'in', event.data, frame.event, outcome.reason ?? null);
                } else {
                    this.recordWebSocketUnhandled(ws, 'in', event.data, frame.event);
                }
            }
        } catch (error) {
            this.recordError('ws_message', event.data, error);
        }
    }

    onWebSocketSend(ws: PatchedWebSocket, data: unknown): void {
        try {
            const channels = Kick.extractSubscribeChannels(data);
            const scoped = channels.some(channel => {
                const scope = parseChannelScope(channel);
                return scope.chatroomId !== null || scope.channelId !== null;
            });
            if (scoped) {
                // A chatroom/channel subscription is the first sign of a client-side
                // navigation to another channel, since the page never reloads. Global
                // subscriptions on non-channel pages must not retarget the scraper.
                this.checkForNavigation();
            }
            for (const channel of channels) {
                this.learnScope(channel);
            }

            if (channels.length > 0) {
                this.recordWebSocketHandled(ws, 'out', data, { subscribed: channels }, 'subscribe');
                return;
            }

            for (const frame of Kick.normalizeFrame(data)) {
                if (frame.kind === 'unhandled') {
                    this.recordWebSocketUnhandled(ws, 'out', data, frame.event);
                } else if (frame.kind === 'ignored') {
                    this.recordWebSocketIgnored(ws, 'out', data, frame.event, frame.reason);
                } else {
                    this.recordWebSocketIgnored(ws, 'out', data, frame.event, 'Outbound protocol frame');
                }
            }
        } catch (error) {
            this.recordError('ws_send', data, error);
        }
    }

    async onFetchResponse(response: Response): Promise<void> {
        try {
            if (response.url.includes('/current-viewers')) {
                const json = await response.clone().json() as unknown;
                const sent = this.receiveCurrentViewers(json);
                this.recordFetchHandled(response.url, 'GET', response.status, json, { viewers: sent });
                return;
            }

            const pathname = new URL(response.url, 'https://kick.com').pathname;

            const viewerCount = /^\/api\/v1\/livestreams\/([^/]+)\/viewer-count$/.exec(pathname);
            if (viewerCount !== null) {
                const json = await response.clone().json() as unknown;
                const sent = this.receiveViewerCount(decodeURIComponent(viewerCount[1]), json);
                if (sent === null) {
                    this.recordFetchIgnored(response.url, 'GET', response.status, 'Viewer count for another livestream');
                    return;
                }
                this.recordFetchHandled(response.url, 'GET', response.status, json, { viewers: sent });
                return;
            }

            if (this.isLivestreamPath(pathname)) {
                const json = await response.clone().json() as unknown;
                this.receiveLivestream(json);
                this.recordFetchHandled(response.url, 'GET', response.status, json, { livestream_uuid: this.livestream_uuid });
                return;
            }

            if (this.isChannelInfoPath(pathname)) {
                const json = await response.clone().json() as KickChannelInfo;
                if (!this.applyChannelInfo(json)) {
                    this.recordFetchIgnored(response.url, 'GET', response.status, 'Channel info for another channel');
                    return;
                }
                this.recordFetchHandled(response.url, 'GET', response.status, json, {
                    channel_id: this.channel_id,
                    chatroom_id: this.chatroom_id,
                    livestream_id: this.livestream_id,
                });
                return;
            }

            const pinned = /^\/api\/v1\/kicks\/(\d+)\/pinned-gifts$/.exec(pathname);
            if (pinned !== null && (this.channel_id === null || Number(pinned[1]) === this.channel_id)) {
                const json = await response.clone().json() as unknown;
                const sent = this.receivePinnedGifts(json);
                this.recordFetchHandled(response.url, 'GET', response.status, json, { pinnedGiftsSent: sent });
                return;
            }

            this.recordFetchIgnored(response.url, 'GET', response.status, 'Not monitored endpoint');
        } catch (error) {
            this.error('Failed to process fetch response.', error);
            this.recorder.record('fetch_response', {
                url: response.url,
                method: 'GET',
                statusCode: response.status,
                payload: (error as Error)?.message,
            }, EventStatus.ERROR, null, (error as Error)?.message ?? 'Unknown error');
        }
    }

    /** Log a hook failure and record it, without letting it escape into the page. */
    private recordError(type: string, payload: unknown, error: unknown): void {
        const reason = (error as Error)?.message ?? String(error);
        this.error(`Failed to process ${type}.`, error);
        this.recorder.record(type, { payload }, EventStatus.ERROR, null, reason);
    }
}

export default Kick;
