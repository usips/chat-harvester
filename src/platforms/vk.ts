/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * VK platform scraper
 *
 * Features:
 * - Capture sent messages (partial implementation)
 */

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';

interface VKMessagePair {
    sender: {
        username: string;
        profile_image_url?: string;
        verified?: boolean;
    };
    body: {
        uuid: string;
        body: string;
        timestamp: number;
    };
}

export class VK extends Seed {
    static hostname = 'vk.com';
    static namespace = 'a59f077b-d072-41c0-976e-22c7e4ebf6f8';

    constructor() {
        const channel = window.location.href.split('/').filter(x => x).at(-1) ?? null;
        super(VK.namespace, 'VK', channel!);
    }

    prepareChatMessages(json: VKMessagePair[]): ChatMessage[] {
        const messages: ChatMessage[] = [];

        json.forEach((pair) => {
            const message = new ChatMessage(uuidv5(pair.body.uuid, this.namespace!), this.platform!, this.channel!);

            message.username = pair.sender.username;
            message.message = pair.body.body;
            message.sent_at = pair.body.timestamp;
            message.avatar = pair.sender.profile_image_url ?? 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';
            message.is_verified = pair.sender.verified ?? false;

            messages.push(message);
        });

        return messages;
    }

    onXhrReadyStateChange(xhr: XMLHttpRequest, _event: Event): void {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            const responseUrl = (xhr.response as { url?: string })?.url;
            if (responseUrl?.indexOf('act=post_comment') && responseUrl.indexOf('act=post_comment') > 0) {
                // TODO: Parse VK chat messages from DOM
                this.recorder.recordXhr(xhr.responseURL, 'POST', xhr.status, xhr.response, EventStatus.UNHANDLED, null, 'VK parsing not implemented');
            } else {
                this.recorder.recordXhr(xhr.responseURL, 'GET', xhr.status, null, EventStatus.IGNORED, null, 'Not monitored endpoint');
            }
        }
    }
}

export default VK;
