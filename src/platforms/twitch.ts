/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Twitch platform scraper
 *
 * Chat is IRC over `wss://irc-ws.chat.twitch.tv/`, one socket per tab that
 * JOINs and PARTs channels as the page navigates:
 *   `@tags :nick!nick@nick.tmi.twitch.tv COMMAND #channel :text`
 * Frames may hold several `\r\n`-separated lines.
 *
 * Viewer counts come from two places:
 * - Hermes (`wss://hermes.twitch.tv/v1`), the page's pubsub socket. The page
 *   subscribes to `video-playback-by-id.{channelId}` and receives a `viewcount`
 *   push roughly every 30 s. Notifications only carry a subscription id, so the
 *   topic is learned from the page's outbound `subscribe` frames.
 * - GQL (`POST gql.twitch.tv/gql`), which CHUCK polls itself once a minute so a
 *   tab without a playback subscription still reports, and which tells us when
 *   the stream is offline. The page's own GQL answers are read too.
 */

import { Seed, ChatMessage, uuidv5, WINDOW } from '../core/index.js';
import type { PatchedWebSocket } from '../core/index.js';

/** How often CHUCK checks the viewer count itself; see `pollViewers`. */
export const VIEWER_POLL_MS = 60_000;

const GQL_URL = 'https://gql.twitch.tv/gql';
/** The public Client-ID of the twitch.tv web client, used when the page's is unavailable. */
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const STREAM_QUERY = 'query ChuckStream($login:String!){user(login:$login){id login stream{id type viewersCount}}}';

/**
 * A Hermes `viewcount` this recent outranks GQL's `viewersCount`, which is
 * cached and lags it by a minute or more. Hermes pushes about every 30 s.
 */
const HERMES_FRESH_MS = 75_000;

/** US prices per `msg-param-sub-plan`. Prime counts as Tier 1. */
export const SUB_PRICE_USD: Record<string, number> = {
    Prime: 5.99,
    '1000': 5.99,
    '2000': 9.99,
    '3000': 24.99,
};
/** One bit is worth one US cent. */
const BIT_USD = 0.01;

/** Users whose sent message ids are kept for CLEARCHAT; oldest dropped first. */
const TRACKED_USERS = 2000;
/** Sent message ids kept per user for CLEARCHAT. */
const TRACKED_IDS_PER_USER = 200;
/** Recent mystery-gift ids, whose individual `subgift` notices are skipped. */
const TRACKED_MYSTERY_GIFTS = 500;
/** Hermes subscriptions remembered; the page unsubscribes on navigation. */
const TRACKED_TOPICS = 1000;
/** Most ids sent in one removal update. */
const REMOVAL_CHUNK = 1000;

/** First path segments that are site pages, not channel logins. */
const RESERVED_PATHS = new Set([
    'activate', 'annual-recap', 'bits', 'broadcast', 'checkout', 'clip', 'collections',
    'creatorcamp', 'dashboard', 'directory', 'downloads', 'drops', 'embed', 'event',
    'following', 'friends', 'inventory', 'jobs', 'login', 'logout', 'messages',
    'moderator', 'p', 'payments', 'popout', 'prime', 'privacy', 'products', 'redeem',
    'search', 'settings', 'signup', 'store', 'subs', 'subscriptions', 'team', 'turbo',
    'u', 'user', 'videos', 'wallet',
]);

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

/**
 * The channel login whose chat a twitch.tv path shows, or null for pages with
 * no live chat (home, directory, settings, VODs, clips).
 *
 * `/{login}`, `/popout/{login}/chat`, `/embed/{login}/chat`, `/moderator/{login}`.
 */
export function channelFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(part => part.length > 0).map(part => part.toLowerCase());
    let login: string | undefined;

    if ((parts[0] === 'popout' || parts[0] === 'embed') && parts[2] === 'chat' && parts.length === 3) {
        login = parts[1];
    } else if (parts[0] === 'moderator' && parts.length >= 2) {
        login = parts[1];
    } else if (parts.length === 1 || (parts.length === 2 && parts[1] === 'chat')) {
        login = RESERVED_PATHS.has(parts[0]) ? undefined : parts[0];
    }

    return login !== undefined && LOGIN_RE.test(login) ? login : null;
}

