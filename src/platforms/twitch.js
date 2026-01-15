/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Twitch platform scraper
 *
 * Twitch uses IRC-over-WebSocket for chat messages.
 * Format: @metadata :user!user@user.tmi.twitch.tv COMMAND #channel :message
 */

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';

export class Twitch extends Seed {
    static hostname = 'twitch.tv';
    static namespace = '4a342b79-e302-403a-99be-669b5f27b152';

    constructor() {
        const is_popout = window.location.href.indexOf('/popout/') >= 0;
        const channel = window.location.href.split('/').filter(x => x).at(is_popout ? 3 : 2);

        if (channel === 'p') {
            console.log('[CHUCK::Twitch] Within Twitch static /p/ directory: terminating.');
            return null;
        }

        super(Twitch.namespace, 'Twitch', channel);
    }

    /**
     * Parse IRC message tags (metadata) from Twitch format
     * @param {string} tagsStr - Tags string without leading @
     * @returns {Object} Parsed tags as key-value pairs
     */
    parseIrcTags(tagsStr) {
        const tags = {};
        if (!tagsStr) return tags;

        const pairs = tagsStr.split(';');
        for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) {
                tags[pair] = '';
            } else {
                const key = pair.slice(0, eqIdx);
                const value = pair.slice(eqIdx + 1);
                // Unescape IRC tag values
                tags[key] = value
                    .replace(/\\s/g, ' ')
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\:/g, ';')
                    .replace(/\\\\/g, '\\');
            }
        }
        return tags;
    }

    /**
     * Parse full IRC message into structured JSON
     * Format: @tags :prefix COMMAND params :trailing
     * @param {string} message - Raw IRC message
     * @returns {Object} Parsed message
     */
    parseIrcMessageToJson(message) {
        const result = {
            raw: message,
            tags: {},
            prefix: null,
            command: null,
            params: [],
            trailing: null
        };

        let remaining = message;

        // Parse tags if present
        if (remaining.startsWith('@')) {
            const spaceIdx = remaining.indexOf(' ');
            if (spaceIdx === -1) return result;
            result.tags = this.parseIrcTags(remaining.slice(1, spaceIdx));
            remaining = remaining.slice(spaceIdx + 1);
        }

        // For backwards compatibility with older parseIrcMessageToJson usage
        result.meta = result.tags;

        // Parse prefix if present
        if (remaining.startsWith(':')) {
            const spaceIdx = remaining.indexOf(' ');
            if (spaceIdx === -1) return result;
            result.prefix = remaining.slice(1, spaceIdx);
            remaining = remaining.slice(spaceIdx + 1);
        }

        // Find trailing (after " :")
        const trailingIdx = remaining.indexOf(' :');
        let commandAndParams;
        if (trailingIdx !== -1) {
            result.trailing = remaining.slice(trailingIdx + 2);
            commandAndParams = remaining.slice(0, trailingIdx);
        } else {
            commandAndParams = remaining;
        }

        // Parse command and params
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
     * @param {string} prefix - IRC prefix
     * @returns {string} Username or null
     */
    extractUsername(prefix) {
        if (!prefix) return null;
        const bangIdx = prefix.indexOf('!');
        if (bangIdx === -1) return prefix;
        return prefix.slice(0, bangIdx);
    }

    /**
     * Check if a badge type is present in badges string
     * Format: badge1/version,badge2/version,...
     * @param {string} badges - Badges string
     * @param {string} type - Badge type to check for
     * @returns {boolean}
     */
    hasBadge(badges, type) {
        if (!badges) return false;
        return badges.split(',').some(b => b.startsWith(type + '/'));
    }

    /**
     * Parse Twitch emotes string into array
     * Format: emote_id:start-end,start-end/emote_id:start-end
     * @param {string} emotesStr - Emotes string from IRC tags
     * @param {string} message - Original message text
     * @returns {Array} Array of [placeholder, url, name] tuples
     */
    parseEmotes(emotesStr, message) {
        if (!emotesStr || !message) return [];

        const emotes = [];
        const emoteGroups = emotesStr.split('/');

        for (const group of emoteGroups) {
            if (!group) continue;
            const colonIdx = group.indexOf(':');
            if (colonIdx === -1) continue;

            const emoteId = group.slice(0, colonIdx);
            const positions = group.slice(colonIdx + 1).split(',');

            for (const pos of positions) {
                const [startStr, endStr] = pos.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);

                if (!isNaN(start) && !isNaN(end) && start <= end && end < message.length) {
                    const emoteName = message.slice(start, end + 1);
                    const emoteUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`;
                    emotes.push([emoteName, emoteUrl, emoteName]);
                }
            }
        }

        return emotes;
    }

    /**
     * Convert parsed IRC PRIVMSG to ChatMessage
     * @param {Object} parsed - Parsed IRC message
     * @returns {ChatMessage|null}
     */
    prepareChatMessage(parsed) {
        const tags = parsed.tags || parsed.meta || {};
        const messageText = parsed.trailing || '';

        // Extract required fields
        const id = tags['id'];
        const username = tags['display-name'] || this.extractUsername(parsed.prefix) || 'Unknown';

        if (!id) {
            this.warn('PRIVMSG missing id:', parsed.raw);
            return null;
        }

        const message = new ChatMessage(id, this.platform, this.channel);

        // Set message content
        message.message = messageText;
        message.username = username;

        // Parse timestamp
        const tmiSentTs = tags['tmi-sent-ts'];
        message.sent_at = tmiSentTs ? parseInt(tmiSentTs, 10) : Date.now();

        // Parse badges
        const badges = tags['badges'] || '';
        message.is_owner = this.hasBadge(badges, 'broadcaster');
        message.is_mod = tags['mod'] === '1' || this.hasBadge(badges, 'moderator');
        message.is_sub = tags['subscriber'] === '1' || this.hasBadge(badges, 'subscriber');
        message.is_verified = this.hasBadge(badges, 'partner');

        // Parse emotes
        message.emojis = this.parseEmotes(tags['emotes'], messageText);

        // Store extra data (Twitch doesn't include avatar in IRC, so leave default)
        message.extra = {
            userId: tags['user-id'],
            color: tags['color'] || '',
            badges: badges
        };

        return message;
    }

    /**
     * Handle incoming WebSocket messages
     * @param {WebSocket} ws - WebSocket instance
     * @param {MessageEvent} event - Message event
     */
    onWebSocketMessage(ws, event) {
        const data = event.data;
        if (typeof data !== 'string') {
            this.recordWebSocketIgnored(ws, 'in', data, 'BINARY', 'Non-string data');
            return;
        }

        // IRC messages can be batched with \r\n
        const lines = data.split('\r\n').filter(l => l);

        for (const line of lines) {
            this.processIrcLine(ws, line);
        }
    }

    /**
     * Process a single IRC line
     * @param {WebSocket} ws - WebSocket instance
     * @param {string} line - IRC line
     */
    processIrcLine(ws, line) {
        // Handle PING
        if (line === 'PING :tmi.twitch.tv') {
            this.recordWebSocketIgnored(ws, 'in', line, 'PING', 'Keepalive ping');
            return;
        }

        const parsed = this.parseIrcMessageToJson(line);

        switch (parsed.command) {
            case 'PRIVMSG': {
                const message = this.prepareChatMessage(parsed);
                if (message) {
                    this.postChatMessage(message);
                    this.recordWebSocketHandled(ws, 'in', line, 'PRIVMSG');
                } else {
                    this.recordWebSocketIgnored(ws, 'in', line, 'PRIVMSG', 'Failed to parse');
                }
                break;
            }

            case 'USERNOTICE': {
                // USERNOTICE includes subs, resubs, gift subs, raids, etc.
                const msgId = parsed.tags['msg-id'];
                if (msgId === 'sub' || msgId === 'resub' || msgId === 'subgift' || msgId === 'submysterygift') {
                    // Subscription event - could emit as a special message
                    this.recordWebSocketIgnored(ws, 'in', line, 'USERNOTICE_SUB', `Subscription: ${msgId}`);
                } else if (msgId === 'raid') {
                    this.recordWebSocketIgnored(ws, 'in', line, 'USERNOTICE_RAID', 'Raid notification');
                } else {
                    this.recordWebSocketIgnored(ws, 'in', line, 'USERNOTICE', `msg-id: ${msgId}`);
                }
                break;
            }

            case 'CLEARCHAT': {
                // User timeout/ban or chat clear
                this.recordWebSocketIgnored(ws, 'in', line, 'CLEARCHAT', 'Moderation action');
                break;
            }

            case 'CLEARMSG': {
                // Single message deletion
                this.recordWebSocketIgnored(ws, 'in', line, 'CLEARMSG', 'Message deleted');
                break;
            }

            case 'ROOMSTATE': {
                // Room settings changed
                this.recordWebSocketIgnored(ws, 'in', line, 'ROOMSTATE', 'Room state update');
                break;
            }

            case 'USERSTATE':
            case 'GLOBALUSERSTATE': {
                // User's state in channel
                this.recordWebSocketIgnored(ws, 'in', line, parsed.command, 'User state');
                break;
            }

            case 'NOTICE': {
                // System notices
                this.recordWebSocketIgnored(ws, 'in', line, 'NOTICE', 'System notice');
                break;
            }

            case 'JOIN':
            case 'PART': {
                // User join/leave (usually not needed)
                this.recordWebSocketIgnored(ws, 'in', line, parsed.command, 'Channel join/part');
                break;
            }

            case 'CAP':
            case '001':
            case '002':
            case '003':
            case '004':
            case '353':
            case '366':
            case '372':
            case '375':
            case '376': {
                // Connection/capability negotiation and MOTD
                this.recordWebSocketIgnored(ws, 'in', line, 'IRC_INIT', 'Connection initialization');
                break;
            }

            case 'RECONNECT': {
                // Server requesting reconnect
                this.recordWebSocketIgnored(ws, 'in', line, 'RECONNECT', 'Reconnect requested');
                break;
            }

            default: {
                if (parsed.command) {
                    this.recordWebSocketUnhandled(ws, 'in', line, parsed.command);
                } else {
                    this.recordWebSocketUnhandled(ws, 'in', line, 'UNKNOWN');
                }
            }
        }
    }

    /**
     * Handle outgoing WebSocket messages
     * @param {WebSocket} ws - WebSocket instance
     * @param {string} message - Outgoing message
     */
    onWebSocketSend(ws, message) {
        if (typeof message !== 'string') return;

        const parsed = this.parseIrcMessageToJson(message);
        const reason = parsed.command || 'IRC_SEND';
        this.recordWebSocketIgnored(ws, 'out', message, reason, 'Outgoing IRC command');
    }
}

export default Twitch;
