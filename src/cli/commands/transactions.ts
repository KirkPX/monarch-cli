// `monarch transactions …`: read every field, and change transactions safely.
// Every change checks what Monarch holds now, sends only what differs, and reads
// the transaction back before it reports success. See src/monarch/transactions.ts.

import { z } from "zod";
import { UsageError } from "../../errors.js";
import { listCategories, resolveCategory } from "../../monarch/categories.js";
import { listTags, resolveTags } from "../../monarch/tags.js";
import {
  changeTransaction,
  createTransaction,
  deleteTransaction,
  FIELD_NAMES,
  getTransaction,
  listTransactions,
  transactionsSummary,
  type ChangeResult,
  type ChangeSpec,
  type Field,
  type Lookups,
  type Transaction,
  type TransactionFilters,
} from "../../monarch/transactions.js";
import { createClient } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun, type GuardOptions, type MutationOutcome } from "../guardrails.js";
import { reporter, type Reporter } from "../output.js";
import { readJsonBody } from "../read-file.js";

type Common = { json?: boolean; account?: string; baseUrl?: string } & GuardOptions;

// ── Reads ────────────────────────────────────────────────────────────────────

export type ListOpts = Common & {
  start?: string;
  end?: string;
  account?: string[] | string;
  category?: string[];
  tag?: string[];
  search?: string;
  needsReview?: boolean;
  limit?: number;
  all?: boolean;
  full?: boolean;
};

export async function listCommand(opts: ListOpts): Promise<void> {
  const r = reporter(opts);
  // --account on this command is a Monarch account filter, not the saved sign-in name.
  const client = createClient({ json: opts.json, baseUrl: opts.baseUrl });
  if (Boolean(opts.start) !== Boolean(opts.end)) {
    throw new UsageError("Give both --start and --end, or neither.", "Monarch reads a date range only with both ends.");
  }
  const filters: TransactionFilters = { startDate: opts.start, endDate: opts.end, search: opts.search };
  if (opts.needsReview) filters.needsReview = true;
  if (opts.account) filters.accounts = Array.isArray(opts.account) ? opts.account : [opts.account];
  if (opts.category?.length) {
    const cats = await listCategories(client);
    filters.categories = opts.category.map((c) => resolveCategory(cats, c).id);
  }
  if (opts.tag?.length) filters.tags = resolveTags(await listTags(client), opts.tag).map((t) => t.id);

  const page = await listTransactions(client, {
    filters,
    full: opts.full,
    limit: opts.all ? undefined : (opts.limit ?? 100),
    onPage: (got, total) => r.note(`Read ${got} of ${total}…`),
  });
  r.result(
    { totalCount: page.totalCount, count: page.transactions.length, transactions: page.transactions },
    page.transactions.length === 0
      ? "No transactions match."
      : [
          ...page.transactions.map(line),
          "",
          `${page.transactions.length} shown of ${page.totalCount}.${page.transactions.length < page.totalCount ? " Use --all or --limit for more." : ""}`,
        ].join("\n")
  );
}

export function line(t: Transaction): string {
  const amount = t.amount.toFixed(2).padStart(11);
  const tags = t.tags?.length ? `  [${t.tags.map((x) => x.name).join(", ")}]` : "";
  return `${t.date}  ${amount}  ${(t.merchant?.name ?? "").padEnd(28).slice(0, 28)}  ${(t.category?.name ?? "").padEnd(22).slice(0, 22)}  ${t.account?.displayName ?? ""}${t.pending ? "  (pending)" : ""}${tags}  ${t.id}`;
}

export async function getCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  const t = await getTransaction(createClient(opts), id, true);
  r.result(t);
}

