// Monarch's mutations answer 200 even when they refuse. The refusal sits in the
// payload's own `errors` field (`{ updateTransaction: { errors: [...] } }`). This
// turns it into an ApiError, so a refused write can never read as a success.
//
// Monarch often hides the real reason behind "Something went wrong". That is why
// every write in this CLI also reads the record back before it reports success.

import { ApiError } from "../errors.js";

type PayloadError = { message?: unknown; code?: unknown; fieldErrors?: unknown };

/** Return `data[key]`, or throw when Monarch put an error in it. */
export function payload<T = Record<string, unknown>>(
  data: Record<string, unknown>,
  key: string,
  operation: string
): T {
  const value = data[key] as (Record<string, unknown> & { errors?: unknown }) | null | undefined;
  if (value === null || value === undefined) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation, safeDetail: `no ${key} in the reply` });
  }
  const errors = toList(value.errors);
  if (errors.length > 0) {
    throw new ApiError({ status: 400, statusText: "Refused", operation, safeDetail: describe(errors) });
  }
  return value as T;
}

function toList(errors: unknown): PayloadError[] {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.filter(Boolean) as PayloadError[];
  if (typeof errors === "object") {
    const e = errors as PayloadError;
    // Monarch's PayloadErrorFields object is present but empty on success.
    const hasContent = e.message || e.code || (Array.isArray(e.fieldErrors) && e.fieldErrors.length > 0);
    return hasContent ? [e] : [];
  }
  return [];
}

function describe(errors: PayloadError[]): string {
  const parts = errors.slice(0, 3).map((e) => {
    const fields = Array.isArray(e.fieldErrors)
      ? (e.fieldErrors as { field?: unknown; messages?: unknown }[])
          .map((f) => `${String(f.field)}: ${Array.isArray(f.messages) ? f.messages.join(", ") : ""}`)
          .join("; ")
      : "";
    return [e.message, e.code, fields].filter((x) => typeof x === "string" && x).join(" — ");
  });
  const text = parts.filter(Boolean).join("; ") || "Monarch refused the change and gave no reason";
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
