/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Base Seed class for platform-specific scrapers
 */

import { Config, DEFAULTS } from './config.js';
import { uuidv5 } from './uuid.js';
import { ChatMessage, LivestreamUpdate } from './message.js';
import { Recorder, EventStatus, EventType } from './recorder.js';
import type { EventStatusType, RecordedEvent, RecorderStats } from './recorder.js';

// Extended WebSocket interface for patching
interface PatchedWebSocket extends WebSocket {
    _chuck_url?: string;
    chuck_socket?: boolean;
    send: ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => void) & { chuck_patched?: boolean };
}

interface PatchedWebSocketConstructor {
    new(url: string | URL, protocols?: string | string[]): PatchedWebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
    prototype: WebSocket;
    chuck_patched?: boolean;
    oldWebSocket?: typeof WebSocket;
}

interface PatchedFetch {
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    chuck_patched?: boolean;
    oldFetch?: typeof fetch;
}

interface PatchedEventSource {
    new(url: string | URL, eventSourceInitDict?: EventSourceInit): EventSource;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSED: 2;
    prototype: EventSource;
    chuck_patched?: boolean;
    oldEventSource?: typeof EventSource;
}

interface PatchedXHROpen {
    (method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void;
    chuck_patched?: boolean;
}

interface PatchedXHRSend {
    (body?: Document | XMLHttpRequestBodyInit | null): void;
    chuck_patched?: boolean;
}

// Extended Window interface for patched globals
interface ChuckWindow extends Window {
    WebSocket: PatchedWebSocketConstructor;
    fetch: PatchedFetch;
    EventSource: PatchedEventSource;
    XMLHttpRequest: {
        new(): XMLHttpRequest;
        prototype: XMLHttpRequest & {
            open: PatchedXHROpen;
            send: PatchedXHRSend;
        };
        readonly UNSENT: 0;
        readonly OPENED: 1;
        readonly HEADERS_RECEIVED: 2;
        readonly LOADING: 3;
        readonly DONE: 4;
    };
    UUID?: { v5?: typeof uuidv5 };
    CHUCK?: Seed;
    chuck?: Seed;
}

// Server command interface
interface ServerCommand {
    type: string;
    data?: unknown;
}

// Subscription interface
interface Subscription {
    id: string;
    buyer: string;
    value: number;
    count: number;
    gifted?: boolean;
}

// Get the window object (handles userscript's unsafeWindow)
export const WINDOW: ChuckWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as ChuckWindow;

/**
 * Base class for all platform scrapers
 * Handles WebSocket/Fetch/XHR patching and communication with backend
 */
export class Seed {
    // Platform identification
    channel: string | null = null;
    platform: string | null = null;
    namespace: string | null = null;
    viewers: number | null = null;

    // Backend connection
    chatSocket: PatchedWebSocket | null = null;
    chatSocketTimeout: ReturnType<typeof setTimeout> | null = null;
    chatMessageQueue: ChatMessage[] = [];
    updateQueue: LivestreamUpdate[] = [];

    // Configuration
    serverUrl: string = DEFAULTS.serverUrl;
    debug: boolean = DEFAULTS.debug;

    // Debug recorder
    recorder: Recorder;

    constructor(namespace: string, platform: string, channel: string) {
        this.namespace = namespace;
        this.platform = platform;
        this.channel = channel;

        // Initialize recorder
        this.recorder = new Recorder(platform);

        this.log('Initializing.');

        // Load config then initialize
        this._initAsync();
    }

    private async _initAsync(): Promise<void> {
        try {
            this.serverUrl = await Config.get('serverUrl', DEFAULTS.serverUrl);
            this.debug = await Config.get('debug', DEFAULTS.debug);
        } catch {
            // Config not available, use defaults
        }

        this.eventSourcePatch();
        this.fetchPatch();
        this.webSocketPatch();
        this.xhrPatch();

        this.bindEvents();
        this.initUUID();
    }

    //
    // Logging
    //
    protected _debug(message: string, ...args: unknown[]): void {
        if (this.debug) {
            this.log(message, ...args);
        }
    }

