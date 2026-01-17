/**
 * CHUCK - Chat Harvesting Universal Connection Kit
 * Configuration management with storage abstraction
 */

export interface PlatformConfig {
    kick?: boolean;
    odysee?: boolean;
    rumble?: boolean;
    twitch?: boolean;
    youtube?: boolean;
    vk?: boolean;
    x?: boolean;
    xmrchat?: boolean;
    facebook?: boolean;
}

export interface ChuckConfig {
    serverUrl: string;
    debug: boolean;
    platforms: PlatformConfig;
    [key: string]: unknown;
}

// Default configuration
export const DEFAULTS: ChuckConfig = {
    serverUrl: 'ws://127.0.0.2:1350/chat.ws',
    debug: false,
    platforms: {
        kick: true,
        odysee: true,
        rumble: true,
        twitch: true,
        youtube: true,
        vk: true,
        x: true,
        xmrchat: true,
        facebook: true
    }
};

// Detect environment
const isExtension = typeof chrome !== 'undefined' && chrome.storage;
const isUserscript = typeof GM_getValue !== 'undefined';

/**
 * Configuration class that abstracts storage between userscript and extension
 */
export class Config {
    private static _cache: ChuckConfig | null = null;

    /**
     * Get a configuration value
     */
    static async get<K extends keyof ChuckConfig>(key: K, defaultValue?: ChuckConfig[K]): Promise<ChuckConfig[K]>;
    static async get(key: string, defaultValue?: unknown): Promise<unknown>;
    static async get(key: string, defaultValue?: unknown): Promise<unknown> {
        const config = await this._loadConfig();
        return config[key] ?? defaultValue ?? (DEFAULTS as Record<string, unknown>)[key];
    }

    /**
     * Set a configuration value
     */
    static async set<K extends keyof ChuckConfig>(key: K, value: ChuckConfig[K]): Promise<void>;
    static async set(key: string, value: unknown): Promise<void>;
    static async set(key: string, value: unknown): Promise<void> {
        const config = await this._loadConfig();
        (config as Record<string, unknown>)[key] = value;
        await this._saveConfig(config);
    }

    /**
     * Get all configuration
     */
    static async getAll(): Promise<ChuckConfig> {
        return await this._loadConfig();
    }

    /**
     * Reset configuration to defaults
     */
    static async reset(): Promise<void> {
        await this._saveConfig({ ...DEFAULTS });
        this._cache = null;
    }

    /**
     * Load configuration from storage
     */
    private static async _loadConfig(): Promise<ChuckConfig> {
        if (this._cache) {
            return this._cache;
        }

        let config: ChuckConfig = { ...DEFAULTS };

        if (isExtension) {
            try {
                const stored = await chrome.storage.sync.get('chuck_config');
                if (stored.chuck_config) {
                    config = { ...DEFAULTS, ...stored.chuck_config as Partial<ChuckConfig> };
                }
            } catch (e) {
                console.warn('[CHUCK] Failed to load extension config:', e);
            }
        } else if (isUserscript) {
            try {
                const stored = GM_getValue<string>('chuck_config');
                if (stored) {
                    config = { ...DEFAULTS, ...JSON.parse(stored) as Partial<ChuckConfig> };
                }
            } catch (e) {
                console.warn('[CHUCK] Failed to load userscript config:', e);
            }
        }

        this._cache = config;
        return config;
    }

    /**
     * Save configuration to storage
     */
    private static async _saveConfig(config: ChuckConfig): Promise<void> {
        this._cache = config;

        if (isExtension) {
            try {
                await chrome.storage.sync.set({ chuck_config: config });
            } catch (e) {
                console.warn('[CHUCK] Failed to save extension config:', e);
            }
        } else if (isUserscript) {
            try {
                GM_setValue('chuck_config', JSON.stringify(config));
            } catch (e) {
                console.warn('[CHUCK] Failed to save userscript config:', e);
            }
        }
    }
}
