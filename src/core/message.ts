/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Message data structures
 */

/** Emoji tuple: [find pattern, replace URL, alt text] */
export type EmojiTuple = [string, string, string];

/**
 * Represents an update to be sent to the backend server
 */
export class LivestreamUpdate {
    platform: string;
    channel: string;
    messages?: ChatMessage[];
    removals?: string[];
    viewers?: number;

    constructor(platform: string, channel: string) {
        this.platform = platform;
        this.channel = channel;
        this.messages = undefined;
        this.removals = undefined;
        this.viewers = undefined;
    }
}

/**
 * Represents a chat message from any platform
 */
export class ChatMessage {
    id: string;
    platform: string;
    channel: string;
    sent_at: number;
    received_at: number;
    is_placeholder: boolean;

    message: string;
    emojis: EmojiTuple[];

    username: string;
    avatar: string;

    amount: number;
    currency: string;

    is_verified: boolean;
    is_sub: boolean;
    is_mod: boolean;
    is_owner: boolean;
    is_staff: boolean;

    constructor(id: string, platform: string, channel: string) {
        this.id = id;
        this.platform = platform;
        this.channel = channel;
        this.sent_at = Date.now(); // System timestamp for display ordering
        this.received_at = Date.now(); // Local timestamp for management
        this.is_placeholder = false;

        this.message = '';
        this.emojis = []; // Array of [find, replace, alt] tuples

        this.username = 'DUMMY_USER';
        this.avatar = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; // Transparent pixel

        this.amount = 0;
        this.currency = 'ZWL';

        this.is_verified = false;
        this.is_sub = false;
        this.is_mod = false;
        this.is_owner = false;
        this.is_staff = false;
    }
}
