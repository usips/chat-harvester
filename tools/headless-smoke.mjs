#!/usr/bin/env node
/**
 * CHUCK headless smoke test.
 *
 * Launches a headless Chromium-based browser with Violentmonkey loaded as an unpacked
 * extension, installs dist/chuck.user.js into it, opens a live page and reports what
 * CHUCK intercepts (viewer count, messages, recorder stats). Optionally forwards to a
 * running SNEED. Everything is driven over the DevTools protocol; no puppeteer needed.
 *
 *   npm run build:userscript
 *   SERVER_IP=127.0.0.2 ./target/debug/stream-nexus        # in ../stream-nexus, optional
 *   node tools/headless-smoke.mjs https://www.youtube.com/watch?v=VIDEO_ID
 *
 * Environment:
 *   BROWSER    browser binary (default /usr/bin/brave). Google Chrome branded builds
 *              ignore --load-extension since 137, so use Brave, Chromium or Chrome for Testing.
 *   PROFILE    profile directory (default ~/.cache/chuck-headless/profile)
 *   VM_DIR     unpacked Violentmonkey MV3 build (default ~/.cache/chuck-headless/violentmonkey);
 *              download Violentmonkey-mv3-*.zip from github.com/violentmonkey/violentmonkey/releases
 *   WATCH_MS   how long to watch the page (default 60000)
 *
 * What the script has to work around (all verified with Brave 152 / Chromium 152):
 *   - Violentmonkey MV3 needs the per-extension "Allow User Scripts" toggle, otherwise
 *     chrome.userScripts is undefined and nothing is injected. The toggle lives on
 *     chrome://extensions and is clicked with a real mouse event.
 *   - Chromium 138+ gates pages' access to loopback addresses behind the Local Network
 *     Access permission, so ws://127.0.0.2:1350 from https://www.youtube.com is denied
 *     without a prompt. Granted via Browser.grantPermissions plus content-setting prefs.
 *   - Brave additionally shields localhost; the `brave_localhost_access` exception and
 *     shields-down for the origin are seeded into the profile before first launch.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME;
const BASE = `${HOME}/.cache/chuck-headless`;
const BROWSER = process.env.BROWSER ?? '/usr/bin/brave';
const PROFILE = process.env.PROFILE ?? `${BASE}/profile`;
const VM_DIR = process.env.VM_DIR ?? `${BASE}/violentmonkey`;
const USERSCRIPT = path.join(ROOT, 'dist', 'chuck.user.js');
const URL_TO_TEST = process.argv[2] ?? 'https://www.youtube.com/watch?v=AgAeY1IPM_I';
const WATCH_MS = Number(process.env.WATCH_MS ?? 60000);
const DEVTOOLS_PORT = 9333;
const SCRIPT_PORT = 8765;
const ORIGINS = ['https://www.youtube.com', 'https://kick.com', 'https://www.twitch.tv', 'https://rumble.com', 'https://odysee.com'];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const [what, p] of [['userscript', USERSCRIPT], ['Violentmonkey manifest', `${VM_DIR}/manifest.json`], ['browser', BROWSER]]) {
    if (!fs.existsSync(p)) { console.error(`Missing ${what}: ${p}`); process.exit(1); }
}

// ---- profile prefs: loopback access + Brave shields for the origins CHUCK runs on ----
fs.mkdirSync(`${PROFILE}/Default`, { recursive: true });
const prefsPath = `${PROFILE}/Default/Preferences`;
{
    const prefs = fs.existsSync(prefsPath) ? JSON.parse(fs.readFileSync(prefsPath, 'utf8')) : {};
    const ex = ((prefs.profile ??= {}).content_settings ??= {}).exceptions ??= {};
    for (const origin of ORIGINS.map(o => `${o},*`)) {
        for (const key of ['local_network_access', 'loopback_network', 'brave_localhost_access']) (ex[key] ??= {})[origin] = { setting: 1 };
        (ex.braveShields ??= {})[origin] = { setting: 2 };
    }
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

// ---- serve the userscript so Violentmonkey records a real install URL ----
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/chuck.user.js')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(USERSCRIPT));
    } else { res.writeHead(404); res.end(); }
}).listen(SCRIPT_PORT, '127.0.0.1');

// ---- launch ----
const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${DEVTOOLS_PORT}`, `--user-data-dir=${PROFILE}`,
    `--load-extension=${VM_DIR}`, `--disable-extensions-except=${VM_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--lang=en-US',
    '--disable-features=LocalNetworkAccessChecks,BraveLocalhostAccessPermission',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
browser.stderr.on('data', d => { const s = d.toString(); if (/extension/i.test(s) && /error/i.test(s)) process.stderr.write('[browser] ' + s); });
const cleanup = () => { try { browser.kill('SIGTERM'); } catch { /* already gone */ } server.close(); };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('unhandledRejection', e => log('unhandled rejection:', String(e).slice(0, 200)));

