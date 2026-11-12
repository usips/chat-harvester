/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Rumble platform scraper
 *
 * Features:
 * - Capture new messages
 * - Capture sent messages
 * - Capture existing messages
 * - Capture emotes
 * - Capture view counts
 * - Capture rants (paid messages)
 */

import { Seed, ChatMessage, uuidv5, EventStatus, parseUrl, WINDOW } from '../core/index.js';

/** How often CHUCK checks the viewer count itself; see `pollViewers`. */
export const VIEWER_POLL_MS = 60_000;

/** The service the watch page polls for its "watching now" count. */
const WATCHING_NOW_URL = 'https://wn0.rumble.com/service.php?name=video.watching-now&video_id=';

/** Users whose sent message ids are kept for `mute_users`; oldest dropped first. */
const MUTE_TRACKED_USERS = 2000;
/** Sent message ids kept per user for `mute_users`. */
const MUTE_TRACKED_IDS_PER_USER = 200;

/** `livestream_status` of a stream that is on air right now. */
const LIVESTREAM_STATUS_LIVE = 2;

/**
 * `video.watching-now` answer, e.g.
 * `{"data":{"video_id":443918684,"num_watching_now":5997,"viewer_count":5997,"livestream_status":2}}`.
 */
interface RumbleWatchingNow {
    data?: {
        video_id?: number | string;
        viewer_count?: number | string | null;
        num_watching_now?: number | string | null;
        livestream_status?: number | null;
    };
}

interface RumbleUser {
    id: string | number;
    username: string;
    'image.1'?: string;
    badges?: string[];
}

/**
 * A channel a user can post as, from `data.channels[]`, e.g.
 * `{"id":"1134193","username":"DueDissidence","link":"/c/DueDissidence","image.1":"https://..."}`.
 */
interface RumbleChannelPersona {
    id: string | number;
    username: string;
    'image.1'?: string;
}

interface RumbleMessage {
    id: string;
    user_id: string | number;
    /** Set when the user posted as one of their channels; Rumble shows the channel. */
    channel_id?: string | number | null;
    text: string;
    time: string;
    rant?: {
        price_cents: number;
        duration?: number;
        expires_on?: string;
    };
    notification?: unknown;
    gift_purchase_notification?: {
        total_gifts?: number;
    };
}

interface RumbleEmote {
    name: string;
    file: string;
}

interface RumbleChannel {
    emotes?: RumbleEmote[];
}

interface RumbleEventSourceData {
    type: string;
    data: {
        /** `init` and `messages` */
        messages: RumbleMessage[];
        users: RumbleUser[];
        channels?: RumbleChannelPersona[];
        /** `delete_messages` */
        message_ids?: (string | number)[];
        /** `mute_users`, e.g. `{"type":"mute_users","data":{"user_ids":[286098814]}}` */
        user_ids?: (string | number)[];
    };
}

interface RumbleSubscription {
    id: string;
    gifted: boolean;
    buyer: string;
    count: number;
    value: number;
}

export class Rumble extends Seed {
    static hostname = 'rumble.com';
    static namespace = '5ceefcfb-4aa5-443a-bea6-1f8590231471';

    emotes: Record<string, string> = {};
    /** Sent message uuids per Rumble user id, for `mute_users`. Lazily created. */
    private sentByUser?: Map<string, string[]>;

    constructor() {
        const channel = null; // Cannot be determined before DOM is ready
        super(Rumble.namespace, 'Rumble', channel!);
        setInterval(() => void this.pollViewers(), VIEWER_POLL_MS);
    }

    /** Video id from a pop-out chat path, `/chat/popup/{videoId}`, or null. */
    static popupVideoId(pathname: string): string | null {
        const match = /^\/chat\/popup\/(\d+)(?:\/|$)/.exec(pathname);
        return match ? match[1] : null;
    }

    onDocumentReady(): void {
        // The channel is the numeric video id. Pop-out chat carries it in the URL.
        let channel: string | null = null;
        if (window.location.pathname.startsWith('/chat/popup/')) {
            channel = Rumble.popupVideoId(window.location.pathname);
        } else {
            // Otherwise, find the video ID in the DOM (upvote button)
            const pill = document.querySelector('.rumbles-vote-pill') as HTMLElement | null;
            channel = pill?.dataset.id || null;
        }

        if (channel !== null) {
            this.setChannel(channel);
            this.fetchEmotes();
            void this.pollViewers();
        }
    }

