# CHUCK - Copilot Instructions

CHUCK (Chat Harvesting Universal Connection Kit) is a multi-platform livestream chat scraper that intercepts chat messages and forwards them to [SNEED](https://github.com/usips/stream-nexus) via WebSocket. Runs as both a userscript and browser extensions.

## Architecture

**Core flow:** Platform API intercept → Platform scraper → `ChatMessage` → `LivestreamUpdate` → WebSocket → SNEED

- **Seed** ([src/core/seed.js](src/core/seed.js)): Base class that patches `WebSocket`, `Fetch`, `EventSource`, and `XHR` to intercept network traffic. All platform scrapers extend this.
- **Platform scrapers** ([src/platforms/](src/platforms/)): Each file extends `Seed` with platform-specific message parsing. Registered by hostname in [src/platforms/index.js](src/platforms/index.js).
- **ChatMessage** ([src/core/message.js](src/core/message.js)): Normalized message format with badges, donations, emojis, currencies.

## Adding a New Platform

1. Create `src/platforms/{platform}.js` extending `Seed`:
   ```javascript
   import { Seed, ChatMessage } from '../core/index.js';
   export class NewPlatform extends Seed {
       static hostname = 'example.com';
       static namespace = 'uuid-v4-here';  // Generate unique namespace for deterministic IDs
       constructor() {
           const channel = /* extract from URL */;
           super(NewPlatform.namespace, 'NewPlatform', channel);
       }
       // Override receiveChatMessage() or patch intercept methods
   }
   ```
2. Register in `src/platforms/index.js`: `registerPlatform('example.com', NewPlatform);`
3. Add test fixtures in `test/fixtures/{platform}-events.json` with real WebSocket payloads

## Build & Test

```bash
npm test                    # Run all tests (Vitest + jsdom)
npm run test:fuzz           # Fuzzing tests only (fast-check property tests)
npm run build:userscript    # → dist/chuck.user.js
npm run build:extension     # Both Chrome + Firefox extensions
npm run watch:userscript    # Watch mode for development
```

## Testing Conventions

- Tests use Vitest with jsdom environment; mock browser globals before importing platform classes
- Fixtures in `test/fixtures/` contain real WebSocket event payloads captured from platforms
- Use `Object.create(Platform.prototype)` pattern to test parser methods in isolation without full initialization
- Property-based fuzzing via fast-check for parser robustness

## Key Patterns

- **Deterministic IDs**: UUIDv5 with platform-specific namespaces prevents duplicate messages
- **Two entry points**: `src/userscript.js` (Tampermonkey) and `src/content-script.js` (extensions)
- **Config abstraction**: `Config` class handles `GM_getValue` vs `chrome.storage` transparently
- **Debug recording**: `chuck.startRecording()`, `chuck.downloadRecording()` in browser console
- **Default server**: `ws://127.0.0.2:1350/chat.ws`

## Platform-Specific Notes

- **X/Twitter**: CSP blocks outbound WebSocket; requires CSP modifier extension or browser extension version
- **Twitch**: IRC parsing incomplete (TODO)
- **Kick**: Has multiple event formats (KicksGifted BASIC vs LEVEL_UP) - check fixtures for examples
