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

import { Seed, ChatMessage, uuidv5, EventStatus, parseUrl } from '../core/index.js';

interface RumbleUser {
    id: string;
    username: string;
    'image.1'?: string;
    badges?: string[];
}

interface RumbleMessage {
    id: string;
    user_id: string;
    text: string;
    time: string;
    rant?: {
        price_cents: number;
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
        messages: RumbleMessage[];
        users: RumbleUser[];
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

    constructor() {
        const channel = null; // Cannot be determined before DOM is ready
        super(Rumble.namespace, 'Rumble', channel!);
    }

    onDocumentReady(): void {
        // Pop-out chat contains the channel ID in the URL
        let channel: string | null = null;
        if (window.location.href.indexOf('/chat/popup/') >= 0) {
            channel = String(parseInt(window.location.href.split('/').filter(x => x)[4], 10));
        } else {
            // Otherwise, find the channel ID in the DOM (upvote button)
            const pill = document.querySelector('.rumbles-vote-pill') as HTMLElement | null;
            channel = pill?.dataset.id ?? null;
        }

        if (channel !== null) {
            this.setChannel(channel);
            this.fetchEmotes();
        }
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

    receiveChatPairs(messages: RumbleMessage[], users: RumbleUser[]): void {
        this.prepareSubscriptions(messages, users).then((data) => {
            data.forEach((datum) => {
                if (datum) this.receiveSubscriptions(datum);
            });
        });

        this.prepareChatMessages(messages, users).then((data) => {
            this.sendChatMessages(data);
        });
    }

    prepareChatMessages(messages: RumbleMessage[], users: RumbleUser[]): Promise<ChatMessage[]> {
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

                const user = users.find((user) => user.id === messageData.user_id);
                if (user === undefined) {
                    this.log('User not found:', messageData.user_id);
                    return null;
                }

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

                message.username = user.username;
                if (user['image.1'] !== undefined) {
                    message.avatar = user['image.1'];
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

    prepareSubscriptions(messages: RumbleMessage[], users: RumbleUser[]): Promise<(RumbleSubscription | undefined)[]> {
        return Promise.all(messages
            .filter(messageData =>
                Object.prototype.hasOwnProperty.call(messageData, 'notification') ||
                Object.prototype.hasOwnProperty.call(messageData, 'gift_purchase_notification')
            )
            .map(async (messageData) => {
                const user = users.find((user) => user.id === messageData.user_id);
                if (user === undefined) {
                    this.log('User not found:', messageData.user_id);
                    return undefined;
                }

                // Gift subscription purchase
                if (messageData.gift_purchase_notification) {
                    const gift = messageData.gift_purchase_notification;
                    return {
                        id: messageData.id,
                        gifted: true,
                        buyer: user.username,
                        count: gift.total_gifts || 1,
                        value: 5
                    };
                }

                // Regular subscription notification
                return {
                    id: messageData.id,
                    gifted: false,
                    buyer: user.username,
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
                    this.receiveChatPairs(json.data.messages, json.data.users);
                    this.recorder.recordEventSource(es.url, event.data, EventStatus.HANDLED, {
                        type: json.type,
                        messageCount: json.data.messages?.length || 0,
                        userCount: json.data.users?.length || 0
                    }, json.type);
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
        if (url.startsWith('https://wn0.rumble.com/service.php')) {
            xhr.addEventListener('readystatechange', (event) => this.onXhrServiceReadyStateChange(xhr, event));
        }
    }

    onXhrServiceReadyStateChange(xhr: XMLHttpRequest, _event: Event): void {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;

        if (xhr.responseType === 'json') {
            const json = xhr.response as { data?: { viewer_count?: string; num_watching_now?: string } };
            const viewers = parseInt(json?.data?.viewer_count || json?.data?.num_watching_now || '', 10);
            if (!isNaN(viewers)) {
                this.sendViewerCount(viewers);
            }
        }
    }
}

export default Rumble;
