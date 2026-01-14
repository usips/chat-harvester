# CHUCK

**Chat Harvesting Universal Connection Kit**

A browser extension and userscript that captures livestream chat messages from multiple platforms and forwards them to a WebSocket server.

## Supported Platforms

- Kick
- YouTube
- Twitch
- Rumble
- Odysee
- VK
- X (Twitter)
- XMRChat

## Installation

### Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Greasemonkey](https://www.greasespot.net/)
2. Install the userscript from `dist/chuck.user.js`

### Browser Extension

1. Build the extension: `npm run build:extension`
2. Load the unpacked extension from `dist/chrome/` or `dist/firefox/`

## Building

```bash
npm install
npm run build
```

## Configuration

By default, CHUCK connects to `ws://127.0.0.2:1350/chat.ws`. Configure the server URL and platform toggles through the extension popup or userscript menu.

## Related Projects

- [SNEED](https://github.com/usips/stream-nexus) - Stream Nexus backend server

## License

BSD-3-Clause
