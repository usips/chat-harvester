#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';
const DEFAULT_NEXUS_URL = 'ws://127.0.0.1:1350/chat.ws';
const MAX_SEEN_IDS = 5000;
const MAX_QUEUED_UPDATES = 2000;

export const PUSHER_URL = `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;

function timestamp() {
    return new Date().toISOString();
}

function parseJson(value) {
    if (typeof value === 'string') return JSON.parse(value);
    return value;
}

function badgesFor(sender) {
    return sender?.identity?.badges ?? [];
}

function hasBadge(sender, ...types) {
    return badgesFor(sender).some((badge) => types.includes(badge.type));
}

export function mapKickChatMessage(data, channel, receivedAt = Date.now()) {
    const content = data.content ?? '';
    const emojis = [];

    for (const match of content.matchAll(/\[emote:(\d+):([^\]]+)\]/g)) {
        emojis.push([
            match[0],
            `https://files.kick.com/emotes/${match[1]}/fullsize`,
            match[2],
        ]);
    }

    const giftAmount = data.gift?.amount ?? 0;

    return {
        id: data.id,
        platform: 'Kick',
        sent_at: data.created_at ? Date.parse(data.created_at) : receivedAt,
        received_at: receivedAt,
        is_placeholder: false,
        message: content,
        emojis,
        username: data.sender?.username ?? 'Unknown',
        avatar: data.sender?.profile_picture
            ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
        amount: giftAmount > 0 ? giftAmount / 100 : 0,
        currency: 'USD',
        is_verified: hasBadge(data.sender, 'verified'),
        is_sub: hasBadge(data.sender, 'subscriber', 'sub_gifter'),
        is_mod: hasBadge(data.sender, 'moderator'),
        is_owner: hasBadge(data.sender, 'broadcaster'),
        is_staff: hasBadge(data.sender, 'staff'),
        is_subscription: false,
        channel,
    };
}

export function parsePusherFrame(raw) {
    const frame = JSON.parse(raw.toString());
    return {
        event: frame.event,
        channel: frame.channel,
        data: parseJson(frame.data),
    };
}

