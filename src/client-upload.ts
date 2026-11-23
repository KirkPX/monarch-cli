// The second transport: uploading a file to the image host Monarch uses for
// attachments. Monarch hands out a signed, one-time upload ticket; the file goes
// straight to that host, and Monarch is then told the file's id.
//
// This transport NEVER carries the Monarch token or any Monarch header. It talks
// to one host only, and it meets the same rules as src/client.ts: an explicit
// time limit, a bounded retry (only on 429, because a repeated upload would make a
// second copy), and typed errors with no raw reply body.

import { ApiError, NetworkError, TimeoutError, UsageError } from "./errors.js";

export const UPLOAD_HOST = "api.cloudinary.com";
export const UPLOAD_URL = `https://${UPLOAD_HOST}/v1_1/monarch-money/image/upload/`;

export type UploadTicket = {
  timestamp: string | number;
  folder: string;
  signature: string;
  api_key: string;
  upload_preset: string;
};

export type UploadResult = { public_id: string; format: string; bytes: number };

export type UploadOptions = { url?: string; timeoutMs?: number; maxRetries?: number; retryDelayMs?: number };

export async function uploadFile(
  file: { name: string; type: string; data: Uint8Array },
  ticket: UploadTicket,
  opts: UploadOptions = {}
): Promise<UploadResult> {
  const url = opts.url ?? UPLOAD_URL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 3;
  const host = new URL(url).host;
  if (!opts.url && host !== UPLOAD_HOST) throw new UsageError(`Refusing to upload to ${host}.`);
  const operation = "attachment upload";

  for (let attempt = 1; ; attempt++) {
    // A new form each attempt: a request body can be read only once.
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(file.data)], { type: file.type }), file.name);
    form.append("timestamp", String(ticket.timestamp));
    form.append("folder", ticket.folder);
    form.append("signature", ticket.signature);
    form.append("api_key", ticket.api_key);
    form.append("upload_preset", ticket.upload_preset);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let body: unknown;
    try {
      // No headers of our own: fetch sets the multipart boundary itself.
      response = await fetch(url, { method: "POST", body: form, signal: controller.signal });
      body = await response.json().catch(() => null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new TimeoutError({ operation, timeoutMs });
      if (error instanceof TypeError) throw new NetworkError({ operation, host, cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const r = body as Partial<UploadResult> | null;
      if (!r || typeof r.public_id !== "string" || typeof r.format !== "string" || typeof r.bytes !== "number") {
        throw new ApiError({ status: 502, statusText: "Unexpected reply", operation, safeDetail: "the upload reply had no file id" });
      }
      return r as UploadResult;
    }
    if (response.status === 429 && attempt < maxRetries) {
      await new Promise((res) => setTimeout(res, (opts.retryDelayMs ?? 2_000) * attempt));
      continue;
    }
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new ApiError({
      status: response.status,
      statusText: response.statusText,
      operation,
      safeDetail: typeof message === "string" ? message.slice(0, 300) : "no response detail",
    });
  }
}
