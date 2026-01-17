/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Greasemonkey/Tampermonkey API type declarations
 */

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];

declare function GM_getResourceText(name: string): string;
declare function GM_getResourceURL(name: string): string;

declare function GM_addStyle(css: string): HTMLStyleElement;

declare function GM_openInTab(url: string, options?: { active?: boolean; insert?: boolean; setParent?: boolean }): { close: () => void; closed: boolean; onclose?: () => void };

declare function GM_registerMenuCommand(name: string, callback: () => void, accessKey?: string): number;
declare function GM_unregisterMenuCommand(menuCmdId: number): void;

declare function GM_notification(details: {
    text: string;
    title?: string;
    image?: string;
    highlight?: boolean;
    silent?: boolean;
    timeout?: number;
    onclick?: () => void;
    ondone?: () => void;
}, ondone?: () => void): void;

declare function GM_setClipboard(data: string, type?: string): void;

declare function GM_xmlhttpRequest(details: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    data?: string | Blob | FormData;
    binary?: boolean;
    timeout?: number;
    context?: unknown;
    responseType?: string;
    overrideMimeType?: string;
    anonymous?: boolean;
    user?: string;
    password?: string;
    onload?: (response: GMXMLHttpRequestResponse) => void;
    onerror?: (response: GMXMLHttpRequestResponse) => void;
    onreadystatechange?: (response: GMXMLHttpRequestResponse) => void;
    ontimeout?: (response: GMXMLHttpRequestResponse) => void;
    onprogress?: (response: GMXMLHttpRequestResponse) => void;
}): { abort: () => void };

interface GMXMLHttpRequestResponse {
    finalUrl: string;
    readyState: number;
    status: number;
    statusText: string;
    responseHeaders: string;
    response: unknown;
    responseXML?: Document;
    responseText?: string;
    context?: unknown;
}

declare function GM_download(details: {
    url: string;
    name: string;
    headers?: Record<string, string>;
    saveAs?: boolean;
    onerror?: (error: { error: string; details?: string }) => void;
    onload?: () => void;
    onprogress?: (progress: { done: number; total: number }) => void;
    ontimeout?: () => void;
}): { abort: () => void };

declare function GM_log(message: string): void;

declare const GM_info: {
    script: {
        name: string;
        namespace: string;
        description: string;
        version: string;
        includes: string[];
        excludes: string[];
        matches: string[];
        resources: Record<string, string>;
        runAt: string;
        uuid: string;
    };
    scriptHandler: string;
    scriptMetaStr: string;
    version: string;
};

declare const unsafeWindow: Window & typeof globalThis;

declare const GM: {
    getValue: <T>(key: string, defaultValue?: T) => Promise<T>;
    setValue: (key: string, value: unknown) => Promise<void>;
    deleteValue: (key: string) => Promise<void>;
    listValues: () => Promise<string[]>;
    getResourceUrl: (name: string) => Promise<string>;
    notification: (details: {
        text: string;
        title?: string;
        image?: string;
        highlight?: boolean;
        silent?: boolean;
        timeout?: number;
        onclick?: () => void;
        ondone?: () => void;
    }) => Promise<void>;
    openInTab: (url: string, options?: { active?: boolean; insert?: boolean; setParent?: boolean }) => Promise<{ close: () => void; closed: boolean; onclose?: () => void }>;
    setClipboard: (data: string, type?: string) => Promise<void>;
    xmlHttpRequest: (details: Parameters<typeof GM_xmlhttpRequest>[0]) => Promise<GMXMLHttpRequestResponse>;
    info: typeof GM_info;
};