export async function resolveChatroomId(channel) {
    const response = await fetch(`https://kick.com/${encodeURIComponent(channel)}`, {
        headers: {
            accept: 'text/html,application/xhtml+xml',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`Kick channel lookup returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const direct = html.match(/"chatroom"\s*:\s*\{\s*"id"\s*:\s*(\d+)/i);
    const escaped = html.match(/\\"chatroom\\"\s*:\s*\{\\"id\\"\s*:\s*(\d+)/i);
    const id = direct?.[1] ?? escaped?.[1];

    if (!id) {
        throw new Error('Kick channel page did not contain a chatroom ID');
    }

    return Number.parseInt(id, 10);
}

export class KickBridge {
    constructor({ channel, chatroomId, nexusUrl = DEFAULT_NEXUS_URL, verbose = false }) {
        this.channel = channel;
        this.chatroomId = chatroomId;
        this.nexusUrl = nexusUrl;
        this.verbose = verbose;
        this.kickSocket = null;
        this.nexusSocket = null;
        this.kickReconnectTimer = null;
        this.nexusReconnectTimer = null;
        this.healthTimer = null;
        this.kickAttempts = 0;
        this.nexusAttempts = 0;
        this.seenIds = new Set();
        this.queue = [];
        this.forwarded = 0;
        this.stopping = false;
    }

    log(scope, message) {
        console.log(`${timestamp()} [${scope}] ${message}`);
    }

    debug(scope, message) {
        if (this.verbose) this.log(scope, message);
    }

    start() {
        this.log('bridge', `Starting ${this.channel} (chatroom ${this.chatroomId}) -> ${this.nexusUrl}`);
        this.connectNexus();
        this.connectKick();
        this.healthTimer = setInterval(() => {
            this.log(
                'health',
                `kick=${this.kickSocket?.readyState ?? 'none'} nexus=${this.nexusSocket?.readyState ?? 'none'} queued=${this.queue.length} forwarded=${this.forwarded}`,
            );
        }, 30000);
    }

    stop() {
        this.stopping = true;
        if (this.kickReconnectTimer) clearTimeout(this.kickReconnectTimer);
        if (this.nexusReconnectTimer) clearTimeout(this.nexusReconnectTimer);
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.kickSocket?.close(1000, 'Bridge stopping');
        this.nexusSocket?.close(1000, 'Bridge stopping');
    }

    reconnectDelay(attempt) {
        return Math.min(30000, 1000 * (2 ** Math.min(attempt, 5))) + Math.floor(Math.random() * 500);
    }

    connectNexus() {
        if (this.stopping) return;

        const socket = new WebSocket(this.nexusUrl);
        this.nexusSocket = socket;

        socket.on('open', () => {
            if (socket !== this.nexusSocket) return;
            this.nexusAttempts = 0;
            this.log('nexus', `Connected; flushing ${this.queue.length} queued update(s)`);
            while (this.queue.length > 0 && socket.readyState === WebSocket.OPEN) {
                socket.send(this.queue.shift());
            }
        });

        socket.on('close', (code, reason) => {
            if (socket !== this.nexusSocket || this.stopping) return;
            this.nexusSocket = null;
            const delay = this.reconnectDelay(this.nexusAttempts++);
            this.log('nexus', `Disconnected (${code} ${reason.toString()}); reconnecting in ${delay}ms`);
            this.nexusReconnectTimer = setTimeout(() => this.connectNexus(), delay);
        });

        socket.on('error', (error) => {
            this.log('nexus', `Socket error: ${error.message}`);
        });
    }

    connectKick() {
        if (this.stopping) return;

        const socket = new WebSocket(PUSHER_URL, {
            headers: { origin: 'https://kick.com' },
        });
        this.kickSocket = socket;

        socket.on('open', () => {
            if (socket !== this.kickSocket) return;
            this.kickAttempts = 0;
            socket.send(JSON.stringify({
                event: 'pusher:subscribe',
                data: {
                    auth: '',
                    channel: `chatrooms.${this.chatroomId}.v2`,
                },
            }));
            this.log('kick', `Connected and subscribed to chatrooms.${this.chatroomId}.v2`);
        });

        socket.on('message', (raw) => {
            try {
                this.handleKickFrame(socket, raw);
            } catch (error) {
                this.log('kick', `Could not parse frame: ${error.message}`);
            }
        });

        socket.on('close', (code, reason) => {
            if (socket !== this.kickSocket || this.stopping) return;
            this.kickSocket = null;
            const delay = this.reconnectDelay(this.kickAttempts++);
            this.log('kick', `Disconnected (${code} ${reason.toString()}); reconnecting in ${delay}ms`);
            this.kickReconnectTimer = setTimeout(() => this.connectKick(), delay);
        });

        socket.on('error', (error) => {
            this.log('kick', `Socket error: ${error.message}`);
        });
    }

    handleKickFrame(socket, raw) {
        const frame = parsePusherFrame(raw);

        if (frame.event === 'pusher:ping') {
            socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
            return;
        }

        if (frame.event === 'pusher:connection_established'
            || frame.event === 'pusher_internal:subscription_succeeded') {
            this.debug('kick', frame.event);
            return;
        }

        if (frame.event === 'App\\Events\\ChatMessageEvent') {
            this.forwardChat(frame.data);
            return;
        }

        if (frame.event === 'App\\Events\\MessageDeletedEvent') {
            const id = frame.data?.message?.id;
            if (id) {
                this.sendToNexus({
                    platform: 'Kick',
                    channel: this.channel,
                    removals: [id],
                });
            }
            return;
        }

        this.debug('kick', `Ignored ${frame.event ?? 'unknown event'}`);
    }

    forwardChat(data) {
        if (!data?.id || this.seenIds.has(data.id)) return;

        this.seenIds.add(data.id);
        while (this.seenIds.size > MAX_SEEN_IDS) {
            const oldest = this.seenIds.values().next().value;
            if (!oldest) break;
            this.seenIds.delete(oldest);
        }

        const message = mapKickChatMessage(data, this.channel);
        this.sendToNexus({
            platform: 'Kick',
            channel: this.channel,
            messages: [message],
        });
        this.forwarded += 1;

        const preview = message.message.replace(/\s+/g, ' ').slice(0, 120);
        this.log('chat', `${message.username}: ${preview}`);
    }

    sendToNexus(update) {
        const serialized = JSON.stringify(update);
        if (this.nexusSocket?.readyState === WebSocket.OPEN) {
            this.nexusSocket.send(serialized);
            return;
        }

        if (this.queue.length >= MAX_QUEUED_UPDATES) {
            this.queue.shift();
            this.log('nexus', 'Queue full; dropped oldest update');
        }
        this.queue.push(serialized);
    }
}

function usage() {
    return [
        'Usage:',
        '  npm run bridge:kick -- --channel <slug> [--chatroom-id <id>] [--nexus-url <ws-url>] [--verbose]',
        '',
        'Example:',
        '  npm run bridge:kick -- --channel madattheinternet --chatroom-id 14693568',
    ].join('\n');
}

function parseArguments(argv) {
    const options = {
        channel: process.env.KICK_CHANNEL,
        chatroomId: process.env.KICK_CHATROOM_ID,
        nexusUrl: process.env.STREAM_NEXUS_URL ?? DEFAULT_NEXUS_URL,
        verbose: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case '--channel':
                options.channel = argv[++index];
                break;
            case '--chatroom-id':
                options.chatroomId = argv[++index];
                break;
            case '--nexus-url':
                options.nexusUrl = argv[++index];
                break;
            case '--verbose':
                options.verbose = true;
                break;
            case '--help':
            case '-h':
                console.log(usage());
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }

    return options;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (!options.channel) {
        throw new Error(`Missing --channel\n\n${usage()}`);
    }

    let chatroomId = Number.parseInt(options.chatroomId, 10);
    if (!Number.isFinite(chatroomId)) {
        console.log(`${timestamp()} [bridge] Resolving chatroom ID for ${options.channel}`);
        try {
            chatroomId = await resolveChatroomId(options.channel);
        } catch (error) {
            throw new Error(`${error.message}. Pass --chatroom-id explicitly.`);
        }
    }

    const bridge = new KickBridge({ ...options, chatroomId });
    bridge.start();

    const shutdown = (signal) => {
        bridge.log('bridge', `Received ${signal}; stopping`);
        bridge.stop();
        setTimeout(() => process.exit(0), 250).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
    main().catch((error) => {
        console.error(`${timestamp()} [bridge] Fatal: ${error.message}`);
        process.exitCode = 1;
    });
}
