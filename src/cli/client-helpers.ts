import { ApiClient, type RetryInfo } from "../client.js";
import { resolveConfig } from "../config.js";
import { requireApiKey } from "./guardrails.js";
import { reporter, type Reporter } from "./output.js";

/**
 * The client a command uses: settings resolved, sign-in required, retries shown.
 * A retry message goes to stderr at a terminal, and stays out of a piped run.
 */
export function createClient(
  opts: { json?: boolean; account?: string; baseUrl?: string } = {}
): ApiClient {
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });
  requireApiKey(cfg.apiKey);
  const r = reporter(opts);
  return new ApiClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    deviceId: cfg.deviceId,
    onRetry: (info) => reportRetry(r, info),
  });
}

function reportRetry(r: Reporter, info: RetryInfo): void {
  const seconds = Math.ceil(info.delayMs / 1000);
  r.note(
    `The service answered ${info.status} for ${info.operation}. Retrying in ${seconds}s (${info.attempt + 1}/${info.maxRetries}).`
  );
}