export async function summaryCommand(opts: Common & { start?: string; end?: string }): Promise<void> {
  const r = reporter(opts);
  if (Boolean(opts.start) !== Boolean(opts.end)) throw new UsageError("Give both --start and --end, or neither.");
  const s = await transactionsSummary(createClient(opts), opts.start ? { startDate: opts.start, endDate: opts.end } : {});
  r.result(s, Object.entries(s).map(([k, v]) => `${k.padEnd(12)} ${v}`).join("\n"));
}

// ── Changes ──────────────────────────────────────────────────────────────────

export type UpdateOpts = Common & {
  category?: string;
  merchant?: string;
  date?: string;
  amount?: string;
  notes?: string;
  tags?: string;
  hideFromReports?: string;
  needsReview?: string;
  reviewed?: string;
  expect?: string[];
};

/** `--expect category=Groceries` -> { category: "Groceries" }. */
export function parseExpect(list: string[] = []): ChangeSpec {
  const out: ChangeSpec = {};
  for (const item of list) {
    const i = item.indexOf("=");
    // Accept the flag spelling too: hide-from-reports=true means hideFromReports=true.
    const field = (i > 0 ? item.slice(0, i) : item).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as Field;
    if (i <= 0 || !FIELD_NAMES.includes(field)) {
      throw new UsageError(`--expect takes field=value, with a field from: ${FIELD_NAMES.join(", ")}. Got "${item}".`);
    }
    out[field] = item.slice(i + 1);
  }
  return out;
}

async function lookups(client: ReturnType<typeof createClient>, specs: ChangeSpec[]): Promise<Lookups> {
  const needCats = specs.some((s) => s.category !== undefined);
  const needTags = specs.some((s) => s.tags !== undefined);
  return {
    categories: needCats ? await listCategories(client) : [],
    tags: needTags ? await listTags(client) : [],
  };
}

export async function updateCommand(id: string, opts: UpdateOpts): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const set: ChangeSpec = {};
  for (const f of FIELD_NAMES) if (opts[f] !== undefined) set[f] = opts[f];
  if (Object.keys(set).length === 0) throw new UsageError("Nothing to change.", "Pass at least one of --category, --notes, --tags, …");
  const expect = parseExpect(opts.expect);
  const client = createClient(opts);
  const result = await changeTransaction(client, id, set, expect, await lookups(client, [set, expect]), Boolean(opts.dryRun));
  report(r, [result], Boolean(opts.dryRun));
}

const batchSchema = z.array(
  z.strictObject({
    id: z.string().min(1),
    set: z.partialRecord(z.enum(FIELD_NAMES as [Field, ...Field[]]), z.string()),
    expect: z.partialRecord(z.enum(FIELD_NAMES as [Field, ...Field[]]), z.string()).optional(),
  })
);

