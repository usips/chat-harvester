/**
 * CHUCK - currency parsing tests
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseAmount, parseLocalizedNumber } from '../../src/core/currency.js';

describe('parseAmount', () => {
    it.each([
        // Formats seen in the YouTube audit.
        ['CA$5.00', 5, 'CAD'],
        ['R$10,00', 10, 'BRL'],
        ['5,00 €', 5, 'EUR'],
        ['5,00 €', 5, 'EUR'],
        ['€1.234,56', 1234.56, 'EUR'],
        ['₫20,000', 20000, 'VND'],
        ['THB 100.00', 100, 'THB'],
        ['zł20,00', 20, 'PLN'],
        // Existing and added prefixes.
        ['$5.00', 5, 'USD'],
        ['US$1,000.00', 1000, 'USD'],
        ['A$10.00', 10, 'AUD'],
        ['NZ$2.50', 2.5, 'NZD'],
        ['HK$50.00', 50, 'HKD'],
        ['NT$75', 75, 'TWD'],
        ['MX$100.00', 100, 'MXN'],
        ['JP¥1,000', 1000, 'JPY'],
        ['CN¥30.00', 30, 'CNY'],
        ['¥1000', 1000, 'JPY'],
        ['₩10,000', 10000, 'KRW'],
        ['₱100.00', 100, 'PHP'],
        ['₹500.00', 500, 'INR'],
        ['₪20.00', 20, 'ILS'],
        ['฿35.00', 35, 'THB'],
        ['£5.00', 5, 'GBP'],
        // ISO codes on either side.
        ['10.00 EUR', 10, 'EUR'],
        ['IDR 15,000', 15000, 'IDR'],
        ['MYR 5.00', 5, 'MYR'],
        ['VND 20.000', 20000, 'VND'],
        ['100 SEK', 100, 'SEK'],
        ['CHF 5.00', 5, 'CHF'],
        // Space-grouped thousands.
        ['1 234,56 zł', 1234.56, 'PLN'],
    ])('parses %s', (text, amount, currency) => {
        expect(parseAmount(text)).toEqual({ amount, currency });
    });

    it('rejects text that is not a price', () => {
        expect(parseAmount('')).toBeNull();
        expect(parseAmount('hello')).toBeNull();
        expect(parseAmount('5.00')).toBeNull();
        expect(parseAmount('XYZ 5.00')).toBeNull();
        expect(parseAmount(undefined)).toBeNull();
        expect(parseAmount(null)).toBeNull();
    });

    it('never throws and returns a finite amount', () => {
        fc.assert(fc.property(fc.string(), (text) => {
            const parsed = parseAmount(text);
            return parsed === null || Number.isFinite(parsed.amount);
        }), { numRuns: 500 });
    });
});

describe('parseLocalizedNumber', () => {
    it('treats a final one- or two-digit group as decimals', () => {
        expect(parseLocalizedNumber('1,5')).toBe(1.5);
        expect(parseLocalizedNumber('1.50')).toBe(1.5);
        expect(parseLocalizedNumber('1.234.567,89')).toBe(1234567.89);
        expect(parseLocalizedNumber('1,234,567.89')).toBe(1234567.89);
    });

    it('treats a final three-digit group as thousands', () => {
        expect(parseLocalizedNumber('1,000')).toBe(1000);
        expect(parseLocalizedNumber('1.000')).toBe(1000);
        expect(parseLocalizedNumber("1'000")).toBe(1000);
    });
});