interface IrcTags {
    [key: string]: string;
}

interface ParsedIrcMessage {
    raw: string;
    tags: IrcTags;
    prefix: string | null;
    command: string | null;
    params: string[];
    trailing: string | null;
}

interface ChatMessageExtra {
    userId?: string;
    color?: string;
    badges?: string;
}

type TwitchChatMessage = ChatMessage & { extra?: ChatMessageExtra };

interface HermesFrame {
    type?: string;
    subscribe?: { id?: string; pubsub?: { topic?: string } };
    unsubscribe?: { id?: string };
    notification?: {
        subscription?: { id?: string };
        pubsub?: string;
    };
}

interface HermesPubsub {
    type?: string;
    viewers?: number;
}

/** The `user` object of a GQL answer, as far as CHUCK reads it. */
interface GqlUser {
    id?: string;
    login?: string;
    stream?: { id?: string; type?: string; viewersCount?: number } | null;
}

type Outcome = { status: 'handled' | 'ignored' | 'unhandled'; reason?: string };

export class Twitch extends Seed {
    static hostname = 'twitch.tv';
    static namespace = '4a342b79-e302-403a-99be-669b5f27b152';

    /** Numeric user id of the channel, from ROOMSTATE/room-id or GQL. */
    channelId: string | null = null;
    /** The latest Hermes count for this channel and when it arrived. */
    private hermesViewers: { count: number; at: number } | null = null;
    /** Hermes subscription id -> topic, from the page's outbound frames. Lazily created. */
    private hermesTopics?: Map<string, string>;
    /** Sent message uuids per Twitch user id, for CLEARCHAT. Lazily created. */
    private sentByUser?: Map<string, string[]>;
    /** `msg-param-community-gift-id`s of recent mystery gifts. Lazily created. */
    private mysteryGifts?: Set<string>;

    constructor() {
        super(Twitch.namespace, 'Twitch', channelFromPath(window.location.pathname)!);
        setInterval(() => void this.pollViewers(), VIEWER_POLL_MS);
    }

    onDocumentReady(): void {
        void this.pollViewers();
    }

    //
    // IRC parsing
    //

