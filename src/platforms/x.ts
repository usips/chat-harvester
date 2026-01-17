/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * X (Twitter) platform scraper
 *
 * Features:
 * - Capture new messages
 * - Capture sent messages
 * - Capture view counts (occupancy)
 *
 * Note: X blocks outbound connections via CSP. Browser extension can bypass this,
 * but userscript requires a CSP-modifying extension.
 */

import { Seed, ChatMessage, PatchedWebSocket } from '../core/index.js';

interface XSender {
    username: string;
    profile_image_url?: string;
    verified?: boolean;
}

interface XBody {
    uuid: string;
    body: string;
    timestamp: number;
}

interface XMessagePair {
    sender: XSender;
    body: XBody;
}

interface XWebSocketMessage {
    kind: number;
    payload?: string;
    body?: string;
}

interface XOccupancyPayload {
    occupancy?: number;
}

export class X extends Seed {
    static hostname = 'x.com';
    static altHostname = 'twitter.com';
    static namespace = '0abb36b8-43ab-40b5-be61-4f2c32a75890';

    constructor() {
        const channel = window.location.href.split('/').filter(x => x).at(-1) ?? null;
        super(X.namespace, 'X', channel!);
    }

    async initUUID(): Promise<void> {
        // X provides UUIDs for messages, and its CSP blocks the import
        // So we skip UUID initialization here
    }

    prepareChatMessages(pairs: XMessagePair[]): Promise<ChatMessage[]> {
        return Promise.all(pairs.map(async (pair) => {
            const message = new ChatMessage(pair.body.uuid, this.platform!, this.channel!);

            message.username = pair.sender.username;
            message.message = pair.body.body;

            // X sometimes sends messages with future timestamps
            if (pair.body.timestamp <= Date.now()) {
                message.sent_at = pair.body.timestamp;
            } else {
                console.warn('Received message with future timestamp:', pair.body.timestamp);
                message.sent_at = Date.now();
            }

            message.avatar = pair.sender.profile_image_url ?? 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';
            message.is_verified = pair.sender.verified ?? false;

            return message;
        }));
    }

    parseWebSocketMessage(data: XWebSocketMessage, ws: PatchedWebSocket, rawData: unknown, direction: 'in' | 'out'): void {
        switch (data.kind) {
            case 1: {
                const payload = JSON.parse(data.payload!) as { sender?: XSender; body?: string };
                if (payload.sender !== undefined && payload.body !== undefined) {
                    const body = JSON.parse(payload.body) as XBody;
                    if (body.body !== undefined) {
                        this.recordWebSocketHandled(ws, direction, rawData, { sender: payload.sender, body }, 'chat_message');
                        this.prepareChatMessages([{
                            sender: payload.sender,
                            body: body
                        }]).then((data) => {
                            this.sendChatMessages(data);
                        });
                        return;
                    }
                }
                this._debug('Unknown message type:', data);
                this.recordWebSocketUnhandled(ws, direction, rawData, `kind_${data.kind}`);
                break;
            }
            case 2: {
                const payload2 = JSON.parse(data.payload!) as XWebSocketMessage;
                if (payload2.kind == 4) {
                    this.parseWebSocketMessage(payload2, ws, rawData, direction);
                } else {
                    this.recordWebSocketIgnored(ws, direction, rawData, `kind_${data.kind}`, 'Wrapper message');
                }
                break;
            }
            case 4: {
                const payload4 = JSON.parse(data.body!) as XOccupancyPayload;
                if (payload4.occupancy !== undefined) {
                    this.sendViewerCount(payload4.occupancy);
                    this.recordWebSocketHandled(ws, direction, rawData, { occupancy: payload4.occupancy }, 'occupancy');
                } else {
                    this.recordWebSocketUnhandled(ws, direction, rawData, `kind_${data.kind}`);
                }
                break;
            }
            default:
                this.recordWebSocketUnhandled(ws, direction, rawData, `kind_${data.kind}`);
                break;
        }
    }

    onWebSocketMessage(ws: PatchedWebSocket, event: MessageEvent): void {
        const data = JSON.parse(event.data as string) as XWebSocketMessage;
        this.parseWebSocketMessage(data, ws, event.data, 'in');
    }

    onWebSocketSend(ws: PatchedWebSocket, message: unknown): void {
        const data = JSON.parse(message as string) as XWebSocketMessage;
        this.parseWebSocketMessage(data, ws, message, 'out');
    }
}

export default X;