    /**
     * The watch page polls `video.watching-now` once a minute, but the pop-out chat
     * never does, and background tabs throttle the page's timer. CHUCK asks for the
     * count itself every interval so a pop-out alone still reports viewers. The
     * request goes through the unpatched fetch so it doesn't pass through CHUCK's
     * own fetch hook.
     */
    async pollViewers(): Promise<void> {
        if (this.channel === null) return;

        try {
            const fetchFn = WINDOW.fetch.oldFetch ?? WINDOW.fetch;
            const response = await fetchFn.call(WINDOW, WATCHING_NOW_URL + encodeURIComponent(this.channel), {
                credentials: 'include'
            });
            this.receiveWatchingNow(await response.json());
        } catch (error) {
            this.error('Failed to poll viewer count.', error);
        }
    }

    /**
     * Apply a `video.watching-now` answer, from our own poll or the page's.
     * Sends 0 (once) when the video is not live.
     *
     * @returns the count sent, or null when the answer was not usable.
     */
    receiveWatchingNow(json: unknown): number | null {
        const data = (json as RumbleWatchingNow | null)?.data;
        if (data === null || typeof data !== 'object') return null;

        // Ignore answers about another video.
        if (data.video_id !== undefined && this.channel !== null && String(data.video_id) !== String(this.channel)) {
            return null;
        }

        if (data.livestream_status !== undefined && data.livestream_status !== LIVESTREAM_STATUS_LIVE) {
            if (this.viewers !== 0) this.sendViewerCount(0);
            return 0;
        }

        const raw = data.viewer_count ?? data.num_watching_now;
        const viewers = typeof raw === 'number' ? raw : parseInt(raw ?? '', 10);
        if (!Number.isFinite(viewers) || viewers < 0) return null;

        this.sendViewerCount(viewers);
        return viewers;
    }