    /**
     * Parse IRC message tags (metadata) from Twitch format
     */
    parseIrcTags(tagsStr: string): IrcTags {
        const tags: IrcTags = {};
        if (!tagsStr) return tags;

        for (const pair of tagsStr.split(';')) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) {
                tags[pair] = '';
                continue;
            }
            // Unescape in one pass so `\\s` stays a backslash followed by `s`.
            tags[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1).replace(/\\(.?)/g, (_, c: string) => {
                switch (c) {
                    case 's': return ' ';
                    case 'n': return '\n';
                    case 'r': return '\r';
                    case ':': return ';';
                    case '\\': return '\\';
                    default: return c;
                }
            });
        }
        return tags;
    }

    /**
     * Parse full IRC message into structured JSON
     * Format: @tags :prefix COMMAND params :trailing
     */
    parseIrcMessageToJson(message: string): ParsedIrcMessage {
        const result: ParsedIrcMessage = {
            raw: message,
            tags: {},
            prefix: null,
            command: null,
            params: [],
            trailing: null
        };

        let remaining = message;

        if (remaining.startsWith('@')) {
            const spaceIdx = remaining.indexOf(' ');
            if (spaceIdx === -1) return result;
            result.tags = this.parseIrcTags(remaining.slice(1, spaceIdx));
            remaining = remaining.slice(spaceIdx + 1);
        }

        if (remaining.startsWith(':')) {
            const spaceIdx = remaining.indexOf(' ');
            if (spaceIdx === -1) return result;
            result.prefix = remaining.slice(1, spaceIdx);
            remaining = remaining.slice(spaceIdx + 1);
        }

        const trailingIdx = remaining.indexOf(' :');
        let commandAndParams: string;
        if (trailingIdx !== -1) {
            result.trailing = remaining.slice(trailingIdx + 2);
            commandAndParams = remaining.slice(0, trailingIdx);
        } else {
            commandAndParams = remaining;
        }

        const parts = commandAndParams.split(' ').filter(p => p);
        if (parts.length > 0) {
            result.command = parts[0];
            result.params = parts.slice(1);
        }

        return result;
    }

    /**
     * Extract username from IRC prefix
     * Format: nick!user@host.tmi.twitch.tv
     */
    extractUsername(prefix: string | null): string | null {
        if (!prefix) return null;
        const bangIdx = prefix.indexOf('!');
        if (bangIdx === -1) return prefix;
        return prefix.slice(0, bangIdx);
    }

    /**
     * Check if a badge type is present in badges string
     * Format: badge1/version,badge2/version,...
     */
    hasBadge(badges: string, type: string): boolean {
        if (!badges) return false;
        return badges.split(',').some(b => b.startsWith(type + '/'));
    }

    /** `#login` of a parsed line, lowercased, or null. */
    static ircChannel(parsed: ParsedIrcMessage): string | null {
        const param = parsed.params[0];
        return param?.startsWith('#') ? param.slice(1).toLowerCase() : null;
    }

    /**
     * Parse Twitch emotes string into [name, url, name] tuples.
     * Format: emote_id:start-end,start-end/emote_id:start-end
     *
     * Positions count Unicode code points, not UTF-16 units, so an emoji
     * before an emote shifts JavaScript string indices by one.
     */
    parseEmotes(emotesStr: string, message: string): [string, string, string][] {
        if (!emotesStr || !message) return [];

        const chars = Array.from(message);
        const emotes: [string, string, string][] = [];

        for (const group of emotesStr.split('/')) {
            const colonIdx = group.indexOf(':');
            if (colonIdx <= 0) continue;

            const emoteId = group.slice(0, colonIdx);
            for (const pos of group.slice(colonIdx + 1).split(',')) {
                const [startStr, endStr] = pos.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (isNaN(start) || isNaN(end) || start < 0 || start > end || end >= chars.length) continue;

                const emoteName = chars.slice(start, end + 1).join('');
                const emoteUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emoteId)}/default/dark/1.0`;
                emotes.push([emoteName, emoteUrl, emoteName]);
            }
        }

        return emotes;
    }

    /** Text of a PRIVMSG, with a `/me` action's CTCP wrapper removed. */
    static messageText(trailing: string | null): string {
        const text = trailing ?? '';
        const match = /^\x01ACTION (.*?)\x01?$/s.exec(text);
        return match ? match[1] : text;
    }

    /**
     * A ChatMessage carrying the author fields every tagged line shares:
     * id, name, timestamp, badges and colour.
     */
    private baseMessage(tags: IrcTags, prefix: string | null): TwitchChatMessage | null {
        const id = tags['id'];
        if (!id) return null;

        const message = new ChatMessage(uuidv5(id, Twitch.namespace), this.platform!, this.channel!) as TwitchChatMessage;
        message.username = tags['display-name'] || tags['login'] || this.extractUsername(prefix) || 'Unknown';

        const sentAt = parseInt(tags['tmi-sent-ts'] ?? '', 10);
        message.sent_at = Number.isFinite(sentAt) ? sentAt : Date.now();

        const badges = tags['badges'] || '';
        message.is_owner = this.hasBadge(badges, 'broadcaster');
        message.is_mod = tags['mod'] === '1' || this.hasBadge(badges, 'moderator') || this.hasBadge(badges, 'lead_moderator');
        message.is_sub = tags['subscriber'] === '1' || this.hasBadge(badges, 'subscriber') || this.hasBadge(badges, 'founder');
        message.is_verified = this.hasBadge(badges, 'partner');
        message.is_staff = this.hasBadge(badges, 'staff') || this.hasBadge(badges, 'admin') || this.hasBadge(badges, 'global_mod');

        // Twitch doesn't include avatars in IRC, so the default stays.
        message.extra = {
            userId: tags['user-id'],
            color: tags['color'] || '',
            badges,
        };

        return message;
    }

    /**
     * Convert parsed IRC PRIVMSG to ChatMessage
     */
    prepareChatMessage(parsed: ParsedIrcMessage): TwitchChatMessage | null {
        const tags = parsed.tags;
        const message = this.baseMessage(tags, parsed.prefix);
        if (message === null) {
            this.warn('PRIVMSG missing id:', parsed.raw);
            return null;
        }

        message.message = Twitch.messageText(parsed.trailing);
        message.emojis = this.parseEmotes(tags['emotes'], message.message);

        // In a shared chat, cheers made in a partner channel show here too, but
        // the bits went to that channel.
        const bits = Twitch.isFromSharedPartner(tags) ? NaN : parseInt(tags['bits'] ?? '', 10);
        if (Number.isFinite(bits) && bits > 0) {
            message.amount = Math.round(bits * BIT_USD * 100) / 100;
            message.currency = 'USD';
        }

        return message;
    }

    /** True for a shared-chat line that originated in another channel's room. */
    static isFromSharedPartner(tags: IrcTags): boolean {
        const source = tags['source-room-id'];
        return source !== undefined && source !== '' && source !== tags['room-id'];
    }

    /** USD value of one month of `msg-param-sub-plan`, or 0 if unknown. */
    static subPrice(plan: string | undefined): number {
        return plan !== undefined ? SUB_PRICE_USD[plan] ?? 0 : 0;
    }

    /**
     * Turn a USERNOTICE into a ChatMessage, or explain why not.
     * Sub events are paid messages with `is_subscription`; raids and
     * announcements are plain messages.
     */
    prepareUserNotice(parsed: ParsedIrcMessage): { message: TwitchChatMessage | null; reason: string } {
        const tags = parsed.tags;
        const msgId = tags['msg-id'] ?? '';
        const text = parsed.trailing ?? '';
        const systemMsg = tags['system-msg'] ?? '';

        const build = (body: string): TwitchChatMessage | null => {
            const message = this.baseMessage(tags, parsed.prefix);
            if (message === null) return null;
            message.message = body;
            message.emojis = this.parseEmotes(tags['emotes'], text);
            return message;
        };
        const withText = (system: string): string => (text ? `${system} ${text}`.trim() : system);
        const subscription = (amount: number): { message: TwitchChatMessage | null; reason: string } => {
            const message = build(withText(systemMsg));
            if (message !== null) {
                message.is_subscription = true;
                message.amount = Math.round(amount * 100) / 100;
                message.currency = 'USD';
            }
            return { message, reason: msgId };
        };
        const months = (key: string): number => {
            const value = parseInt(tags[key] ?? '', 10);
            return Number.isFinite(value) && value > 0 ? value : 1;
        };

        switch (msgId) {
            case 'sub':
            case 'resub': {
                // A prepaid multi-month sub is paid when it starts (tenure 0); the
                // monthly notices after that are worth one month each.
                const tenure = parseInt(tags['msg-param-multimonth-tenure'] ?? '0', 10);
                const duration = tenure > 0 ? 1 : months('msg-param-multimonth-duration');
                return subscription(Twitch.subPrice(tags['msg-param-sub-plan']) * duration);
            }

            case 'subgift': {
                // A mystery gift arrives as one `submysterygift` and then one
                // `subgift` per recipient; the summary is the one to count.
                const giftId = tags['msg-param-community-gift-id'];
                if (giftId && this.mysteryGifts?.has(giftId)) {
                    return { message: null, reason: 'Part of a mystery gift' };
                }
                return subscription(Twitch.subPrice(tags['msg-param-sub-plan']) * months('msg-param-gift-months'));
            }

            case 'submysterygift': {
                const giftId = tags['msg-param-community-gift-id'];
                if (giftId) this.rememberMysteryGift(giftId);
                const count = months('msg-param-mass-gift-count');
                return subscription(Twitch.subPrice(tags['msg-param-sub-plan']) * count);
            }

            case 'primepaidupgrade':
                return subscription(Twitch.subPrice(tags['msg-param-sub-plan']));

            case 'giftpaidupgrade':
            case 'anongiftpaidupgrade':
                // Continuing a gifted sub is a commitment, not a payment yet.
                return subscription(0);

            case 'raid':
            case 'unraid':
                return { message: build(systemMsg), reason: msgId };

            case 'announcement':
            case 'viewermilestone':
                // Shown with the user's own message; nothing to show without one.
                if (!text) return { message: null, reason: `${msgId} without a message` };
                return { message: build(text), reason: msgId };

            case 'sharedchatnotice':
                return { message: null, reason: 'Event from another channel in a shared chat' };

            default:
                return { message: null, reason: `Unhandled msg-id: ${msgId}` };
        }
    }

    private rememberMysteryGift(giftId: string): void {
        this.mysteryGifts ??= new Set();
        this.mysteryGifts.add(giftId);
        if (this.mysteryGifts.size > TRACKED_MYSTERY_GIFTS) {
            this.mysteryGifts.delete(this.mysteryGifts.values().next().value as string);
        }
    }

    //
    // Removals
    //

    /** Remember the uuid of a message we sent, for a later CLEARCHAT of its author. */
    private rememberSent(message: TwitchChatMessage): void {
        const userId = message.extra?.userId;
        if (!userId) return;

        this.sentByUser ??= new Map();
        const ids = this.sentByUser.get(userId) ?? [];
        // Re-insert so the map stays ordered by most recent activity.
        this.sentByUser.delete(userId);
        ids.push(message.id);
        if (ids.length > TRACKED_IDS_PER_USER) ids.shift();
        this.sentByUser.set(userId, ids);

        while (this.sentByUser.size > TRACKED_USERS) {
            this.sentByUser.delete(this.sentByUser.keys().next().value as string);
        }
    }

    private sendRemovals(ids: string[]): void {
        for (let i = 0; i < ids.length; i += REMOVAL_CHUNK) {
            this.sendRemoveMessages(ids.slice(i, i + REMOVAL_CHUNK));
        }
    }

    /** CLEARMSG: one message deleted. */
    handleClearMsg(parsed: ParsedIrcMessage): Outcome {
        const target = parsed.tags['target-msg-id'];
        if (!target) return { status: 'ignored', reason: 'CLEARMSG without target-msg-id' };
        const id = uuidv5(target, Twitch.namespace);
        const userIds = this.sentByUser?.values() ?? [];
        for (const ids of userIds) {
            const index = ids.indexOf(id);
            if (index >= 0) ids.splice(index, 1);
        }
        this.sendRemoveMessages([id]);
        return { status: 'handled' };
    }

    /** CLEARCHAT: a user timed out or banned, or (with no target) the whole chat cleared. */
    handleClearChat(parsed: ParsedIrcMessage): Outcome {
        const userId = parsed.tags['target-user-id'];
        let ids: string[];
        if (userId) {
            ids = this.sentByUser?.get(userId) ?? [];
            this.sentByUser?.delete(userId);
        } else {
            ids = Array.from(this.sentByUser?.values() ?? []).flat();
            this.sentByUser?.clear();
        }
        if (ids.length === 0) return { status: 'ignored', reason: 'No sent messages from that user' };
        this.sendRemovals(ids);
        return { status: 'handled' };
    }

    //
    // Channel tracking
    //

    /**
     * Twitch is a single-page app: going to another channel PARTs the old one and
     * JOINs the new one on the same IRC socket, and Hermes resubscribes. The
     * address bar is the source of truth; when it names another channel (or none),
     * zero this tab's count for the old one and forget everything learned about it.
     */
    checkForNavigation(poll = true): void {
        const login = channelFromPath(window.location.pathname);
        if (login === this.channel) return;

        this.log(`Channel changed: ${this.channel} -> ${login}`);
        if (this.channel !== null && this.viewers !== null && this.viewers > 0
            && this.chatSocket?.readyState === WebSocket.OPEN) {
            this.sendViewerCount(0);
        }

        this.channelId = null;
        this.hermesViewers = null;
        this.viewers = null;
        this.sentByUser?.clear();
        this.mysteryGifts?.clear();

        if (login === null) {
            this.channel = null;
            return;
        }
        this.setChannel(login);
        if (poll) void this.pollViewers();
    }

    /** Learn the numeric channel id from a line's `room-id` when it is for our channel. */
    private learnChannelId(parsed: ParsedIrcMessage): void {
        const roomId = parsed.tags['room-id'];
        if (this.channelId === null && roomId && Twitch.ircChannel(parsed) === this.channel) {
            this.channelId = roomId;
        }
    }

    /** True when a line is for the channel we are scraping; checks the URL first. */
    private isOurChannel(parsed: ParsedIrcMessage): boolean {
        const ircChannel = Twitch.ircChannel(parsed);
        if (ircChannel !== this.channel) this.checkForNavigation();
        return this.channel !== null && ircChannel === this.channel;
    }

    //
    // Viewer counts
    //

    /** The page's Client-ID when it exposes one, else the web client's. */
    static clientId(): string {
        const id = (WINDOW as unknown as { clientId?: unknown }).clientId;
        return typeof id === 'string' && /^[a-z0-9]{20,40}$/.test(id) ? id : WEB_CLIENT_ID;
    }

    /**
     * Hermes keeps pushing in hidden tabs and popout chats, but only while the
     * page holds a `video-playback-by-id` subscription for this channel, and it
     * never tells a page that loaded after the stream ended that it is offline.
     * CHUCK asks GQL itself once a minute, which also re-sends the count SNEED
     * needs at least that often. The request goes through the unpatched fetch
     * so it skips CHUCK's own hook.
     */
    async pollViewers(): Promise<void> {
        this.checkForNavigation(false);
        const login = this.channel;
        if (login === null) return;

        try {
            const fetchFn = WINDOW.fetch.oldFetch ?? WINDOW.fetch;
            const response = await fetchFn.call(WINDOW, GQL_URL, {
                method: 'POST',
                headers: { 'Client-ID': Twitch.clientId() },
                body: JSON.stringify({ operationName: 'ChuckStream', query: STREAM_QUERY, variables: { login } }),
            });
            const json = await response.json() as { data?: { user?: GqlUser | null } };
            this.receiveStreamInfo(login, json?.data?.user);
        } catch (error) {
            this.error('Failed to poll viewer count.', error);
        }
    }

    /**
     * Apply a GQL `user` object for `login`, from our poll or the page's own
     * queries. Sends 0 (once) when the channel is offline. While Hermes is
     * pushing counts, its fresher number is re-sent instead of GQL's.
     *
     * @returns the count sent, or null when the answer was not usable.
     */
    receiveStreamInfo(login: string, user: GqlUser | null | undefined): number | null {
        if (login !== this.channel || user === null || typeof user !== 'object') return null;
        if (typeof user.login === 'string' && user.login.toLowerCase() !== login) return null;

        if (typeof user.id === 'string' && user.id !== '') this.channelId = user.id;

        const stream = user.stream;
        if (stream === undefined) return null;
        if (stream === null) {
            this.hermesViewers = null;
            if (this.viewers !== 0) this.sendViewerCount(0);
            return 0;
        }

        const hermes = this.hermesViewers;
        const count = hermes !== null && Date.now() - hermes.at < HERMES_FRESH_MS
            ? hermes.count
            : stream.viewersCount;
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;

        this.sendViewerCount(count);
        return count;
    }

    /** True when a Hermes topic is about this channel's video playback. */
    private isOurPlaybackTopic(topic: string | undefined): boolean {
        if (topic === undefined) return false;
        const byId = /^video-playback-by-id\.(\d+)$/.exec(topic);
        if (byId) return this.channelId !== null && byId[1] === this.channelId;
        const byLogin = /^video-playback\.(\w+)$/.exec(topic);
        return byLogin !== null && byLogin[1].toLowerCase() === this.channel;
    }

    /** Find `user`-shaped objects for our channel in a GQL answer. */
    private findUsers(node: unknown, depth: number, found: GqlUser[]): void {
        if (depth > 8 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) this.findUsers(item, depth + 1, found);
            return;
        }
        const record = node as Record<string, unknown>;
        if (typeof record.login === 'string' && record.login.toLowerCase() === this.channel && 'stream' in record) {
            found.push(record as GqlUser);
            return;
        }
        for (const value of Object.values(record)) this.findUsers(value, depth + 1, found);
    }

    //
    // Transport hooks
    //

    onWebSocketMessage(ws: PatchedWebSocket, event: MessageEvent): void {
        const data = event.data;
        if (typeof data !== 'string') {
            this.recordWebSocketIgnored(ws, 'in', data, 'BINARY', 'Non-string data');
            return;
        }

        const wsUrl = ws.url || ws._chuck_url || '';
        if (wsUrl.includes('hermes.twitch.tv')) {
            this.processHermesMessage(ws, data);
        } else if (wsUrl.includes('irc-ws.chat.twitch.tv') || wsUrl.includes('tmi.twitch.tv')) {
            for (const line of data.split('\r\n')) {
                if (line) this.processIrcLine(ws, line);
            }
        } else {
            this.recordWebSocketIgnored(ws, 'in', data, 'OTHER_SOCKET', 'Not a chat or pubsub socket');
        }
    }

    /**
     * Process Hermes PubSub WebSocket messages
     */
    processHermesMessage(ws: PatchedWebSocket, data: string): void {
        let json: HermesFrame;
        try {
            json = JSON.parse(data) as HermesFrame;
        } catch {
            this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_INVALID', 'Invalid JSON');
            return;
        }

        if (json?.type === 'notification') {
            this.processHermesNotification(ws, data, json);
        } else {
            this.recordWebSocketIgnored(ws, 'in', data, `HERMES_${json?.type?.toUpperCase() || 'UNKNOWN'}`, 'Hermes control frame');
        }
    }

    /**
     * Process Hermes notification messages
     */
    processHermesNotification(ws: PatchedWebSocket, data: string, json: HermesFrame): void {
        const pubsubData = json.notification?.pubsub;
        if (!pubsubData) {
            this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_NOTIFICATION', 'No pubsub data');
            return;
        }

        let pubsub: HermesPubsub;
        try {
            pubsub = JSON.parse(pubsubData) as HermesPubsub;
        } catch {
            this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_NOTIFICATION', 'Invalid pubsub JSON');
            return;
        }

        const subscriptionId = json.notification?.subscription?.id;
        const topic = subscriptionId !== undefined ? this.hermesTopics?.get(subscriptionId) : undefined;

        switch (pubsub?.type) {
            case 'viewcount': {
                if (!this.isOurPlaybackTopic(topic)) {
                    this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_VIEWCOUNT', `Not this channel's topic: ${topic}`);
                    return;
                }
                const viewers = pubsub.viewers;
                if (typeof viewers !== 'number' || !Number.isFinite(viewers) || viewers < 0) {
                    this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_VIEWCOUNT', 'Invalid viewer count');
                    return;
                }
                this.hermesViewers = { count: viewers, at: Date.now() };
                this.sendViewerCount(viewers);
                this.recordWebSocketHandled(ws, 'in', data, pubsub, 'HERMES_VIEWCOUNT');
                return;
            }

            case 'stream-down': {
                if (!this.isOurPlaybackTopic(topic)) {
                    this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_STREAM_DOWN', `Not this channel's topic: ${topic}`);
                    return;
                }
                this.hermesViewers = null;
                this.sendViewerCount(0);
                this.recordWebSocketHandled(ws, 'in', data, pubsub, 'HERMES_STREAM_DOWN');
                return;
            }

            case 'stream-up': {
                if (this.isOurPlaybackTopic(topic)) void this.pollViewers();
                this.recordWebSocketIgnored(ws, 'in', data, 'HERMES_STREAM_UP', 'Count follows in viewcount');
                return;
            }

            default:
                this.recordWebSocketIgnored(ws, 'in', data, `HERMES_PUBSUB_${pubsub?.type?.toUpperCase() || 'UNKNOWN'}`, 'Unused pubsub type');
        }
    }

    /**
     * Process a single IRC line
     */
    processIrcLine(ws: PatchedWebSocket, line: string): void {
        const parsed = this.parseIrcMessageToJson(line);
        const outcome = this.handleIrcCommand(parsed);
        const event = parsed.command ?? 'UNKNOWN';
        if (outcome.status === 'handled') {
            this.recordWebSocketHandled(ws, 'in', line, parsed, event);
        } else if (outcome.status === 'ignored') {
            this.recordWebSocketIgnored(ws, 'in', line, event, outcome.reason ?? null);
        } else {
            this.recordWebSocketUnhandled(ws, 'in', line, event);
        }
    }

    /** Act on one parsed IRC line. */
    handleIrcCommand(parsed: ParsedIrcMessage): Outcome {
        switch (parsed.command) {
            case 'PRIVMSG': {
                if (!this.isOurChannel(parsed)) return { status: 'ignored', reason: 'Not this channel' };
                this.learnChannelId(parsed);
                const message = this.prepareChatMessage(parsed);
                if (message === null) return { status: 'unhandled', reason: 'Failed to parse' };
                this.rememberSent(message);
                this.sendChatMessages([message]);
                return { status: 'handled' };
            }

            case 'USERNOTICE': {
                if (!this.isOurChannel(parsed)) return { status: 'ignored', reason: 'Not this channel' };
                this.learnChannelId(parsed);
                const { message, reason } = this.prepareUserNotice(parsed);
                if (message === null) return { status: 'ignored', reason };
                this.rememberSent(message);
                this.sendChatMessages([message]);
                return { status: 'handled' };
            }

            case 'CLEARMSG':
                if (!this.isOurChannel(parsed)) return { status: 'ignored', reason: 'Not this channel' };
                return this.handleClearMsg(parsed);

            case 'CLEARCHAT':
                if (!this.isOurChannel(parsed)) return { status: 'ignored', reason: 'Not this channel' };
                return this.handleClearChat(parsed);

            case 'ROOMSTATE':
                if (this.isOurChannel(parsed)) this.learnChannelId(parsed);
                return { status: 'ignored', reason: 'Room state' };

            case 'PING':
            case 'PONG':
                return { status: 'ignored', reason: 'Keepalive' };

            case 'USERSTATE':
            case 'GLOBALUSERSTATE':
            case 'NOTICE':
            case 'JOIN':
            case 'PART':
            case 'RECONNECT':
            case 'CAP':
            case '001':
            case '002':
            case '003':
            case '004':
            case '353':
            case '366':
            case '372':
            case '375':
            case '376':
                return { status: 'ignored', reason: 'Connection or state line' };

            default:
                return { status: 'unhandled' };
        }
    }

    /**
     * Outgoing frames: IRC JOINs signal a channel switch; Hermes subscribes
     * tell us which topic each later notification belongs to.
     */
    onWebSocketSend(ws: PatchedWebSocket, message: unknown): void {
        if (typeof message !== 'string') return;

        const wsUrl = ws.url || ws._chuck_url || '';
        if (wsUrl.includes('hermes.twitch.tv')) {
            this.learnHermesFrame(message);
            this.recordWebSocketIgnored(ws, 'out', message, 'HERMES_SEND', 'Outgoing Hermes frame');
            return;
        }

        const parsed = this.parseIrcMessageToJson(message);
        if (parsed.command === 'JOIN') this.checkForNavigation();
        this.recordWebSocketIgnored(ws, 'out', message, parsed.command || 'IRC_SEND', 'Outgoing IRC command');
    }

    /** Track Hermes subscription ids and their topics. */
    learnHermesFrame(message: string): void {
        let frame: HermesFrame;
        try {
            frame = JSON.parse(message) as HermesFrame;
        } catch {
            return;
        }

        this.hermesTopics ??= new Map();
        if (frame?.type === 'subscribe') {
            const id = frame.subscribe?.id;
            const topic = frame.subscribe?.pubsub?.topic;
            if (typeof id === 'string' && typeof topic === 'string') {
                this.hermesTopics.set(id, topic);
                if (this.hermesTopics.size > TRACKED_TOPICS) {
                    this.hermesTopics.delete(this.hermesTopics.keys().next().value as string);
                }
            }
        } else if (frame?.type === 'unsubscribe') {
            const id = frame.unsubscribe?.id;
            if (typeof id === 'string') this.hermesTopics.delete(id);
        }
    }

    /**
     * The page's GQL answers carry the stream record on load and navigation;
     * read any that describe our channel. Everything else is ignored.
     */
    async onFetchResponse(response: Response): Promise<void> {
        const url = response.url ?? '';
        if (!url.startsWith(GQL_URL) || this.channel === null) {
            this.recordFetchIgnored(url, 'GET', response.status, 'Not a GQL answer');
            return;
        }

        const login = this.channel;
        let json: unknown;
        try {
            json = await response.json();
        } catch {
            this.recordFetchIgnored(url, 'POST', response.status, 'GQL answer is not JSON');
            return;
        }

        const users: GqlUser[] = [];
        this.findUsers(json, 0, users);
        let handled = false;
        for (const user of users) {
            if (this.receiveStreamInfo(login, user) !== null) handled = true;
        }
        if (handled) {
            this.recordFetchHandled(url, 'POST', response.status, null, users);
        } else {
            this.recordFetchIgnored(url, 'POST', response.status, 'No stream record for this channel');
        }
    }
}

export default Twitch;
