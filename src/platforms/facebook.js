/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Facebook platform scraper
 *
 * Features:
 * - Capture WebSocket traffic (MQTT over WebSocket)
 * - Capture fetch/XHR traffic for analysis
 * - Record all data for protocol analysis
 *
 * NOTE: This is a discovery/recording platform. Facebook uses complex
 * MQTT-based protocols that require further analysis.
 */

import { Seed, EventStatus } from '../core/index.js';

export class Facebook extends Seed {
    static hostname = 'facebook.com';
    static namespace = '8f14e45f-ceea-467f-a184-bd5f3c4b7f2a';

    constructor() {
        // Extract video ID or page name from URL if possible
        const urlParts = window.location.pathname.split('/').filter(x => x);
        const channel = urlParts[0] || 'facebook';
        super(Facebook.namespace, 'Facebook', channel);
    }

    onDocumentReady() {
        this.log('Facebook platform initialized for traffic capture');
    }

    onWebSocketMessage(ws, event) {
        try {
            // Facebook uses MQTT over WebSocket - data is binary
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                this.recorder.recordWebSocket(
                    ws.url,
                    '[Binary MQTT data]',
                    EventStatus.UNHANDLED,
                    { dataType: 'binary', size: event.data.size || event.data.byteLength },
                    'mqtt_binary'
                );
            } else {
                // Text data - try to parse as JSON
                try {
                    const json = JSON.parse(event.data);
                    this.recorder.recordWebSocket(
                        ws.url,
                        event.data,
                        EventStatus.UNHANDLED,
                        { type: json.type || 'unknown' },
                        'json'
                    );
                } catch {
                    this.recorder.recordWebSocket(
                        ws.url,
                        event.data,
                        EventStatus.UNHANDLED,
                        null,
                        'text'
                    );
                }
            }
        } catch (e) {
            this.recorder.recordWebSocket(
                ws.url,
                String(event.data).slice(0, 1000),
                EventStatus.ERROR,
                null,
                'error',
                e.message
            );
        }
    }

    onWebSocketOpen(ws) {
        this.log('WebSocket opened:', ws.url);
        this.recorder.record('websocket_open', {
            url: ws.url,
            timestamp: Date.now()
        }, EventStatus.HANDLED, null);
    }

    onWebSocketClose(ws, event) {
        this.log('WebSocket closed:', ws.url);
        this.recorder.record('websocket_close', {
            url: ws.url,
            code: event.code,
            reason: event.reason,
            timestamp: Date.now()
        }, EventStatus.HANDLED, null);
    }

    async onFetchResponse(response) {
        try {
            const url = new URL(response.url);

            // Capture GraphQL requests
            if (url.pathname.includes('/api/graphql') || url.pathname.includes('/graphql')) {
                const cloned = response.clone();
                try {
                    const json = await cloned.json();
                    this.recorder.recordFetch(
                        response.url,
                        'POST',
                        response.status,
                        json,
                        EventStatus.UNHANDLED,
                        { endpoint: 'graphql' },
                        'graphql'
                    );
                } catch {
                    this.recorder.recordFetch(
                        response.url,
                        'POST',
                        response.status,
                        null,
                        EventStatus.UNHANDLED,
                        { endpoint: 'graphql', parseError: true },
                        'graphql'
                    );
                }
                return;
            }

            // Capture live-related endpoints
            if (url.pathname.includes('/live') ||
                url.pathname.includes('/video') ||
                url.pathname.includes('/comment')) {
                const cloned = response.clone();
                try {
                    const text = await cloned.text();
                    this.recorder.recordFetch(
                        response.url,
                        'GET',
                        response.status,
                        text.slice(0, 5000),
                        EventStatus.UNHANDLED,
                        { endpoint: url.pathname },
                        'live_endpoint'
                    );
                } catch {
                    this.recordFetchIgnored(response.url, 'GET', response.status, 'Parse failed');
                }
                return;
            }

            // Ignore other requests
            this.recordFetchIgnored(response.url, 'GET', response.status, 'Not monitored');
        } catch (e) {
            this.log('Fetch response error:', e);
        }
    }

    onXhrReadyStateChange(xhr, event) {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;

        try {
            const url = new URL(xhr.responseURL);

            // Capture GraphQL XHR
            if (url.pathname.includes('/api/graphql') || url.pathname.includes('/graphql')) {
                this.recorder.recordXhr(
                    xhr.responseURL,
                    'POST',
                    xhr.status,
                    xhr.response,
                    EventStatus.UNHANDLED,
                    { endpoint: 'graphql' },
                    'graphql_xhr'
                );
                return;
            }

            // Ignore other XHR
            this.recorder.recordXhr(
                xhr.responseURL,
                'GET',
                xhr.status,
                null,
                EventStatus.IGNORED,
                null,
                'Not monitored'
            );
        } catch (e) {
            // Invalid URL or other error
        }
    }

    onEventSourceMessage(es, event) {
        this.recorder.recordEventSource(
            es.url,
            event.data,
            EventStatus.UNHANDLED,
            null,
            'sse'
        );
    }
}

export default Facebook;