    log(message: string, ...args: unknown[]): void {
        if (args.length > 0) {
            console.log(`[CHUCK::${this.platform}] ${message}`, ...args);
        } else {
            console.log(`[CHUCK::${this.platform}] ${message}`);
        }
    }

    warn(message: string, ...args: unknown[]): void {
        const f = console.warn ?? console.log;
        if (args.length > 0) {
            f(`[CHUCK::${this.platform}] ${message}`, ...args);
        } else {
            f(`[CHUCK::${this.platform}] ${message}`);
        }
    }

    error(message: string, ...args: unknown[]): void {
        const f = console.error ?? console.log;
        if (args.length > 0) {
            f(`[CHUCK::${this.platform}] ${message}`, ...args);
        } else {
            f(`[CHUCK::${this.platform}] ${message}`);
        }
    }

    //
    // UUID Setup
    //
    initUUID(): void {
        // Make UUID available globally for platform classes
        if (!WINDOW.UUID) {
            WINDOW.UUID = {};
        }
        WINDOW.UUID!.v5 = uuidv5;
    }

    //
    // Page Events
    //
    bindEvents(): void {
        document.addEventListener('DOMContentLoaded', (event) => this.onDocumentReady(event));
        document.addEventListener('DOMContentLoaded', () => this.createChatSocket());
        window.addEventListener('beforeunload', (event) => this.onBeforeUnload(event));
    }

    onDocumentReady(_event: Event): void {
        this._debug('Document ready.');
    }

    onBeforeUnload(_event: BeforeUnloadEvent): void {
        this._debug('Window is about to unload.');
        this.sendViewerCount(0);
    }

    //
    // Chat Socket
    //
    createChatSocket(): PatchedWebSocket | null {
        // Clear any pending reconnect timeout
        if (this.chatSocketTimeout) {
            clearTimeout(this.chatSocketTimeout);
            this.chatSocketTimeout = null;
        }

        // Don't create if already open or connecting
        if (this.chatSocket !== null &&
            (this.chatSocket.readyState === WebSocket.OPEN ||
             this.chatSocket.readyState === WebSocket.CONNECTING)) {
            this.log('Chat socket already exists and is open/connecting.');
            return this.chatSocket;
        }

        this.log('Creating chat socket.');
        const ws = new (WINDOW.WebSocket.oldWebSocket ?? WebSocket)(this.serverUrl) as PatchedWebSocket;
        ws.addEventListener('open', (event) => this.onChatSocketOpen(ws, event));
        ws.addEventListener('message', (event) => this.onChatSocketMessage(ws, event));
        ws.addEventListener('close', (event) => this.onChatSocketClose(ws, event));
        ws.addEventListener('error', (event) => this.onChatSocketError(ws, event));

        ws.chuck_socket = true;
        this.chatSocket = ws;

        return this.chatSocket;
    }

    onChatSocketOpen(_ws: PatchedWebSocket, _event: Event): void {
        this._debug('Chat socket opened.');
        this.sendChatMessages(this.chatMessageQueue);
        this.chatMessageQueue = [];
    }

    onChatSocketMessage(_ws: PatchedWebSocket, event: MessageEvent): void {
        this._debug('Chat socket received data.', event);

        try {
            const command = JSON.parse(event.data as string) as ServerCommand;
            if (command.type) {
                this.handleServerCommand(command.type, command.data);
            }
        } catch (e) {
            this._debug('Could not parse server message as JSON:', e);
        }
    }

    /**
     * Handle commands received from the server
     * Subclasses can override to add custom command handlers
     */
    handleServerCommand(type: string, data: unknown): void {
        switch (type) {
            case 'inject_message':
                this.injectMessage(data);
                break;
            default:
                this._debug('Unknown server command:', type, data);
        }
    }

    /**
     * Inject an external message into the chat UI
     * Subclasses should override this to implement platform-specific injection
     */
    injectMessage(message: unknown): void {
        this._debug('injectMessage not implemented for this platform:', message);
    }

    onChatSocketClose(ws: PatchedWebSocket, event: CloseEvent): void {
        this._debug('Chat socket closed.', event);
        // Only schedule reconnect if this is our current socket
        if (ws === this.chatSocket) {
            this.chatSocket = null;
            if (this.chatSocketTimeout) clearTimeout(this.chatSocketTimeout);
            this.chatSocketTimeout = setTimeout(() => this.createChatSocket(), 3000);
        }
    }

