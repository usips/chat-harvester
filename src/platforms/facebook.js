/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Facebook platform scraper
 *
 * Features:
 * - Capture sent messages via GraphQL comment_create
 * - Capture WebSocket traffic (MQTT over WebSocket)
 * - Parse user badges (moderator, verified, top_fan, etc.)
 *
 * Protocol notes:
 * - Comments are sent via GraphQL mutation (comment_create)
 * - Incoming comments arrive via binary MQTT WebSocket (gateway.facebook.com)
 * - Comment IDs are base64 encoded: "comment:VIDEO_ID_COMMENT_ID"
 * - Reactions use FEEDBACK_ADD_STREAMING_REACTION_SUBSCRIBE subscription
 */

import { Seed, ChatMessage, uuidv5, EventStatus } from '../core/index.js';

export class Facebook extends Seed {
    static hostname = 'facebook.com';
    static namespace = '8f14e45f-ceea-467f-a184-bd5f3c4b7f2a';

    constructor() {
        // Extract video ID from URL: /username/videos/VIDEO_ID or /watch/live/?v=VIDEO_ID
        const urlParts = window.location.pathname.split('/').filter(x => x);
        let channel = urlParts[0] || 'facebook';

        // Try to get video ID from path
        const videoIndex = urlParts.indexOf('videos');
        if (videoIndex >= 0 && urlParts[videoIndex + 1]) {
            channel = urlParts[videoIndex + 1];
        }

        // Try to get from query param
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('v')) {
            channel = urlParams.get('v');
        }

        super(Facebook.namespace, 'Facebook', channel);
    }

    onDocumentReady() {
        this.log('Facebook platform initialized');
    }

    /**
     * Parse a comment from GraphQL comment_create response
     */
    parseComment(commentData) {
        if (!commentData || !commentData.id) return null;

        const message = new ChatMessage(
            uuidv5(commentData.id, this.namespace),
            this.platform,
            this.channel
        );

        // Message content
        message.message = commentData.preferred_body?.text ||
                         commentData.body?.text || '';

        // Author info
        const author = commentData.author;
        if (author) {
            message.username = author.name || 'Unknown';
            message.avatar = author.profile_picture_depth_0?.uri ||
                           author.profile_picture_depth_1?.uri;
            message.is_verified = author.is_verified || false;
        }

        // Timestamp
        if (commentData.created_time) {
            message.sent_at = commentData.created_time * 1000;
        }

        // Parse badges from discoverable_identity_badges_web
        if (commentData.discoverable_identity_badges_web) {
            for (const badge of commentData.discoverable_identity_badges_web) {
                if (!badge.is_earned && !badge.is_enabled) continue;

                switch (badge.identity_badge_type) {
                    case 'moderator':
                        message.is_mod = true;
                        break;
                    case 'top_fan':
                    case 'rising_fan':
                    case 'tipper':
                        message.is_sub = true;
                        break;
                    case 'gaming_partner':
                        message.is_owner = true;
                        break;
                }
            }
        }

        // Also check identity_badges_web for earned badges
        if (commentData.identity_badges_web) {
            for (const badge of commentData.identity_badges_web) {
                switch (badge.identity_badge_type) {
                    case 'moderator':
                        message.is_mod = true;
                        break;
                    case 'top_fan':
                    case 'rising_fan':
                    case 'tipper':
                        message.is_sub = true;
                        break;
                }
            }
        }

        return message;
    }

    /**
     * Handle GraphQL response containing comment data
     */
    handleGraphQLResponse(json) {
        if (!json || !json.data) return false;

        // Handle comment_create (sent message confirmation)
        if (json.data.comment_create?.comment) {
            const comment = json.data.comment_create.comment;
            const message = this.parseComment(comment);
            if (message && message.message) {
                this.sendChatMessages([message]);
                return true;
            }
        }

        return false;
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
                let handled = false;
                let json = null;

                try {
                    json = await cloned.json();
                    if (json) {
                        handled = this.handleGraphQLResponse(json);
                    }
                } catch {
                    // JSON parse error
                }

                this.recorder.recordFetch(
                    response.url,
                    'POST',
                    response.status,
                    json,
                    handled ? EventStatus.HANDLED : EventStatus.UNHANDLED,
                    { endpoint: 'graphql', hasComment: handled },
                    'graphql'
                );
                return;
            }

            // Ignore video/audio segment fetches
            if (url.hostname.includes('video-') ||
                url.pathname.includes('.m4v') ||
                url.pathname.includes('.m4a') ||
                url.pathname.includes('.mpd')) {
                this.recordFetchIgnored(response.url, 'GET', response.status, 'Media segment');
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
                let handled = false;
                let json = null;

                try {
                    // Parse response - could be string or object depending on responseType
                    if (typeof xhr.response === 'string') {
                        json = JSON.parse(xhr.response);
                    } else if (typeof xhr.response === 'object') {
                        json = xhr.response;
                    }

                    if (json) {
                        handled = this.handleGraphQLResponse(json);
                    }
                } catch (e) {
                    // JSON parse error
                }

                this.recorder.recordXhr(
                    xhr.responseURL,
                    'POST',
                    xhr.status,
                    json,
                    handled ? EventStatus.HANDLED : EventStatus.UNHANDLED,
                    { endpoint: 'graphql', hasComment: handled },
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
