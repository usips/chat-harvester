/**
 * CHUCK - Core URL Helper Tests
 */

import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('location', { href: 'https://rumble.com/v123abc-test-stream.html' });

const { parseUrl } = await import('../../src/core/url.js');

describe('parseUrl', () => {
    it('parses an absolute URL', () => {
        const url = parseUrl('https://rumble.com/service.php?name=emote.list');
        expect(url).not.toBeNull();
        expect(url.searchParams.get('name')).toBe('emote.list');
    });

    it('returns null for the empty URL of an opaque response', () => {
        expect(parseUrl('')).toBeNull();
    });

    it('returns null for missing input', () => {
        expect(parseUrl(null)).toBeNull();
        expect(parseUrl(undefined)).toBeNull();
        expect(parseUrl(123)).toBeNull();
    });

    it('resolves a relative URL against the page', () => {
        const url = parseUrl('/service.php?name=emote.list');
        expect(url.href).toBe('https://rumble.com/service.php?name=emote.list');
    });

    it('returns null for an unparseable URL', () => {
        expect(parseUrl('http://')).toBeNull();
    });
});
