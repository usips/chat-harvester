/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Display-price parsing ("CA$5.00", "5,00 €", "₫20,000") into an amount and ISO currency.
 */

export interface ParsedAmount {
    amount: number;
    currency: string;
}

/** Lower-case symbol or code → ISO 4217 code. Longer keys win over their suffixes. */
const CURRENCY_SYMBOLS: Record<string, string> = {
    // Dollar variants
    'us$': 'USD', 'ca$': 'CAD', 'c$': 'CAD', 'a$': 'AUD', 'au$': 'AUD', 'nz$': 'NZD',
    'hk$': 'HKD', 'nt$': 'TWD', 'mx$': 'MXN', 's$': 'SGD', 'r$': 'BRL', 'rd$': 'DOP',
    'clp$': 'CLP', 'cop$': 'COP', 'ar$': 'ARS', '$u': 'UYU', '$': 'USD',
    // Yen / yuan
    'jp¥': 'JPY', 'cn¥': 'CNY', '¥': 'JPY', '￥': 'JPY',
    // Single-character symbols
    '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR', '₪': 'ILS', '₱': 'PHP', '₽': 'RUB',
    '₺': 'TRY', '₦': 'NGN', '₲': 'PYG', '₡': 'CRC', '₫': 'VND', '฿': 'THB', '₴': 'UAH',
    '₸': 'KZT', '₾': 'GEL', '৳': 'BDT', '₭': 'LAK', '₮': 'MNT',
    // Latin and other local abbreviations
    's/': 'PEN', 'b/.': 'PAB', 'bs.': 'BOB', 'q': 'GTQ', 'l': 'HNL', 'r': 'ZAR',
    'br': 'BYN', 'kn': 'HRK', 'kč': 'CZK', 'kr': 'SEK', 'ft': 'HUF', 'zł': 'PLN',
    'cfa': 'XOF', 'ush': 'UGX', 'lei': 'RON', 'rp': 'IDR', 'rm': 'MYR', 'ksh': 'KES',
    'лв': 'BGN', 'ден': 'MKD', 'дин.': 'RSD', 'ر.س': 'SAR', 'د.إ': 'AED',
};

/** ISO 4217 codes accepted as a prefix or suffix ("THB 100.00", "10.00 EUR"). */
const ISO_CODES = [
    'AED', 'ARS', 'AUD', 'BAM', 'BDT', 'BGN', 'BHD', 'BOB', 'BRL', 'BYN', 'CAD', 'CHF',
    'CLP', 'CNY', 'COP', 'CRC', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'EUR', 'GBP', 'GEL',
    'GTQ', 'HKD', 'HNL', 'HRK', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JOD', 'JPY', 'KES',
    'KRW', 'KWD', 'KZT', 'LKR', 'MAD', 'MKD', 'MXN', 'MYR', 'NGN', 'NIO', 'NOK', 'NPR',
    'NZD', 'OMR', 'PAB', 'PEN', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB',
    'SAR', 'SEK', 'SGD', 'THB', 'TND', 'TRY', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU',
    'VND', 'XOF', 'ZAR',
];

for (const code of ISO_CODES) {
    CURRENCY_SYMBOLS[code.toLowerCase()] = code;
}

const SYMBOL_PATTERN = Object.keys(CURRENCY_SYMBOLS)
    .sort((a, b) => b.length - a.length)
    .map(s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .join('|');

/** Digits with `.`, `,`, `'` or (narrow) spaces as separators, starting and ending on a digit. */
const NUMBER_PATTERN = "\\d(?:[\\d.,'\\u00a0\\u202f ]*\\d)?";

const AMOUNT_REGEX = new RegExp(
    `^\\s*(?:(${SYMBOL_PATTERN})\\s*(${NUMBER_PATTERN})|(${NUMBER_PATTERN})\\s*(${SYMBOL_PATTERN}))\\s*$`,
    'i'
);

/**
 * Parse a localised number. The last `.` or `,` is the decimal point when it is
 * followed by exactly one or two digits; every other separator groups thousands.
 */
export function parseLocalizedNumber(text: string): number | null {
    const lastSep = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    let integer = text;
    let fraction = '';

    if (lastSep !== -1) {
        const tail = text.slice(lastSep + 1);
        if (/^\d{1,2}$/.test(tail)) {
            integer = text.slice(0, lastSep);
            fraction = tail;
        }
    }

    const digits = integer.replace(/\D/g, '');
    if (digits.length === 0) return null;
    const value = parseFloat(fraction ? `${digits}.${fraction}` : digits);
    return Number.isFinite(value) ? value : null;
}

/** Parse a display price such as "CA$5.00", "€1.234,56" or "THB 100.00". */
export function parseAmount(text: string | null | undefined): ParsedAmount | null {
    if (typeof text !== 'string') return null;
    const match = text.match(AMOUNT_REGEX);
    if (!match) return null;

    const symbol = (match[1] ?? match[4] ?? '').toLowerCase();
    const currency = CURRENCY_SYMBOLS[symbol];
    const amount = parseLocalizedNumber(match[2] ?? match[3] ?? '');
    if (!currency || amount === null) return null;

    return { amount, currency };
}
