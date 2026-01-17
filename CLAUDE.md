# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CHUCK (Chat Harvesting Universal Connection Kit) is a multi-platform livestream chat scraper that intercepts chat messages from streaming platforms and forwards them to a WebSocket backend (SNEED). Runs as both a userscript (Tampermonkey/Greasemonkey) and browser extensions (Chrome/Firefox).

## Build & Test Commands

```bash
# Testing
npm test                        # Run all tests
npm run test:watch              # Watch mode
npm run test:coverage           # Coverage report
npm run test:fuzz               # Fuzzing tests only
npx vitest run test/platforms/kick.test.js  # Run single test file

# Type checking
npm run typecheck               # TypeScript type check (tsc --noEmit)

# Building
npm run build                   # Build everything
npm run build:userscript        # Userscript only → dist/chuck.user.js
npm run build:extension         # Both extensions
npm run build:extension:chrome  # Chrome only
npm run build:extension:firefox # Firefox only
npm run watch:userscript        # Watch mode for userscript
```

## Architecture

**Core flow:** Platform API intercept → Platform scraper → `ChatMessage` → `LivestreamUpdate` → WebSocket → SNEED

### Core Components (src/core/)

- **Seed** (`seed.ts`): Base class all platform scrapers extend. Patches WebSocket, Fetch, EventSource, and XHR to intercept network traffic. Manages connection to SNEED backend.
- **ChatMessage** (`message.ts`): Standardized message format with metadata (badges, donation amounts, emojis, currencies)
- **Config** (`config.ts`): Storage abstraction for userscript (GM_getValue) vs extension (chrome.storage)
- **Recorder** (`recorder.ts`): Debug recording system for capturing traffic

### Platform Scrapers (src/platforms/)

Each platform (Kick, YouTube, Twitch, Rumble, Odysee, VK, X, Facebook, XMRChat) extends `Seed` and implements:
- Platform-specific message parsing
- Badge/tier handling
- Currency/donation parsing

Platform detection via hostname matching in `src/platforms/index.ts`.

### Entry Points

- `src/userscript.ts` - Userscript entry
- `src/content-script.ts` - Browser extension content script

## Adding a New Platform

1. Create `src/platforms/{platform}.ts` extending `Seed`:
   ```typescript
   import { Seed, ChatMessage, uuidv5 } from '../core/index.js';

   export default class NewPlatform extends Seed {
       static hostname = 'example.com';
       static namespace = 'uuid-v4-here';  // Generate unique namespace

       constructor() {
           const channel = /* extract from URL */;
           super(NewPlatform.namespace, 'NewPlatform', channel);
       }
       // Override onWebSocketMessage() or onFetchResponse() to intercept traffic
   }
   ```
2. Register in `src/platforms/index.ts`: `registerPlatform('example.com', NewPlatform);`
3. Add test fixtures in `test/fixtures/{platform}-events.json` with real WebSocket payloads

## Testing Conventions

- Tests use Vitest with jsdom environment; mock browser globals before importing platform classes
- Fixtures in `test/fixtures/` contain real WebSocket event payloads captured from platforms
- Use `Object.create(Platform.prototype)` pattern to test parser methods in isolation without full initialization
- Property-based fuzzing via fast-check for parser robustness

## Notes

- **Deterministic IDs**: UUIDv5 with platform-specific namespaces prevents duplicate messages
- **Debug Recording**: `chuck.startRecording()`, `chuck.downloadRecording()`, `chuck.getRecordingStats()`
- **X/Twitter CSP**: Blocks outbound WebSocket; requires CSP modifier extension or browser extension version
- **Twitch**: IRC parsing incomplete (TODO)
- **Facebook**: Uses binary MQTT over WebSocket; comment parsing via `live_video_comment_create_subscribe`
- **Default server**: `ws://127.0.0.2:1350/chat.ws`

## Related Project

Works with [SNEED](https://github.com/usips/stream-nexus) (Stream Nexus) - the backend server that receives and processes chat messages.