    fetchEmotes(): void {
        // The emote picker's data is an inline argument to RumbleChat(). It is not
        // always the first inline script in the body, so check every one of them.
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));

        for (const script of scripts) {
            const items = Rumble.extractEmoteItems(script.textContent ?? '');
            if (items === null) continue;

            const emoteCount = this.addEmotes(items);
            if (emoteCount > 0) {
                this._debug(`Loaded ${emoteCount} emotes from the page.`);
                return;
            }
        }

        this._debug('No emotes found on the page.');
    }

    /**
     * Pull the `{items:[...]}` emote payload out of a script. The payload is
     * unquoted JavaScript rather than JSON, and sits inside a minified function
     * call, so find its end by matching brackets and then evaluate it.
     */
    static extractEmoteItems(code: string): RumbleChannel[] | null {
        const marker = '{items:[';

        for (let start = code.indexOf(marker); start >= 0; start = code.indexOf(marker, start + 1)) {
            const end = Rumble.findValueEnd(code, start);
            if (end < 0) continue;

            // Other `{items:[...]}` payloads (playlists, categories) share the key.
            const emotesAt = code.indexOf('emotes:', start);
            if (emotesAt < 0 || emotesAt >= end) continue;

            let parsed: { items?: RumbleChannel[] };
            try {
                // eslint-disable-next-line no-eval
                parsed = eval(`"use strict";(${code.slice(start, end)})`) as { items?: RumbleChannel[] };
            } catch {
                continue;
            }

            if (Array.isArray(parsed?.items)) return parsed.items;
        }

        return null;
    }

    /** Index just past the bracket that closes the value starting at `start`. */
    static findValueEnd(code: string, start: number): number {
        let depth = 0;
        let quote = '';

        for (let i = start; i < code.length; i++) {
            const char = code[i];

            if (quote !== '') {
                if (char === '\\') i++;
                else if (char === quote) quote = '';
                continue;
            }

            switch (char) {
                case '"':
                case "'":
                case '`':
                    quote = char;
                    break;
                case '{':
                case '[':
                    depth++;
                    break;
                case '}':
                case ']':
                    depth--;
                    if (depth === 0) return i + 1;
                    if (depth < 0) return -1;
                    break;
            }
        }

        return -1;
    }

    addEmotes(items: RumbleChannel[] | undefined): number {
        let emoteCount = 0;

        items?.forEach((channel) => {
            channel.emotes?.forEach((emote) => {
                this.emotes[emote.name] = emote.file;
                emoteCount++;
            });
        });

        return emoteCount;
    }

    /**
     * Who Rumble shows as a message's author: the channel it was posted as when
     * `channel_id` is set, otherwise the account. Badges stay with the account.
     */
    static findAuthor(
        messageData: RumbleMessage,
        users: RumbleUser[],
        channels: RumbleChannelPersona[] = []
    ): { user: RumbleUser; author: RumbleUser | RumbleChannelPersona } | null {
        const user = users.find((user) => String(user.id) === String(messageData.user_id));
        if (user === undefined) return null;

        const channelId = messageData.channel_id;
        const persona = channelId !== undefined && channelId !== null
            ? channels.find((channel) => String(channel.id) === String(channelId))
            : undefined;

        return { user, author: persona ?? user };
    }

    receiveChatPairs(messages: RumbleMessage[], users: RumbleUser[], channels: RumbleChannelPersona[] = []): void {
        this.prepareSubscriptions(messages, users, channels).then((data) => {
            data.forEach((datum) => {
                if (datum) this.receiveSubscriptions(datum);
            });
        });

        this.prepareChatMessages(messages, users, channels).then((data) => {
            this.sendChatMessages(data);
        });

        this.rememberSentMessages(messages);
    }

    /**
     * Remember which message ids each user sent so a later `mute_users` can take
     * them off the overlay, as Rumble's own chat does. Bounded per user and in
     * the number of users, most recently active kept.
     */
    rememberSentMessages(messages: RumbleMessage[]): void {
        this.sentByUser ??= new Map();
        for (const messageData of messages) {
            const userId = String(messageData.user_id);
            const id = uuidv5(String(messageData.id), this.namespace!);
            const ids = this.sentByUser.get(userId) ?? [];
            this.sentByUser.delete(userId);
            if (!ids.includes(id)) {
                ids.push(id);
                if (ids.length > MUTE_TRACKED_IDS_PER_USER) ids.shift();
            }
            this.sentByUser.set(userId, ids);
        }

        while (this.sentByUser.size > MUTE_TRACKED_USERS) {
            const oldest = this.sentByUser.keys().next().value as string;
            this.sentByUser.delete(oldest);
        }
    }

    /** `delete_messages`: remove the given Rumble message ids. */
    receiveDeletedMessages(messageIds: (string | number)[]): string[] {
        const ids = messageIds.map((id) => uuidv5(String(id), this.namespace!));
        if (ids.length > 0) this.sendRemoveMessages(ids);
        return ids;
    }

    /** `mute_users`: remove every message we sent for the given Rumble user ids. */
    receiveMutedUsers(userIds: (string | number)[]): string[] {
        const ids: string[] = [];
        for (const userId of userIds) {
            const key = String(userId);
            ids.push(...(this.sentByUser?.get(key) ?? []));
            this.sentByUser?.delete(key);
        }
        if (ids.length > 0) this.sendRemoveMessages(ids);
        return ids;
    }

    prepareChatMessages(messages: RumbleMessage[], users: RumbleUser[], channels: RumbleChannelPersona[] = []): Promise<ChatMessage[]> {
        return Promise.all(messages
            .filter((messageData) => {
                return messageData.text.trim() !== '';
            })
            .map(async (messageData) => {
                const message = new ChatMessage(
                    uuidv5(messageData.id, this.namespace!),
                    this.platform!,
                    this.channel!
                );

                const found = Rumble.findAuthor(messageData, users, channels);
                if (found === null) {
                    this.log('User not found:', messageData.user_id);
                    return null;
                }
                const { user, author } = found;

                message.sent_at = Date.parse(messageData.time);
                message.message = messageData.text;

                // Replace :r+emote: with image URLs
                for (const match of message.message.matchAll(/\:([a-zA-Z0-9_\.\+\-]+)\:/g)) {
                    const id = match[1];
                    if (this.emotes[id] !== undefined) {
                        message.emojis.push([match[0], this.emotes[id], `:${id}:`]);
                    } else {
                        this.log(`no emote for ${id}`);
                    }
                }

                message.username = author.username;
                if (author['image.1'] !== undefined) {
                    message.avatar = author['image.1'];
                }

                if (user.badges !== undefined) {
                    user.badges.forEach((badge) => {
                        switch (badge) {
                            case 'admin':
                                message.is_owner = true;
                                break;
                            case 'moderator':
                                message.is_mod = true;
                                break;
                            case 'whale-gray':
                            case 'whale-blue':
                            case 'whale-yellow':
                            case 'locals':
                            case 'locals_supporter':
                            case 'recurring_subscription':
                                message.is_sub = true;
                                break;
                            case 'premium':
                                break;
                            case 'verified':
                                message.is_verified = true;
                                break;
                            default:
                                this.log(`Unknown badge type: ${badge}`);
                                break;
                        }
                    });
                }

                if (messageData.rant !== undefined) {
                    message.amount = messageData.rant.price_cents / 100;
                    message.currency = 'USD';
                }

                return message;
            })).then(msgs => msgs.filter((m): m is ChatMessage => m !== null));
    }

    prepareSubscriptions(messages: RumbleMessage[], users: RumbleUser[], channels: RumbleChannelPersona[] = []): Promise<(RumbleSubscription | undefined)[]> {
        return Promise.all(messages
            .filter(messageData =>
                Object.prototype.hasOwnProperty.call(messageData, 'notification') ||
                Object.prototype.hasOwnProperty.call(messageData, 'gift_purchase_notification')
            )
            .map(async (messageData) => {
                const found = Rumble.findAuthor(messageData, users, channels);
                if (found === null) {
                    this.log('User not found:', messageData.user_id);
                    return undefined;
                }
                const buyer = found.author.username;

                // Gift subscription purchase
                if (messageData.gift_purchase_notification) {
                    const gift = messageData.gift_purchase_notification;
                    return {
                        id: messageData.id,
                        gifted: true,
                        buyer,
                        count: gift.total_gifts || 1,
                        value: 5
                    };
                }

                // Regular subscription notification
                return {
                    id: messageData.id,
                    gifted: false,
                    buyer,
                    count: 1,
                    value: 5
                };
            }));
    }

    onEventSourceMessage(es: EventSource, event: MessageEvent): void {
        try {
            const json = JSON.parse(event.data as string) as RumbleEventSourceData;
            switch (json.type) {
                case 'init':
                case 'messages':
                    this.receiveChatPairs(json.data.messages, json.data.users, json.data.channels ?? []);
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.HANDLED, {
                        type: json.type,
                        messageCount: json.data.messages?.length || 0,
                        userCount: json.data.users?.length || 0
                    }, json.type);
                    break;
                case 'delete_messages': {
                    const removed = this.receiveDeletedMessages(json.data.message_ids ?? []);
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.HANDLED, { removed }, json.type);
                    break;
                }
                case 'mute_users': {
                    const removed = this.receiveMutedUsers(json.data.user_ids ?? []);
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.HANDLED, { removed }, json.type);
                    break;
                }
                case 'pin_message':
                case 'unpin_message':
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.IGNORED, null, json.type, 'Pinning is not forwarded');
                    break;
                default:
                    this._debug('EventSource received data with unknown type.', json);
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.UNHANDLED, null, json.type);
                    break;
            }
        } catch (e) {
            this.log('EventSource received data with invalid JSON.', e, event.data);
            this.recorder.recordEventSource(es.url, event.data, EventStatus.ERROR, null, null, (e as Error).message);
        }
    }

    async onFetchResponse(response: Response): Promise<void> {
        try {
            const url = parseUrl(response.url);
            if (url === null) {
                this.recordFetchIgnored(response.url, 'GET', response.status, 'Response has no URL');
            } else if (url.searchParams.get('name') == 'emote.list') {
                const cloned = response.clone();
                await cloned.json().then((json: { data: { items: RumbleChannel[] } }) => {
                    const emoteCount = this.addEmotes(json.data.items);
                    this.recordFetchHandled(response.url, 'GET', response.status, json, { emoteCount });
                });
            } else if (url.searchParams.get('name') === 'video.watching-now') {
                const json: unknown = await response.clone().json();
                const viewers = this.receiveWatchingNow(json);
                this.recordFetchHandled(response.url, 'GET', response.status, json, { viewers });
            } else {
                this.recordFetchIgnored(response.url, 'GET', response.status, 'Not emote list');
            }
        } catch (e) {
            this.log('Fetch response error.', e);
            this.recorder.record('fetch_response', {
                url: response.url,
                method: 'GET',
                statusCode: response.status,
                payload: (e as Error).message
            }, EventStatus.ERROR, null, (e as Error).message);
        }
    }

    onXhrOpen(xhr: XMLHttpRequest, _method: string, url: string, _async?: boolean, _user?: string, _password?: string): void {
        const parsed = parseUrl(url);
        if (parsed?.hostname === 'wn0.rumble.com' && parsed.searchParams.get('name') === 'video.watching-now') {
            xhr.addEventListener('readystatechange', (event) => this.onXhrServiceReadyStateChange(xhr, event));
        }
    }

    onXhrServiceReadyStateChange(xhr: XMLHttpRequest, _event: Event): void {
        if (xhr.readyState !== 4 /* DONE */) return;

        let json: unknown;
        if (xhr.responseType === 'json') {
            json = xhr.response;
        } else if (xhr.responseType === '' || xhr.responseType === 'text') {
            try {
                json = JSON.parse(xhr.responseText);
            } catch {
                return;
            }
        } else {
            return;
        }

        this.receiveWatchingNow(json);
    }
}

export default Rumble;