    onChatSocketError(ws: PatchedWebSocket, _event: Event): void {
        this._debug('Chat socket errored.', _event);
        ws.close();
    }

    //
    // Message Sending
    //
    queueLivestreamUpdate(update: LivestreamUpdate): void {
        const ws_open = this.chatSocket?.readyState === WebSocket.OPEN;
        const seed_ready = this.channel !== null;

        if (ws_open && seed_ready) {
            this.chatSocket!.send(JSON.stringify(update));
        } else {
            this.warn('Forcing messages to queue. Socket open:', ws_open, 'Seed ready:', seed_ready);
            this.updateQueue.push(update);
        }
    }

    sendChatMessages(messages: ChatMessage | ChatMessage[]): void {
        this._debug('Sending chat messages.', messages);
        const update = new LivestreamUpdate(this.platform!, this.channel!);

        if (Array.isArray(messages)) {
            update.messages = messages;
            // Record each message sent to backend
            messages.forEach(msg => this.recorder.recordChatMessage(msg));
        } else if (messages instanceof ChatMessage) {
            update.messages = [messages];
            this.recorder.recordChatMessage(messages);
        } else {
            this.warn('Invalid messages parameter. Expected ChatMessage or Array of ChatMessage.', messages);
            return;
        }

        this.queueLivestreamUpdate(update);
    }

    sendRemoveMessages(ids: string[]): void {
        this._debug('Sending remove message for IDs:', ids);
        const update = new LivestreamUpdate(this.platform!, this.channel!);
        update.removals = ids;
        this.queueLivestreamUpdate(update);
    }

    sendViewerCount(count: number): void {
        this._debug('Updating viewer count. Current viewers:', count);
        this.viewers = count;

        const update = new LivestreamUpdate(this.platform!, this.channel!);
        update.viewers = count;
        this.queueLivestreamUpdate(update);
    }

    receiveSubscriptions(sub: Subscription): void {
        const message = new ChatMessage(
            uuidv5(sub.id, this.namespace!),
            this.platform!,
            this.channel!
        );
        message.username = sub.buyer;
        message.amount = sub.value * sub.count;
        message.currency = 'USD';

        if (sub.gifted) {
            if (sub.count > 1) {
                message.message = `${message.username} gifted ${sub.count} subscriptions!`;
            } else {
                message.message = `${message.username} gifted a subscription!`;
            }
        } else {
            if (sub.count > 1) {
                message.message = `${message.username} subscribed for ${sub.count} months!`;
            } else {
                message.message = `${message.username} subscribed for 1 month!`;
            }
        }

        this.log('Sending subscription message.', message);
        this.sendChatMessages([message]);
    }

    //
    // EventSource Patching
    //
    eventSourcePatch(): typeof EventSource {
        if (WINDOW.EventSource.chuck_patched) return WINDOW.EventSource;

        const self = this;
        const oldEventSource = WINDOW.EventSource;
        const newEventSource = function(this: EventSource, url: string | URL, config?: EventSourceInit): EventSource {
            const es = new oldEventSource(url, config);

            es.addEventListener('message', function(event: MessageEvent) {
                self.onEventSourceMessage(es, event);
            });

            return es;
        } as unknown as PatchedEventSource;
        newEventSource.chuck_patched = true;
        newEventSource.oldEventSource = oldEventSource;
        Object.defineProperty(newEventSource, 'CONNECTING', { value: 0 });
        Object.defineProperty(newEventSource, 'OPEN', { value: 1 });
        Object.defineProperty(newEventSource, 'CLOSED', { value: 2 });
        Object.defineProperty(newEventSource, 'prototype', { value: oldEventSource.prototype });
        WINDOW.EventSource = Object.assign(newEventSource, oldEventSource);
        return WINDOW.EventSource;
    }

    onEventSourceMessage(_es: EventSource, event: MessageEvent): void {
        this._debug('EventSource received data.', event);
    }

