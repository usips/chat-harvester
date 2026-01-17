/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Chrome Extension API type declarations (subset used by CHUCK)
 */

declare namespace chrome {
    namespace storage {
        interface StorageArea {
            get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(keys: string | string[]): Promise<void>;
            clear(): Promise<void>;
        }

        const sync: StorageArea;
        const local: StorageArea;
    }

    namespace runtime {
        function getURL(path: string): string;
        function sendMessage<T = unknown>(message: unknown): Promise<T>;
        function sendMessage<T = unknown>(extensionId: string, message: unknown): Promise<T>;

        const onMessage: {
            addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
            removeListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
        };

        const onInstalled: {
            addListener(callback: (details: { reason: string; previousVersion?: string }) => void): void;
        };

        interface MessageSender {
            tab?: {
                id?: number;
                url?: string;
                title?: string;
            };
            frameId?: number;
            id?: string;
            url?: string;
            origin?: string;
        }

        const id: string;
        const lastError: { message?: string } | undefined;
    }

    namespace tabs {
        interface Tab {
            id?: number;
            index: number;
            windowId: number;
            highlighted: boolean;
            active: boolean;
            pinned: boolean;
            url?: string;
            title?: string;
            favIconUrl?: string;
            status?: string;
            incognito: boolean;
        }

        function query(queryInfo: {
            active?: boolean;
            currentWindow?: boolean;
            url?: string | string[];
        }): Promise<Tab[]>;

        function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;

        function create(createProperties: {
            url?: string;
            active?: boolean;
            index?: number;
        }): Promise<Tab>;
    }
}
