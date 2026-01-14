# CHUCK - Chat Harvesting Universal Connection Kit

Multi-platform livestream chat scraper that aggregates messages from various streaming platforms and forwards them to a WebSocket server.

## Architecture

- **src/core/** - Base classes (Seed, ChatMessage, LivestreamUpdate, UUID)
- **src/platforms/** - Platform-specific scrapers (Kick, YouTube, Twitch, Rumble, etc.)
- **src/userscript.js** - Userscript entry point
- **test/** - Vitest tests with fast-check fuzzing

## Build System

```bash
npm run build:userscript    # Build userscript to dist/chuck.user.js
npm run build:extension     # Build browser extensions
npm test                    # Run tests
npm run test:fuzz          # Run fuzzing tests only
```

## Platform Scraper Pattern

Each platform extends the base `Seed` class and:
1. Patches `WebSocket` or other network APIs to intercept chat data
2. Parses platform-specific message formats into `ChatMessage` objects
3. Forwards messages to the SNEED WebSocket server

## Testing

Uses Vitest with fast-check for property-based fuzzing. Test fixtures in `test/fixtures/` contain real WebSocket payloads.

## Related Project

Works with [SNEED](https://github.com/usips/stream-nexus) (Stream Nexus) - the backend server that receives and processes chat messages.