    //
    // Fetch Patching
    //
    fetchPatch(): typeof fetch {
        if (WINDOW.fetch.chuck_patched) return WINDOW.fetch;

        const self = this;
        const oldFetch = WINDOW.fetch;
        const newFetch = function(...args: [RequestInfo | URL, RequestInit?]): Promise<Response> {
            const [resource, config] = args;
            const response = oldFetch(resource, config);
            response.then((data) => {
                const newData = data.clone();
                self.onFetchResponse(newData);
                return data;
            }).catch(() => {
                // Silently ignore fetch failures (ad blockers, network errors, CORS, etc.)
            });
            return response;
        } as PatchedFetch;
        newFetch.chuck_patched = true;
        newFetch.oldFetch = oldFetch;
        WINDOW.fetch = Object.assign(newFetch, oldFetch);
        return WINDOW.fetch;
    }

    onFetchResponse(response: Response): void {
        this._debug('Fetch received data.', response);
        // Record raw fetch - subclasses should call recordFetchHandled for handled responses
        this.recorder.recordFetch(response.url, 'GET', response.status, '[Response object - clone to read body]', EventStatus.UNHANDLED);
    }

    /**
     * Record a Fetch response as handled
     */
    recordFetchHandled(url: string, method: string, statusCode: number, payload: unknown, parsed: unknown): void {
        this.recorder.recordFetch(url, method, statusCode, payload, EventStatus.HANDLED, parsed);
    }

    /**
     * Record a Fetch response as ignored
     */
    recordFetchIgnored(url: string, method: string, statusCode: number, reason: string | null = null): void {
        this.recorder.recordFetch(url, method, statusCode, null, EventStatus.IGNORED, null, reason);
    }

    //
    // WebSocket Patching
    //
    webSocketPatch(): PatchedWebSocketConstructor {
        if (WINDOW.WebSocket.chuck_patched) return WINDOW.WebSocket;

        const self = this;
        const oldWebSocket = WINDOW.WebSocket;
        const newWebSocket = function(this: PatchedWebSocket, url: string | URL, protocols?: string | string[]): PatchedWebSocket {
            const ws = new oldWebSocket(url, protocols) as PatchedWebSocket;
            ws._chuck_url = url.toString(); // Store URL for recording
            const oldWsSend = ws.send.bind(ws);
            ws.send = function(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
                self.onWebSocketSend(ws, data);
                return oldWsSend(data);
            } as PatchedWebSocket['send'];
            ws.addEventListener('message', (event) => self.onWebSocketMessage(ws, event));
            ws.send.chuck_patched = true;
            return ws;
        } as unknown as PatchedWebSocketConstructor;
        newWebSocket.chuck_patched = true;
        newWebSocket.oldWebSocket = oldWebSocket;
        Object.defineProperty(newWebSocket, 'CONNECTING', { value: 0 });
        Object.defineProperty(newWebSocket, 'OPEN', { value: 1 });
        Object.defineProperty(newWebSocket, 'CLOSING', { value: 2 });
        Object.defineProperty(newWebSocket, 'CLOSED', { value: 3 });
        Object.defineProperty(newWebSocket, 'prototype', { value: oldWebSocket.prototype });
        WINDOW.WebSocket = Object.assign(newWebSocket, oldWebSocket);
        return WINDOW.WebSocket;
    }

    onWebSocketMessage(ws: PatchedWebSocket, event: MessageEvent): void {
        this._debug('WebSocket received data.', event);
        // Record raw WebSocket message - subclasses should call recordWebSocketHandled/Ignored/Unhandled
        this._recordWebSocketRaw(ws, 'in', event.data);
    }

    onWebSocketSend(ws: PatchedWebSocket, data: unknown): void {
        this._debug('WebSocket sent data.', data);
        this._recordWebSocketRaw(ws, 'out', data);
    }

    /**
     * Internal: Record raw WebSocket message
     */
    private _recordWebSocketRaw(ws: PatchedWebSocket, direction: 'in' | 'out', data: unknown): void {
        // Skip our own CHUCK socket
        if (ws.chuck_socket) return;
        this.recorder.recordWebSocket(direction, ws._chuck_url ?? '', data, EventStatus.UNHANDLED);
    }

