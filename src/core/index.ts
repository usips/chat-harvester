/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Core module exports
 */

export { Config, DEFAULTS } from './config.js';
export type { ChuckConfig, PlatformConfig } from './config.js';
export { uuidv5 } from './uuid.js';
export { ChatMessage, LivestreamUpdate } from './message.js';
export type { EmojiTuple } from './message.js';
export { Seed, WINDOW } from './seed.js';
export type { PatchedWebSocket } from './seed.js';
export { Recorder, EventStatus, EventType } from './recorder.js';
export type { EventStatusType, EventTypeType, RecordedEvent, RecorderStats, RecorderExport } from './recorder.js';