export async function batchUpdateCommand(file: string, opts: Common & { keepGoing?: boolean }): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const source = file === "-" || file.startsWith("@") ? file : `@${file}`;
  const parsed = batchSchema.safeParse(await readJsonBody({ data: source }));
  if (!parsed.success) {
    throw new UsageError(
      `The batch file is not a list of changes: ${parsed.error.issues[0]?.path.join(".") || "file"}: ${parsed.error.issues[0]?.message}.`,
      'Each item is {"id": "...", "set": {"category": "Groceries"}, "expect": {"category": "Shopping"}}.'
    );
  }
  const client = createClient(opts);
  const look = await lookups(client, parsed.data.flatMap((x) => [x.set as ChangeSpec, (x.expect ?? {}) as ChangeSpec]));
  const results: ChangeResult[] = [];
  for (const item of parsed.data) {
    let result: ChangeResult;
    try {
      result = await changeTransaction(client, item.id, item.set as ChangeSpec, (item.expect ?? {}) as ChangeSpec, look, Boolean(opts.dryRun));
    } catch (error) {
      result = { id: item.id, status: "failed", changes: [], error: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    r.note(describe(result));
    if ((result.status === "failed" || result.status === "conflict") && !opts.keepGoing) {
      r.warn(`Stopped at ${item.id} (${result.status}). ${parsed.data.length - results.length} not tried. Pass --keep-going to carry on.`);
      break;
    }
  }
  report(r, results, Boolean(opts.dryRun), parsed.data.length);
}

function describe(x: ChangeResult): string {
  const what = x.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join(", ");
  if (x.status === "conflict") {
    return `conflict  ${x.id}: ${x.conflicts!.map((c) => `${c.field} is ${JSON.stringify(c.actual)}, expected ${JSON.stringify(c.expected)}`).join("; ")}`;
  }
  if (x.status === "failed") return `FAILED    ${x.id}: ${x.error}`;
  if (x.status === "unchanged") return `unchanged ${x.id}: already holds those values`;
  return `${x.status === "verified" ? "verified " : "would set"} ${x.id}: ${what}`;
}

function report(r: Reporter, results: ChangeResult[], dryRun: boolean, planned = results.length): void {
  const count = (s: ChangeResult["status"]) => results.filter((x) => x.status === s).length;
  const failed = count("failed") + count("conflict");
  const changed = count("verified") > 0;
  const summary = dryRun
    ? `${count("would-change")} would change, ${count("unchanged")} already set, ${count("conflict")} conflicts`
    : `${count("verified")} changed and checked, ${count("unchanged")} already set, ${count("conflict")} conflicts, ${count("failed")} failed`;
  for (const x of results) if (x.status === "failed" || x.status === "conflict") r.warn(describe(x));
  const outcome: MutationOutcome<ChangeResult> = {
    ok: failed === 0,
    dryRun,
    changed: !dryRun && changed,
    summary: planned > results.length ? `${summary}; ${planned - results.length} not tried` : summary,
    counts: { total: planned, succeeded: results.length - failed, failed },
    results,
  };
  r.result(outcome, [...results.map(describe), "", (dryRun ? "[DRY RUN] " : "") + outcome.summary].join("\n"));
  if (failed > 0) process.exitCode = 1;
}

export type CreateOpts = Common & {
  account: string;
  date: string;
  amount: string;
  merchant: string;
  category: string;
  notes?: string;
  updateBalance?: boolean;
};

export async function createCommand(opts: CreateOpts): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const amount = Number(opts.amount);
  if (!/^-?\d+(\.\d{1,2})?$/.test(opts.amount.trim()) || !Number.isFinite(amount)) {
    throw new UsageError(`--amount takes a number such as -12.50, not "${opts.amount}".`);
  }
  const client = createClient({ json: opts.json, baseUrl: opts.baseUrl });
  const category = resolveCategory(await listCategories(client), opts.category);
  const input = {
    date: opts.date,
    accountId: opts.account,
    amount,
    merchantName: opts.merchant,
    categoryId: category.id,
    notes: opts.notes ?? "",
    shouldUpdateBalance: Boolean(opts.updateBalance),
  };
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would create ${opts.date} ${amount.toFixed(2)} ${opts.merchant} (${category.name})` }, true, r, { input });
    return;
  }
  const t = await createTransaction(client, input);
  printDryRun({ changed: true, summary: `Created ${t.id}: ${line(t)}` }, false, r, { transaction: t });
}

export async function deleteCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const t = await getTransaction(client, id);
  const what = line(t);
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would delete ${what}` }, true, r);
    return;
  }
  const ok = await confirmDestructive(`Delete ${what}?`, opts);
  if (!ok.confirmed) {
    r.result(abortOutcome(ok.reason, "Nothing deleted."), "Nothing deleted.");
    if (ok.reason === "needs-yes") process.exitCode = 1;
    return;
  }
  await deleteTransaction(client, id);
  // Read back: a deleted transaction is no longer found.
  const gone = await getTransaction(client, id).then(
    () => false,
    () => true
  );
  if (!gone) throw new UsageError(`Monarch said it deleted ${id}, but it still reads back.`);
  printDryRun({ changed: true, summary: `Deleted ${what}` }, false, r, { id });
}
