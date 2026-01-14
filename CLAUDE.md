# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CHUCK (Chat Harvesting Universal Connection Kit) is a multi-platform livestream chat scraper that intercepts chat messages from streaming platforms and forwards them to a WebSocket backend (SNEED). Runs as both a userscript (Tampermonkey/Greasemonkey) and browser extensions (Chrome/Firefox).

## Build & Test Commands

```bash
# Testing
npm test                       # Run all tests
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
npm run test:fuzz              # Fuzzing tests only

# Building
npm run build                  # Build everything
npm run build:userscript       # Userscript only → dist/chuck.user.js
npm run build:extension        # Both extensions
npm run build:extension:chrome # Chrome only
npm run build:extension:firefox # Firefox only
npm run watch:userscript       # Watch mode for userscript
```

## Architecture

### Core Components (src/core/)

- **Seed** (`seed.js`): Base class all platform scrapers extend. Patches WebSocket, Fetch, EventSource, and XHR to intercept network traffic. Manages connection to SNEED backend.
- **ChatMessage** (`message.js`): Standardized message format with metadata (badges, donation amounts, emojis, currencies)
- **Config** (`config.js`): Storage abstraction for userscript (GM_getValue) vs extension (chrome.storage)
- **Recorder** (`recorder.js`): Debug recording system for capturing traffic

### Platform Scrapers (src/platforms/)

Each platform (Kick, YouTube, Twitch, Rumble, Odysee, VK, X, XMRChat) extends `Seed` and implements:
- Platform-specific message parsing
- Badge/tier handling
- Currency/donation parsing

Platform detection via hostname matching in `src/platforms/index.js`.

### Message Flow

Platform API intercept → Platform scraper parses → `ChatMessage` → `LivestreamUpdate` → WebSocket → SNEED server

### Entry Points

- `src/userscript.js` - Userscript entry
- `src/content-script.js` - Browser extension content script

## Testing

Uses Vitest with jsdom + fast-check for property-based fuzzing. Test fixtures with real WebSocket payloads in `/test/fixtures/`.

## Notes

- **Deterministic IDs**: UUIDv5 with platform-specific namespaces for message deduplication
- **Debug Recording**: `chuck.startRecording()`, `chuck.downloadRecording()`, `chuck.getRecordingStats()`
- **X/Twitter CSP**: Blocks outbound connections; requires CSP modifier extension or browser extension version
- **Twitch**: IRC parsing incomplete (marked TODO)
- **Default server**: `ws://127.0.0.2:1350/chat.ws`

## Related Project

Works with [SNEED](https://github.com/usips/stream-nexus) (Stream Nexus) - the backend server that receives and processes chat messages.