// ---- minimal CDP client ----
async function waitForJson(url, tries = 50) {
    for (let i = 0; i < tries; i++) {
        try { return await fetch(url).then(r => r.json()); } catch { await sleep(200); }
    }
    throw new Error('DevTools endpoint never came up');
}
const version = await waitForJson(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`);
log('browser', version.Browser);
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(r => ws.once('open', r));
let seq = 0; const pending = new Map(); const listeners = [];
ws.on('message', m => {
    const j = JSON.parse(m.toString());
    if (j.id && pending.has(j.id)) { const { res, rej } = pending.get(j.id); pending.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result); }
    else if (j.method) for (const l of listeners) l(j);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const on = fn => listeners.push(fn);

async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId).catch(() => {});
    await send('Page.enable', {}, sessionId).catch(() => {});
    return sessionId;
}
async function evaluate(sessionId, expression, contextId) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
}
async function findTarget(pred, tries = 50, delay = 200) {
    for (let i = 0; i < tries; i++) {
        const { targetInfos } = await send('Target.getTargets');
        const t = targetInfos.find(pred); if (t) return t;
        await sleep(delay);
    }
    return null;
}
async function withPage(url, fn) {
    const { targetId } = await send('Target.createTarget', { url });
    let sessionId = null;
    for (let i = 0; i < 10 && !sessionId; i++) { await sleep(500); sessionId = await attach(targetId).catch(() => null); }
    if (!sessionId) throw new Error(`could not attach to ${url}`);
    try { return await fn(sessionId); } finally { await send('Target.closeTarget', { targetId }).catch(() => {}); }
}
const DEEP_QUERY = `const deep = (root, sel, out = []) => { for (const el of root.querySelectorAll(sel)) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(el.shadowRoot, sel, out); return out; };`;

// ---- 1. Violentmonkey present? ----
const vm = await findTarget(t => t.url.startsWith('chrome-extension://') && /\/sw\.js$/.test(t.url), 30);
if (!vm) {
    const { targetInfos } = await send('Target.getTargets');
    log('FAIL: Violentmonkey did not load. Targets:', targetInfos.map(t => `${t.type} ${t.url.slice(0, 80)}`).join(' | '));
    log('Google Chrome branded builds ignore --load-extension; use BROWSER=/usr/bin/brave or a Chromium build.');
    process.exit(2);
}
const extId = new URL(vm.url).host;
log('Violentmonkey loaded:', extId);
await sleep(2000);

// ---- 2. enable the userScripts API for the extension ("Allow User Scripts" toggle) ----
await withPage(`chrome://extensions/?id=${extId}`, async (s) => {
    await sleep(2500);
    const rect = await evaluate(s, `(() => { ${DEEP_QUERY}
        const row = deep(document, 'extensions-toggle-row').find(r => r.id === 'allow-user-scripts');
        if (!row) return null;
        const toggle = row.shadowRoot?.querySelector('cr-toggle') ?? row;
        toggle.scrollIntoView({ block: 'center' });
        const b = toggle.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, checked: toggle.checked }; })()`);
    if (!rect) { log('FAIL: no "Allow User Scripts" toggle found on chrome://extensions'); process.exit(3); }
    if (!rect.checked) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, s);
        }
        await sleep(3000); // the extension reloads
    }
    log('Allow User Scripts:', rect.checked ? 'already on' : 'switched on');
});

// ---- 3. install CHUCK through Violentmonkey's own install command ----
const code = fs.readFileSync(USERSCRIPT, 'utf8');
await withPage(`chrome-extension://${extId}/options/index.html`, async (s) => {
    await sleep(1500);
    const api = await evaluate(s, 'typeof chrome.userScripts');
    if (api !== 'object') { log('FAIL: chrome.userScripts is', api, '- the toggle did not take'); process.exit(3); }
    const result = await evaluate(s, `(async () => {
        const r = await chrome.runtime.sendMessage({ cmd: 'ParseScript', data: {
            code: ${JSON.stringify(code)}, url: 'http://127.0.0.1:${SCRIPT_PORT}/chuck.user.js', from: 'http://127.0.0.1:${SCRIPT_PORT}/',
            require: {}, cache: {}, reloadTab: false, bumpDate: true } });
        return JSON.stringify({ message: r?.update?.message, id: r?.where?.id, name: r?.update?.meta?.name, enabled: r?.update?.config?.enabled, errors: r?.errors });
    })()`);
    log('install:', result);
    await sleep(1000);
    log('registered user scripts:', await evaluate(s, `chrome.userScripts.getScripts().then(l => JSON.stringify(l.map(x => ({ id: x.id, runAt: x.runAt, world: x.world }))))`));
});

