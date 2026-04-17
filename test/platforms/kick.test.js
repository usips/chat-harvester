/**
 * CHUCK - Kick Platform Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import kickEvents from '../fixtures/kick-events.json';

// Mock browser globals before importing Kick
vi.stubGlobal('window', {
    location: { href: 'https://kick.com/testchannel' },
    WebSocket: class MockWebSocket {
        static OPEN = 1;
        static oldWebSocket = class {};
        addEventListener() {}
        send() {}
    },
    fetch: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    EventSource: class MockEventSource {},
    XMLHttpRequest: class MockXHR {
        prototype = { open: vi.fn(), send: vi.fn() };
    },
});

vi.stubGlobal('document', {
    addEventListener: vi.fn(),
});

vi.stubGlobal('unsafeWindow', undefined);

// Import after mocks are set up
const { ChatMessage } = await import('../../src/core/message.js');
const { Kick } = await import('../../src/platforms/kick.js');

describe('Kick Platform', () => {
    describe('prepareChatMessage', () => {
        let kick;

        beforeEach(() => {
            // Create a minimal Kick instance for testing parser functions
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
        });

        it('should parse a standard chat message', () => {
            const event = kickEvents.ChatMessageEvent;
            const data = JSON.parse(event.data);

            const message = kick.prepareChatMessage(data);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.username).toBe('TestUser');
            expect(message.message).toBe('Hello world!');
            expect(message.is_sub).toBe(true);
            expect(message.amount).toBe(0); // No gift = 0 amount
        });

        it('should parse a chat message with gift (paid message)', () => {
            const event = kickEvents.ChatMessageWithGift;
            const data = JSON.parse(event.data);

            const message = kick.prepareChatMessage(data);

            expect(message.username).toBe('BigDonor');
            expect(message.message).toBe('Thanks for the stream!');
            expect(message.amount).toBe(5); // 500 cents = $5
            expect(message.currency).toBe('USD');
        });

        it('should handle emotes in messages', () => {
            const data = {
                id: 'emote-test',
                content: 'Hello [emote:37221:EZ] world [emote:12345:Kappa]',
                created_at: '2024-01-15T12:00:00.000000Z',
                sender: {
                    username: 'EmoteUser',
                    identity: { badges: [] }
                }
            };

            const message = kick.prepareChatMessage(data);

            expect(message.emojis).toHaveLength(2);
            expect(message.emojis[0][0]).toBe('[emote:37221:EZ]');
            expect(message.emojis[0][1]).toBe('https://files.kick.com/emotes/37221/fullsize');
            expect(message.emojis[0][2]).toBe('EZ');
        });

        it('should identify broadcaster badge', () => {
            const data = {
                id: 'broadcaster-test',
                content: 'Hello',
                created_at: '2024-01-15T12:00:00.000000Z',
                sender: {
                    username: 'Broadcaster',
                    identity: { badges: [{ type: 'broadcaster' }] }
                }
            };

            const message = kick.prepareChatMessage(data);

            expect(message.is_owner).toBe(true);
        });

        it('should identify moderator badge', () => {
            const data = {
                id: 'mod-test',
                content: 'Hello',
                created_at: '2024-01-15T12:00:00.000000Z',
                sender: {
                    username: 'Moderator',
                    identity: { badges: [{ type: 'moderator' }] }
                }
            };

            const message = kick.prepareChatMessage(data);

            expect(message.is_mod).toBe(true);
        });

        it('should identify verified badge', () => {
            const data = {
                id: 'verified-test',
                content: 'Hello',
                created_at: '2024-01-15T12:00:00.000000Z',
                sender: {
                    username: 'VerifiedUser',
                    identity: { badges: [{ type: 'verified' }] }
                }
            };

            const message = kick.prepareChatMessage(data);

            expect(message.is_verified).toBe(true);
        });
    });

    describe('SubscriptionGifted event', () => {
        let kick;

        beforeEach(() => {
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
            kick.viewers = null;
            kick.chatSocket = null;
            kick.updateQueue = [];
            kick.chatMessageQueue = [];
            kick.recorder = { recordChatMessage: vi.fn() };
        });

        it('should parse new format multi-user gifted subs', () => {
            const event = kickEvents.SubscriptionGifted;
            const data = JSON.parse(event.data);

            // Simulate what onWebSocketMessage does for the new format
            let buyer, count, id;
            if ('user' in data && data.gifted_users) {
                buyer = data.user.username;
                count = data.gifted_users.length;
                id = data.id;
            }

            expect(buyer).toBe('Profileo');
            expect(count).toBe(5);
            expect(id).toBe('328bc7ec-1ffe-48f2-ab09-abd5998b63b8');
        });

        it('should parse new format single-user gifted sub', () => {
            const event = kickEvents.SubscriptionGiftedSingle;
            const data = JSON.parse(event.data);

            expect(data.user.username).toBe('Atomic_Angel');
            expect(data.gifted_users).toHaveLength(1);
            expect(data.gifted_users[0].username).toBe('Judachu');
        });

        it('should parse legacy format gifted subs', () => {
            const event = kickEvents.GiftedSubscriptionsEventLegacy;
            const data = JSON.parse(event.data);

            let buyer, count;
            if ('gifter_username' in data) {
                buyer = data.gifter_username;
                count = data.gifted_usernames.length;
            }

            expect(buyer).toBe('court');
            expect(count).toBe(1);
        });

        it('should parse real unprefixed GiftedSubscriptionsEvent 5-user gift', () => {
            const event = kickEvents.GiftedSubscriptionsEventUnprefixed;
            expect(event.event).toBe('GiftedSubscriptionsEvent');

            const data = JSON.parse(event.data);

            let buyer, count;
            if ('gifter_username' in data) {
                buyer = data.gifter_username;
                count = data.gifted_usernames.length;
            }

            expect(buyer).toBe('Mr_Homeless');
            expect(count).toBe(5);

            kick.receiveSubscriptions({
                id: `${Date.now()}_${buyer}`,
                gifted: true,
                buyer,
                count,
                value: 5,
            });

            const msg = kick.updateQueue[0].messages[0];
            expect(msg.username).toBe('Mr_Homeless');
            expect(msg.amount).toBe(25);
            expect(msg.message).toBe('Mr_Homeless gifted 5 subscriptions!');
        });

        it('should create subscription message via receiveSubscriptions for new format', () => {
            const event = kickEvents.SubscriptionGifted;
            const data = JSON.parse(event.data);

            kick.receiveSubscriptions({
                id: data.id,
                gifted: true,
                buyer: data.user.username,
                count: data.gifted_users.length,
                value: 5,
            });

            // receiveSubscriptions calls sendChatMessages which queues
            expect(kick.updateQueue.length).toBe(1);
            const update = kick.updateQueue[0];
            expect(update.messages).toHaveLength(1);

            const msg = update.messages[0];
            expect(msg.username).toBe('Profileo');
            expect(msg.amount).toBe(25); // 5 * 5 gifted
            expect(msg.currency).toBe('USD');
            expect(msg.is_subscription).toBe(true);
            expect(msg.message).toBe('Profileo gifted 5 subscriptions!');
        });

        it('should create subscription message for single gift', () => {
            const event = kickEvents.SubscriptionGiftedSingle;
            const data = JSON.parse(event.data);

            kick.receiveSubscriptions({
                id: data.id,
                gifted: true,
                buyer: data.user.username,
                count: data.gifted_users.length,
                value: 5,
            });

            const msg = kick.updateQueue[0].messages[0];
            expect(msg.username).toBe('Atomic_Angel');
            expect(msg.amount).toBe(5); // 5 * 1 gifted
            expect(msg.message).toBe('Atomic_Angel gifted a subscription!');
        });

        it('should announce a 100-sub gift at $500 tier', () => {
            kick.receiveSubscriptions({
                id: `${Date.now()}_BigTipper`,
                gifted: true,
                buyer: 'BigTipper',
                count: 100,
                value: 5,
            });

            const msg = kick.updateQueue[0].messages[0];
            expect(msg.username).toBe('BigTipper');
            expect(msg.amount).toBe(500);
            expect(msg.currency).toBe('USD');
            expect(msg.is_subscription).toBe(true);
            expect(msg.message).toBe('BigTipper gifted 100 subscriptions!');
        });

        it('should prefer gifted_total over gifted_usernames.length for count', () => {
            // Hypothetical scenario where Kick truncates the usernames array
            // for display but keeps gifted_total as the full count.
            const data = {
                chatroom_id: 14693568,
                gifted_usernames: ['user1', 'user2', 'user3'], // truncated
                gifter_username: 'WhaleSub',
                gifted_total: 100, // full count
                gifter_total: 100,
                chunk_details: null,
            };

            const count = data.gifted_total ?? data.gifted_usernames.length;
            expect(count).toBe(100);

            kick.receiveSubscriptions({
                id: `${Date.now()}_${data.gifter_username}`,
                gifted: true,
                buyer: data.gifter_username,
                count,
                value: 5,
            });

            const msg = kick.updateQueue[0].messages[0];
            expect(msg.amount).toBe(500);
            expect(msg.message).toBe('WhaleSub gifted 100 subscriptions!');
        });
    });

    describe('KicksGifted event', () => {
        let kick;

        beforeEach(() => {
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
        });

        it('should parse KicksGifted with dedicated method', () => {
            const event = kickEvents.KicksGifted;
            const data = JSON.parse(event.data);

            const message = kick.prepareKicksGiftedMessage(data);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.username).toBe('Reds_cat');
            expect(message.amount).toBe(1);
            expect(message.currency).toBe('KICKS');
            expect(message.message).toContain('Hell Yeah');
        });

        it('should generate ID with sender info for KicksGifted messages', () => {
            const event = kickEvents.KicksGifted;
            const data = JSON.parse(event.data);

            const message = kick.prepareKicksGiftedMessage(data);

            // ID should contain sender ID and timestamp
            expect(message.id).toContain('kicks_57598142_');
        });

        it('should have gift data that can be extracted', () => {
            const event = kickEvents.KicksGifted;
            const data = JSON.parse(event.data);

            // Document what we extract:
            expect(data.gift).toBeDefined();
            expect(data.gift.gift_id).toBe('hell_yeah');
            expect(data.gift.name).toBe('Hell Yeah');
            expect(data.gift.amount).toBe(1);
            expect(data.gift.type).toBe('BASIC');
            expect(data.gift.tier).toBe('BASIC');
        });

        it('should parse LEVEL_UP tier KicksGifted with all fields', () => {
            const event = kickEvents.KicksGiftedLevelUp;
            const data = JSON.parse(event.data);

            const message = kick.prepareKicksGiftedMessage(data);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.id).toBe('c3aad5e3-688d-413a-9f93-4834413f750c'); // Uses gift_transaction_id
            expect(message.username).toBe('alalisa11');
            expect(message.message).toBe('لازم يكون فقرة تنظيف الغرفة شطف ومسح');
            expect(message.amount).toBe(1000);
            expect(message.currency).toBe('KICKS');
            expect(message.avatar).toBe('https://kick.com/img/default-profile-pictures/default-avatar-4.webp');
            // Verify timestamp was parsed from created_at
            expect(message.sent_at).toBe(Date.parse('2026-01-14T17:58:57.996338008Z'));
        });

        it('should handle LEVEL_UP tier gift data', () => {
            const event = kickEvents.KicksGiftedLevelUp;
            const data = JSON.parse(event.data);

            expect(data.gift.gift_id).toBe('pack_it_up');
            expect(data.gift.name).toBe('Pack It Up');
            expect(data.gift.amount).toBe(1000);
            expect(data.gift.type).toBe('LEVEL_UP');
            expect(data.gift.tier).toBe('MID');
            expect(data.created_at).toBeDefined();
            expect(data.expires_at).toBeDefined();
            expect(data.gift_transaction_id).toBeDefined();
        });
    });

    describe('Fuzzing: prepareChatMessage robustness', () => {
        let kick;

        beforeEach(() => {
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
        });

        it('should not crash on malformed message data', () => {
            fc.assert(
                fc.property(
                    fc.record({
                        id: fc.oneof(fc.string(), fc.constant(undefined)),
                        content: fc.oneof(fc.string(), fc.constant(undefined)),
                        created_at: fc.oneof(fc.string(), fc.constant(undefined)),
                        sender: fc.oneof(
                            fc.record({
                                username: fc.oneof(fc.string(), fc.constant(undefined)),
                                identity: fc.oneof(
                                    fc.record({
                                        badges: fc.oneof(
                                            fc.array(fc.record({ type: fc.string() })),
                                            fc.constant(undefined)
                                        )
                                    }),
                                    fc.constant(undefined)
                                )
                            }),
                            fc.constant(undefined)
                        ),
                        gift: fc.oneof(
                            fc.record({
                                amount: fc.oneof(fc.integer(), fc.constant(undefined))
                            }),
                            fc.constant(undefined)
                        )
                    }),
                    (data) => {
                        // Should not throw
                        try {
                            kick.prepareChatMessage(data);
                            return true;
                        } catch (e) {
                            // Document what input caused the crash
                            console.error('Crash on input:', JSON.stringify(data));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle random string content without crashing', () => {
            fc.assert(
                fc.property(fc.string(), (content) => {
                    const data = {
                        id: 'fuzz-test',
                        content: content,
                        created_at: '2024-01-15T12:00:00.000000Z',
                        sender: {
                            username: 'FuzzUser',
                            identity: { badges: [] }
                        }
                    };

                    const message = kick.prepareChatMessage(data);
                    expect(message.message).toBe(content);
                    return true;
                }),
                { numRuns: 100 }
            );
        });

        it('should handle various badge types without crashing', () => {
            fc.assert(
                fc.property(fc.array(fc.string()), (badgeTypes) => {
                    const data = {
                        id: 'badge-fuzz',
                        content: 'Test',
                        created_at: '2024-01-15T12:00:00.000000Z',
                        sender: {
                            username: 'BadgeUser',
                            identity: { badges: badgeTypes.map(t => ({ type: t })) }
                        }
                    };

                    // Should not throw
                    kick.prepareChatMessage(data);
                    return true;
                }),
                { numRuns: 50 }
            );
        });
    });

    describe('Real recording data tests', () => {
        let kick;

        beforeEach(() => {
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
        });

        it('should parse all real recorded messages without errors', () => {
            const realMessages = kickEvents.realRecordingMessages;

            for (const event of realMessages) {
                const data = JSON.parse(event.data);
                const message = kick.prepareChatMessage(data);

                expect(message).toBeInstanceOf(ChatMessage);
                expect(message.username).toBeTruthy();
                expect(message.id).toBeTruthy();
            }
        });

        it('should correctly parse real message with emotes', () => {
            // First real message contains [emote:4147814:OuttaPocket]
            const event = kickEvents.realRecordingMessages[0];
            const data = JSON.parse(event.data);
            const message = kick.prepareChatMessage(data);

            expect(message.username).toBe('CrispyLegs');
            expect(message.emojis).toHaveLength(1);
            expect(message.emojis[0][2]).toBe('OuttaPocket');
        });

        it('should correctly parse real message with moderator badge', () => {
            // CrispyLegs has moderator badge
            const event = kickEvents.realRecordingMessages[0];
            const data = JSON.parse(event.data);
            const message = kick.prepareChatMessage(data);

            expect(message.is_mod).toBe(true);
        });

        it('should correctly parse real message with subscriber badge', () => {
            // tuqos has subscriber badge with count 6
            const event = kickEvents.realRecordingMessages[2];
            const data = JSON.parse(event.data);
            const message = kick.prepareChatMessage(data);

            expect(message.is_sub).toBe(true);
            expect(message.username).toBe('tuqos');
        });

        it('should correctly parse real KicksGifted event', () => {
            const event = kickEvents.realKicksGifted;
            const data = JSON.parse(event.data);
            const message = kick.prepareKicksGiftedMessage(data);

            expect(message).toBeInstanceOf(ChatMessage);
            expect(message.username).toBe('BestSlime');
            expect(message.amount).toBe(100);
            expect(message.currency).toBe('KICKS');
        });
    });

    describe('Real data mutation fuzzing', () => {
        let kick;

        beforeEach(() => {
            kick = Object.create(Kick.prototype);
            kick.platform = 'Kick';
            kick.channel = 'testchannel';
            kick.namespace = Kick.namespace;
            kick.log = vi.fn();
            kick.warn = vi.fn();
        });

        it('should handle mutations of real message content', () => {
            const realEvent = kickEvents.realRecordingMessages[0];
            const baseData = JSON.parse(realEvent.data);

            fc.assert(
                fc.property(fc.string(), (content) => {
                    const mutatedData = { ...baseData, content };
                    try {
                        kick.prepareChatMessage(mutatedData);
                        return true;
                    } catch (e) {
                        console.error('Crash on mutated content:', content);
                        return false;
                    }
                }),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real message sender', () => {
            const realEvent = kickEvents.realRecordingMessages[0];
            const baseData = JSON.parse(realEvent.data);

            fc.assert(
                fc.property(
                    fc.record({
                        id: fc.integer(),
                        username: fc.string(),
                        slug: fc.string(),
                        identity: fc.record({
                            color: fc.string(),
                            badges: fc.array(fc.record({
                                type: fc.string(),
                                text: fc.option(fc.string(), { nil: undefined }),
                                count: fc.option(fc.integer(), { nil: undefined })
                            }))
                        })
                    }),
                    (sender) => {
                        const mutatedData = { ...baseData, sender };
                        try {
                            kick.prepareChatMessage(mutatedData);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated sender:', JSON.stringify(sender));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should handle mutations of real KicksGifted gift field', () => {
            const realEvent = kickEvents.realKicksGifted;
            const baseData = JSON.parse(realEvent.data);

            fc.assert(
                fc.property(
                    fc.record({
                        gift_id: fc.string(),
                        name: fc.string(),
                        amount: fc.integer(),
                        type: fc.constantFrom('BASIC', 'LEVEL_UP', 'PREMIUM'),
                        tier: fc.constantFrom('BASIC', 'MID', 'HIGH'),
                        character_limit: fc.integer(),
                        pinned_time: fc.integer()
                    }),
                    (gift) => {
                        const mutatedData = { ...baseData, gift };
                        try {
                            kick.prepareKicksGiftedMessage(mutatedData);
                            return true;
                        } catch (e) {
                            console.error('Crash on mutated gift:', JSON.stringify(gift));
                            return false;
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
