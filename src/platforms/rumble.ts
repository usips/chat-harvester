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

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';

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
        if (window.location.href.indexOf('/chat/popup/') >= 0) {
            this.channel = String(parseInt(window.location.href.split('/').filter(x => x)[4], 10));
        } else {
            // Otherwise, find the channel ID in the DOM (upvote button)
            const pill = document.querySelector('.rumbles-vote-pill') as HTMLElement | null;
            this.channel = pill?.dataset.id ?? null;
        }

        if (this.channel !== null) {
            this.fetchEmotes();
        }
    }

    fetchEmotes(): void {
        const init = document.querySelector('body > script:not([src])');
        if (!init) return;

        const code = init.textContent ?? '';
        const regex = /{items:(\[[^\(\)]*\]}\])}/;
        const match = code.match(regex);

        if (match) {
            // eslint-disable-next-line no-eval
            const itemsObj = eval(`"use strict";(${match[1]})`) as RumbleChannel[];
            itemsObj.forEach((channel) => {
                if (channel.emotes !== undefined && channel.emotes.length > 0) {
                    channel.emotes.forEach((emote) => {
                        this.emotes[emote.name] = emote.file;
                    });
                }
            });
        }
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
            const url = new URL(response.url);
            if (url.searchParams.get('name') == 'emote.list') {
                const cloned = response.clone();
                await cloned.json().then((json: { data: { items: RumbleChannel[] } }) => {
                    let emoteCount = 0;
                    json.data.items.forEach((channel) => {
                        if (channel.emotes !== undefined && channel.emotes.length > 0) {
                            channel.emotes.forEach((emote) => {
                                this.emotes[emote.name] = emote.file;
                                emoteCount++;
                            });
                        }
                    });
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