    /**
     * Record a WebSocket message as handled (successfully parsed)
     */
    recordWebSocketHandled(ws: PatchedWebSocket, direction: 'in' | 'out', data: unknown, parsed: unknown, eventName: string | null = null): void {
        if (ws.chuck_socket) return;
        this.recorder.recordWebSocket(direction, ws._chuck_url ?? '', data, EventStatus.HANDLED, parsed, eventName);
    }

    /**
     * Record a WebSocket message as ignored (recognized but skipped)
     */
    recordWebSocketIgnored(ws: PatchedWebSocket, direction: 'in' | 'out', data: unknown, eventName: string | null = null, reason: string | null = null): void {
        if (ws.chuck_socket) return;
        this.recorder.recordWebSocket(direction, ws._chuck_url ?? '', data, EventStatus.IGNORED, null, eventName, reason);
    }

    /**
     * Record a WebSocket message as unhandled (unknown event type)
     */
    recordWebSocketUnhandled(ws: PatchedWebSocket, direction: 'in' | 'out', data: unknown, eventName: string | null = null): void {
        if (ws.chuck_socket) return;
        this.recorder.recordWebSocket(direction, ws._chuck_url ?? '', data, EventStatus.UNHANDLED, null, eventName);
    }

    //
    // XHR Patching
    //
    xhrPatch(): typeof XMLHttpRequest {
        const proto = WINDOW.XMLHttpRequest.prototype as XMLHttpRequest & {
            open: PatchedXHROpen;
            send: PatchedXHRSend;
        };
        if (proto.open.chuck_patched) return WINDOW.XMLHttpRequest;

        const self = this;

        const oldXhrOpen = proto.open;
        const newXhrOpen = function(
            this: XMLHttpRequest,
            method: string,
            url: string | URL,
            async: boolean = true,
            user?: string | null,
            password?: string | null
        ): void {
            self.onXhrOpen(this, method, url.toString(), async, user ?? undefined, password ?? undefined);
            return oldXhrOpen.call(this, method, url, async, user, password);
        } as PatchedXHROpen;
        newXhrOpen.chuck_patched = true;
        proto.open = Object.assign(newXhrOpen, oldXhrOpen);

        const oldXhrSend = proto.send;
        const newXhrSend = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
            self.onXhrSend(this, body);
            return oldXhrSend.call(this, body);
        } as PatchedXHRSend;
        newXhrSend.chuck_patched = true;
        proto.send = Object.assign(newXhrSend, oldXhrSend);

        return WINDOW.XMLHttpRequest;
    }

    onXhrOpen(xhr: XMLHttpRequest, method: string, url: string, async?: boolean, user?: string, password?: string): void {
        this._debug('XHR opened.', method, url, async, user, password);
        xhr.addEventListener('readystatechange', (event) => this.onXhrReadyStateChange(xhr, event));
    }

    onXhrReadyStateChange(_xhr: XMLHttpRequest, event: Event): void {
        this._debug('XHR ready state changed.', event);
    }

    onXhrSend(_xhr: XMLHttpRequest, body: unknown): void {
        this._debug('XHR sent data.', body);
    }

    //
    // Recording Controls
    //
    /**
     * Start recording all intercepted traffic
     */
    startRecording(): this {
        this.recorder.start();
        return this;
    }

    /**
     * Stop recording
     */
    stopRecording(): this {
        this.recorder.stop();
        return this;
    }

    /**
     * Download recorded data as JSON file
     */
    downloadRecording(filename: string | null = null): this {
        this.recorder.download(filename);
        return this;
    }

    /**
     * Get recording statistics
     */
    getRecordingStats(): RecorderStats {
        return this.recorder.getStats();
    }

    /**
     * Get all unhandled events (for finding missing handlers)
     */
    getUnhandledEvents(): RecordedEvent[] {
        return this.recorder.getUnhandled();
    }

    /**
     * Clear recorded data
     */
    clearRecording(): this {
        this.recorder.clear();
        return this;
    }
}

// Export helpers for platform classes
export { uuidv5, ChatMessage, LivestreamUpdate, EventStatus, EventType };
export type { EventStatusType, PatchedWebSocket };
