/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * URL helpers
 */

/**
 * Parse a URL reported by a Response or XMLHttpRequest.
 *
 * Opaque (`no-cors`) responses, responses synthesised by a service worker and
 * XHRs that never completed all report an empty URL, so `new URL(raw)` throws.
 * Relative URLs are resolved against the page when one is available.
 *
 * @returns the parsed URL, or null when there is nothing parseable.
 */
export function parseUrl(raw: string | null | undefined): URL | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;

    try {
        return new URL(raw);
    } catch {
        // Not absolute - fall through and try to resolve against the page.
    }

    try {
        const base = typeof location !== 'undefined' ? location.href : undefined;
        return base !== undefined ? new URL(raw, base) : null;
    } catch {
        return null;
    }
}
