// `monarch export` downloads everything needed to keep a local copy of Monarch:
// accounts, categories, and every field of every transaction in a date range.
// The file has one fixed shape (below), so a loader can rely on it. Every
// transaction is checked to carry every field before the file is written.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError, ConfigError, fileErrorReason } from "../../errors.js";
import { listAccounts } from "../../monarch/accounts.js";
import { listCategories } from "../../monarch/categories.js";
import { FULL_KEYS, listTransactions } from "../../monarch/transactions.js";
import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";

export type ExportOpts = { json?: boolean; baseUrl?: string; since?: string; until?: string; out?: string };

export type ExportFile = {
  pulled_at: string;
  window: { since: string; until: string };
  accounts: unknown[];
  categories: unknown[];
  txnTotalCount: number;
  transactions: Record<string, unknown>[];
  counts: { accounts: number; categories: number; transactions: number };
};

export async function exportCommand(opts: ExportOpts): Promise<void> {
  const r = reporter(opts);
  const client = createClient(opts);
  const today = new Date();
  const until = opts.until ?? isoDate(today);
  const since = opts.since ?? isoDate(new Date(today.getTime() - 90 * 86_400_000));

  r.note("Reading accounts and categories…");
  const accounts = await listAccounts(client);
  const categories = await listCategories(client);
  const page = await listTransactions(client, {
    filters: { startDate: since, endDate: until },
    full: true,
    onPage: (got, total) => r.note(`Read ${got} of ${total} transactions…`),
  });
  const missing = page.transactions.filter((t) => FULL_KEYS.some((k) => !(k in t)));
  if (missing.length) {
    throw new ApiError({
      status: 502,
      statusText: "Unexpected reply",
      operation: "export",
      safeDetail: `${missing.length} transactions lack fields this CLI asked for (first: ${missing[0]!.id}); Monarch may have changed`,
    });
  }

  const file: ExportFile = {
    pulled_at: new Date().toISOString(),
    window: { since, until },
    accounts,
    categories,
    txnTotalCount: page.totalCount,
    transactions: page.transactions,
    counts: { accounts: accounts.length, categories: categories.length, transactions: page.transactions.length },
  };
  const summary = `${accounts.length} accounts, ${categories.length} categories, ${page.transactions.length} transactions (${since} to ${until})`;

  if (!opts.out) {
    r.result(file, JSON.stringify(file));
    return;
  }
  const path = resolve(opts.out);
  writeAtomic(path, JSON.stringify(file));
  r.result({ written: path, ...file.counts, window: file.window }, `Wrote ${summary} to ${path}`);
}

/** Write beside the target, then rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new ConfigError(`Cannot write ${path}: ${fileErrorReason(error)}.`);
  }
}

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
