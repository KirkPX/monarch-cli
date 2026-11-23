// HTTP client. One place that talks to Monarch, so timeout, retry, auth, and error redaction are
// uniform. Every request has an explicit timeout; retries are limited and visible; errors
// carry operation + status + safe detail.
//
// Monarch speaks GraphQL at /graphql, plus one REST route for sign-in (/auth/login/).
// `graphql()` sends reads and writes as POST, so it retries a 5xx only when the
// document holds no mutation: a 500 from a mutation may already have changed data.

import { ApiError, NetworkError, TimeoutError, UsageError } from "./errors.js";

export type ClientOptions = {
  baseUrl: string;
  /** Empty for the sign-in request, which has no token yet. */
  apiKey: string;
  /** Monarch remembers a device it has seen, and then skips the emailed code. */
  deviceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
};

export type RetryInfo = {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number;
  operation: string;
};

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  method?: RequestMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** A POST that cannot change anything (a GraphQL read). Lets a 5xx be retried. */
  idempotent?: boolean;
  /** Statuses whose body the caller reads itself instead of an ApiError (sign-in). */
  acceptStatus?: number[];
};

export type ApiResponse<T = unknown> = {
  status: number;
  data: T | null;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deviceId?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly onRetry?: (info: RetryInfo) => void;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.deviceId = options.deviceId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.onRetry = options.onRetry;
  }

  async request<T = unknown>(
    path: string,
    opts: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const { method = "GET", body, params, headers: extraHeaders, idempotent, acceptStatus } = opts;
    const url = buildUrl(this.baseUrl, path, params);
    const operation = `${method} ${path}`;

    for (let attempt = 1; ; attempt++) {
      const { response, data } = await this.fetchWithTimeout(url, operation, {
        method,
        headers: {
          Accept: "application/json",
          "Client-Platform": "web",
          ...(this.deviceId ? { "Device-UUID": this.deviceId } : {}),
          ...this.authHeader(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (response.ok || acceptStatus?.includes(response.status)) {
        return { status: response.status, data: data as T | null };
      }

      if (isRetryable(response.status, method, idempotent) && attempt < this.maxRetries) {
        const delayMs = retryDelayMs(response, attempt, this.retryBaseDelayMs);
        this.onRetry?.({
          attempt,
          maxRetries: this.maxRetries,
          delayMs,
          status: response.status,
          operation,
        });
        await sleep(delayMs);
        continue;
      }

      throw new ApiError({
        status: response.status,
        statusText: response.statusText,
        operation,
        safeDetail: extractSafeDetail(data, this.apiKey),
      });
    }
  }

  /**
   * Send one request and read its reply, both inside one time limit. A reply that
   * starts quickly and then stalls is stopped too, not only one that never starts.
   */
  private async fetchWithTimeout(
    url: string,
    operation: string,
    init: RequestInit
  ): Promise<{ response: Response; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { response, data: await parseResponseBody(response) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError({ operation, timeoutMs: this.timeoutMs });
      }
      // fetch reports every network failure as "fetch failed", with the reason,
      // such as ENOTFOUND, on `cause`.
      if (error instanceof TypeError) {
        throw new NetworkError({ operation, host: new URL(url).host, cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Monarch reads the key as `Authorization: Token <key>`. fetch drops
   * Authorization on a redirect to another host, so the key cannot follow one.
   */
  private authHeader(): Record<string, string> {
    return this.apiKey ? { Authorization: `Token ${this.apiKey}` } : {};
  }

  /**
   * One GraphQL operation. Monarch answers 200 with an `errors` list when a query
   * is wrong or refused; that becomes an ApiError too, so no caller can mistake
   * it for an empty result.
   */
  async graphql<T = Record<string, unknown>>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const { data } = await this.request<{ data?: T; errors?: unknown[] }>("/graphql", {
      method: "POST",
      body: { operationName, query, variables },
      idempotent: !isMutation(query),
    });
    const operation = `GraphQL ${operationName}`;
    if (data && Array.isArray(data.errors) && data.errors.length > 0) {
      const detail = extractSafeDetail(data, this.apiKey);
      const refused = /auth|credential|not authenticated|permission/i.test(detail);
      throw new ApiError({
        status: refused ? 401 : 400,
        statusText: refused ? "Not signed in" : "GraphQL error",
        operation,
        safeDetail: detail,
      });
    }
    if (!data || typeof data.data !== "object" || data.data === null) {
      throw new ApiError({
        status: 502,
        statusText: "Unexpected reply",
        operation,
        safeDetail: "the reply held no data",
      });
    }
    return data.data;
  }
}

/** True when a GraphQL document changes data. Comments and strings cannot hide one. */
export function isMutation(query: string): boolean {
  const code = query.replace(/#.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return /(^|[}\s])mutation\b/.test(code);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * The full address for a request. It must stay on the signed-in service, because
 * every request carries the API key. A path such as `//other.example/x`, or a full
 * address elsewhere, would otherwise send the key to that host.
 *
 * A path with one leading slash stays under the base URL, so `/me` on
 * `https://api.example.com/v1` is `/v1/me`.
 */
export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  let root: URL;
  let url: URL;
  try {
    root = new URL(base.replace(/\/*$/, "/"));
    url = new URL(/^\/(?![/\\])/.test(path) ? path.slice(1) : path, root);
  } catch {
    throw new UsageError(
      `Cannot build a request address from "${path}" on "${base}".`,
      "Check the base URL. `monarch doctor` shows the one in use."
    );
  }
  if (url.origin !== root.origin) {
    throw new UsageError(
      `Refusing to send a request to ${url.host}: requests go only to ${root.host}.`,
      "Pass a path on this service, such as /me."
    );
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replaying one of these cannot create or change anything. */
const IDEMPOTENT: ReadonlySet<RequestMethod> = new Set<RequestMethod>(["GET"]);

/**
 * 429 is always safe to retry: the request was rejected, so nothing was applied.
 * 5xx is safe only on an idempotent request. A 500 from a POST may have created the
 * record before it failed to answer, so replaying it could create a duplicate. A
 * GraphQL read is a POST that the caller marks idempotent.
 */
export function isRetryable(status: number, method: RequestMethod, idempotent = false): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return idempotent || IDEMPOTENT.has(method);
  return false;
}

/**
 * Retry-After wins: the server is saying when it will be ready. Otherwise back off
 * exponentially with jitter, so many clients do not retry at the same moment.
 */
function retryDelayMs(
  response: Response,
  attempt: number,
  baseMs: number,
  capMs = 30_000
): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const backoff = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    return await response.json();
  } catch (error) {
    // A timeout while the reply arrives must reach the caller as a timeout.
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

/**
 * The service's own reason for a refusal. It is what tells a person which field
 * was wrong, so it is shown whole, with only the key removed. Add your API's
 * error shape here if it uses other names.
 */
export function extractSafeDetail(data: unknown, apiKey?: string): string {
  if (typeof data === "string" && data.trim() && !data.trimStart().startsWith("<")) {
    return tidy(data, apiKey);
  }
  if (!data || typeof data !== "object") return "no response detail";
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "MESSAGE", "error", "msg", "detail", "error_code"]) {
    if (typeof obj[key] === "string" && obj[key]) parts.push(obj[key] as string);
  }
  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors.slice(0, 3)) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const e = item as Record<string, unknown>;
        const text = [e.title, e.detail ?? e.message].filter((x) => typeof x === "string" && x).join(": ");
        if (text) parts.push(text);
      }
    }
  }
  return parts.length ? tidy(parts.join("; "), apiKey) : "no response detail";
}

function tidy(text: string, apiKey?: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (apiKey) out = out.split(apiKey).join("****");
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}
