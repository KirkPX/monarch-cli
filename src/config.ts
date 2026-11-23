import { getCredentialStore } from "./auth.js";
import { settingsFilePath } from "./paths.js";
import { loadSettings, updateSettings, type Settings } from "./settings.js";

const DEFAULT_BASE_URL = "https://api.monarch.com";
const DEFAULT_ACCOUNT = "default";

export type ResolveOptions = {
  baseUrl?: string;
  apiKey?: string;
  account?: string;
};

export type ResolvedConfig = {
  baseUrl: string;
  apiKey: string | null;
  account: string;
  timeoutMs?: number;
  deviceId?: string;
};

/**
 * The single precedence chain: flags > env > settings file / keychain > default.
 *
 * `settings` can be passed in so `doctor` can use this chain after a broken
 * settings file. Every other caller lets a broken file stop the command.
 */
export function resolveConfig(
  opts: ResolveOptions = {},
  settings: Settings = loadSettings()
): ResolvedConfig {
  const account =
    opts.account || env("MONARCH_ACCOUNT") || settings.account || DEFAULT_ACCOUNT;
  const baseUrl =
    opts.baseUrl || env("MONARCH_BASE_URL") || settings.baseUrl || DEFAULT_BASE_URL;
  const apiKey =
    opts.apiKey || env("MONARCH_API_KEY") || getCredentialStore().getApiKey(account) || null;

  return { baseUrl, apiKey, account, timeoutMs: settings.timeoutMs, deviceId: settings.deviceId };
}

export function setBaseUrl(baseUrl: string): void {
  updateSettings({ baseUrl });
}

export function setAccount(account: string): void {
  updateSettings({ account });
}

/** Where the settings file lives. `doctor` and `config path` print it. */
export function getConfigPath(): string {
  return settingsFilePath();
}

function env(name: string): string | undefined {
  const val = process.env[name];
  return val && val.length > 0 ? val : undefined;
}
