import { describe, expect, it } from 'vitest';
import kickEvents from '../fixtures/kick-events.json';
import {
    mapKickChatMessage,
    parsePusherFrame,
} from '../../scripts/kick-bridge.mjs';

describe('Kick standalone bridge', () => {
    it('parses Pusher frames and their nested JSON payload', () => {
        const frame = parsePusherFrame(JSON.stringify(kickEvents.ChatMessageEvent));

        expect(frame.event).toBe('App\\Events\\ChatMessageEvent');
        expect(frame.channel).toBe('chatrooms.2507974.v2');
        expect(frame.data.id).toBe('test-message-id-123');
    });

    it('maps Kick messages to the Stream Nexus message schema', () => {
        const data = JSON.parse(kickEvents.ChatMessageEvent.data);
        data.content = 'Hello [emote:37221:EZ]';

        const message = mapKickChatMessage(data, 'testchannel', 1700000000000);

        expect(message).toMatchObject({
            id: 'test-message-id-123',
            platform: 'Kick',
            username: 'TestUser',
            channel: 'testchannel',
            received_at: 1700000000000,
            is_sub: true,
        });
        expect(message.emojis).toEqual([
            ['[emote:37221:EZ]', 'https://files.kick.com/emotes/37221/fullsize', 'EZ'],
        ]);
    });

    it('converts paid-message cents to USD', () => {
        const data = JSON.parse(kickEvents.ChatMessageWithGift.data);
        const message = mapKickChatMessage(data, 'testchannel');

        expect(message.amount).toBe(5);
        expect(message.currency).toBe('USD');
    });
});