// ---- 4. loopback access for CHUCK's socket to SNEED ----
for (const origin of ORIGINS) {
    await send('Browser.grantPermissions', { origin, permissions: ['localNetworkAccess'] }).catch(e => log('grantPermissions', origin, e.message.slice(0, 80)));
}

// ---- 5. open the live page and watch ----
const chuckLogs = [];
const contexts = new Map();
on(ev => {
    if (ev.method === 'Runtime.consoleAPICalled') {
        const text = ev.params.args.map(a => a.value ?? a.description ?? a.type).join(' ');
        if (text.includes('[CHUCK')) { chuckLogs.push(text); if (chuckLogs.length <= 40) log('console:', text.slice(0, 200)); }
    }
    if (ev.method === 'Runtime.executionContextCreated') {
        const c = ev.params.context;
        if (c.auxData?.isDefault) contexts.set(c.id, { sessionId: ev.sessionId, frameId: c.auxData.frameId });
    }
    if (ev.method === 'Runtime.executionContextDestroyed') contexts.delete(ev.params.executionContextId);
    if (ev.method === 'Log.entryAdded') {
        const e = ev.params.entry;
        if (/127\.0\.0|ws:|loopback|WebSocket/i.test(e.text)) log('browser log:', e.level, e.text.slice(0, 200));
    }
    if (ev.method === 'Target.attachedToTarget') {
        send('Runtime.enable', {}, ev.params.sessionId).catch(() => {});
        send('Runtime.runIfWaitingForDebugger', {}, ev.params.sessionId).catch(() => {});
    }
});
const { targetId: pageTab } = await send('Target.createTarget', { url: 'about:blank' });
const page = await attach(pageTab);
await send('Log.enable', {}, page).catch(() => {});
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page);
log('navigating to', URL_TO_TEST);
await send('Page.navigate', { url: URL_TO_TEST }, page);

const CHUCK_STATE = `(() => { const c = window.chuck; if (!c) return null; try { c.startRecording(); } catch {}
    return { platform: c.platform, channel: c.channel, viewers: c.viewers, queued: c.updateQueue?.length ?? 0, socket: c.chatSocket?.readyState ?? null, recorded: c.getRecordingStats?.().byType ?? {} }; })()`;
const chatFrameState = async () => {
    const { frameTree } = await send('Page.getFrameTree', {}, page);
    const chatFrameId = (frameTree.childFrames ?? []).find(f => /live_chat|chatroom|popout/.test(f.frame.url))?.frame.id;
    const ctx = [...contexts.entries()].find(([, c]) => c.frameId === chatFrameId);
    return ctx ? evaluate(ctx[1].sessionId, CHUCK_STATE, ctx[0]).catch(e => 'error ' + e.message) : null;
};
const started = Date.now();
let last = null;
while (Date.now() - started < WATCH_MS) {
    await sleep(10000);
    last = { top: await evaluate(page, CHUCK_STATE).catch(e => 'error ' + e.message), chatFrame: await chatFrameState() };
    log(`t+${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(last));
}
const shot = await send('Page.captureScreenshot', { format: 'png' }, page).catch(() => null);
if (shot) { fs.writeFileSync(`${BASE}/last-page.png`, Buffer.from(shot.data, 'base64')); log('screenshot:', `${BASE}/last-page.png`); }
fs.writeFileSync(`${BASE}/last-console.log`, chuckLogs.join('\n'));

// ---- verdict ----
const top = last?.top ?? {}; const frame = last?.chatFrame ?? {};
const viewers = top?.viewers ?? frame?.viewers ?? null;
const messages = (top?.recorded?.chat_message ?? 0) + (frame?.recorded?.chat_message ?? 0);
const socketOpen = top?.socket === 1 || frame?.socket === 1;
log('RESULT', JSON.stringify({ injected: !!top || !!frame, viewers, messagesCaptured: messages, backendSocketOpen: socketOpen, consoleLines: chuckLogs.length }));
process.exit(top || frame ? 0 : 4);
