// Transactions: read every field Monarch offers, and write changes back safely.
//
// A safe write here means three things:
//   1. Conflict check. The caller may say what it expects a field to hold now
//      (`expect`). If Monarch holds something else (someone changed it in the app),
//      nothing is sent.
//   2. The write itself.
//   3. Read-back. Monarch often answers "Something went wrong" whether or not the
//      change worked, so a write counts only when a fresh read shows the new value.

import type { ApiClient } from "../client.js";
import { ApiError, UsageError } from "../errors.js";
import { resolveCategory, type Category } from "./categories.js";
import { payload } from "./payload.js";
import { resolveTags, splitTagList, type Tag } from "./tags.js";

/**
 * Every transaction field Monarch offers (46 in its schema; 45 here). Left out:
 * providerActivityLog, which Monarch refuses for ordinary sign-ins.
 */
export const FULL_FIELDS = `
  account { id displayName mask institution { id name } type { name } subtype { name } }
  amount
  attachments { extension filename id originalAssetUrl publicId sizeBytes thumbnailUrl }
  businessEntity { id name }
  businessEntityOverriddenAt
  category { id name icon systemCategory isSystemCategory excludeFromBudget group { id name type } }
  createdAt
  dataProviderDescription
  date
  deletedAt
  deletedByType
  externalId
  goal { id name }
  goalReconciliationRecord { id amount createdAt }
  hasSplitTransactions
  hiddenByAccount
  hideFromReports
  householdMerchant { id name createdAt merchant { id name } }
  id
  isLinkedToPaydownBudget
  isManual
  isRecurring
  isSplitTransaction
  linkedRetailTransactionId
  merchant { id name logoUrl createdAt transactionsCount ruleCount hasActiveRecurringStreams }
  needsReview
  needsReviewByUser { id name displayName }
  notes
  originalDate
  originalTransaction { id date amount notes pending category { id name } merchant { id name } account { id displayName } }
  ownedByUser { id name displayName }
  ownershipOverriddenAt
  pending
  plaidMerchantName
  plaidName
  plaidTransactionId
  reviewStatus
  reviewedAt
  reviewedByUser { id name displayName }
  savingsGoalEvent { id amount date type notes goal { id name } }
  splitTransactions { id date amount notes pending category { id name } merchant { id name } account { id displayName } }
  tags { color id name order systemTag transactionCount }
  updatedAt
  updatedByRetailSync
  updatedByRetailSyncAt
`;

/** The top-level field names in FULL_FIELDS, for the shape check on a full download. */
export const FULL_KEYS = FULL_FIELDS.trim().split("\n").map((l) => l.trim().split(/[\s{]/)[0]!);

/** What a list shows by default: enough to read and to decide a change. */
export const BRIEF_FIELDS = `
  id date amount pending notes hideFromReports needsReview reviewStatus reviewedAt isSplitTransaction plaidName
  merchant { id name } category { id name } account { id displayName } tags { id name }
`;

export type Transaction = {
  id: string;
  date: string;
  amount: number;
  pending: boolean;
  notes: string | null;
  hideFromReports: boolean;
  needsReview: boolean;
  reviewStatus: string | null;
  reviewedAt: string | null;
  merchant: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  account: { id: string; displayName: string } | null;
  tags: { id: string; name: string }[];
  [key: string]: unknown;
};

export type TransactionFilters = {
  startDate?: string;
  endDate?: string;
  accounts?: string[];
  categories?: string[];
  tags?: string[];
  search?: string;
  needsReview?: boolean;
  hideFromReports?: boolean;
  isSplit?: boolean;
  isRecurring?: boolean;
  isPending?: boolean;
  hasNotes?: boolean;
  hasAttachments?: boolean;
};

const PAGE = 250;

function listQuery(fields: string): string {
  return `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) { totalCount results(offset: $offset, limit: $limit, orderBy: $orderBy) { ${fields} } } }`;
}

export type TransactionPage = { totalCount: number; transactions: Transaction[] };

/**
 * Read transactions page by page. `limit` caps how many come back; with no limit,
 * every match is read and the count is checked against Monarch's total, so a
 * download that lost rows while paging fails instead of looking complete.
 */
export async function listTransactions(
  client: ApiClient,
  opts: { filters?: TransactionFilters; limit?: number; full?: boolean; onPage?: (got: number, total: number) => void } = {}
): Promise<TransactionPage> {
  const query = listQuery(opts.full ? FULL_FIELDS : BRIEF_FIELDS);
  const filters = Object.fromEntries(Object.entries(opts.filters ?? {}).filter(([, v]) => v !== undefined));
  const seen = new Set<string>();
  const out: Transaction[] = [];
  let total = 0;
  for (let offset = 0; ; ) {
    const want = opts.limit === undefined ? PAGE : Math.min(PAGE, opts.limit - out.length);
    if (want <= 0) break;
    const data = await client.graphql<{ allTransactions: { totalCount: number; results: Transaction[] } }>(
      "GetTransactionsList",
      query,
      { offset, limit: want, filters, orderBy: "date" }
    );
    const at = data.allTransactions;
    if (!at || typeof at.totalCount !== "number" || !Array.isArray(at.results)) {
      throw shapeError("GetTransactionsList", "allTransactions had no totalCount or results");
    }
    total = at.totalCount;
    for (const t of at.results) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
      }
    }
    offset += at.results.length;
    opts.onPage?.(out.length, total);
    if (at.results.length === 0 || offset >= total) break;
  }
  if (opts.limit === undefined && out.length !== total) {
    throw shapeError(
      "GetTransactionsList",
      `read ${out.length} distinct transactions but Monarch reports ${total}; records changed while paging, so run it again`
    );
  }
  return { totalCount: total, transactions: out };
}

export async function getTransaction(client: ApiClient, id: string, full = false): Promise<Transaction> {
  const data = await client.graphql<{ getTransaction: Transaction | null }>(
    "GetTransaction",
    `query GetTransaction($id: UUID!) { getTransaction(id: $id) { ${full ? FULL_FIELDS : BRIEF_FIELDS} } }`,
    { id }
  );
  if (!data.getTransaction) {
    throw new ApiError({ status: 404, statusText: "Not found", operation: "GraphQL GetTransaction", safeDetail: `no transaction ${id}` });
  }
  return data.getTransaction;
}

const SUMMARY = `query GetTransactionsPage($filters: TransactionFilterInput) { aggregates(filters: $filters) {
  summary { avg count max maxExpense sum sumIncome sumExpense first last } } }`;

export async function transactionsSummary(client: ApiClient, filters: TransactionFilters = {}): Promise<Record<string, unknown>> {
  const data = await client.graphql<{ aggregates: { summary: Record<string, unknown> }[] }>("GetTransactionsPage", SUMMARY, { filters });
  return data.aggregates?.[0]?.summary ?? {};
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** The fields `update` can change, each with how to read it back as a comparable string. */
export const EDITABLE = {
  category: { read: (t: Transaction) => t.category?.id ?? null },
  merchant: { read: (t: Transaction) => t.merchant?.name ?? null },
  date: { read: (t: Transaction) => t.date ?? null },
  amount: { read: (t: Transaction) => (typeof t.amount === "number" ? t.amount.toFixed(2) : null) },
  notes: { read: (t: Transaction) => (t.notes ? t.notes : null) },
  hideFromReports: { read: (t: Transaction) => String(Boolean(t.hideFromReports)) },
  needsReview: { read: (t: Transaction) => String(Boolean(t.needsReview)) },
  reviewed: { read: (t: Transaction) => String(Boolean(t.reviewedAt)) },
  tags: { read: (t: Transaction) => tagKey((t.tags ?? []).map((x) => x.name)) },
} as const;

export type Field = keyof typeof EDITABLE;
export const FIELD_NAMES = Object.keys(EDITABLE) as Field[];

/** Field values as typed by a person, before ids are looked up. */
export type ChangeSpec = Partial<Record<Field, string>>;

export type Lookups = { categories: Category[]; tags: Tag[] };

function tagKey(names: string[]): string | null {
  const sorted = [...names].map((n) => n.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return sorted.length ? sorted.join("; ") : null;
}

/** Turn a typed value into the comparable string `EDITABLE[f].read` produces. */
export function normalize(field: Field, raw: string, lookups: Lookups): string | null {
  const v = raw.trim();
  switch (field) {
    case "category":
      return resolveCategory(lookups.categories, v).id;
    case "tags":
      return tagKey(resolveTags(lookups.tags, splitTagList(v)).map((t) => t.name));
    case "notes":
      return v ? raw : null;
    case "merchant":
      if (!v) throw new UsageError("The merchant name cannot be empty.");
      return v;
    case "amount": {
      const n = Number(v);
      if (!/^-?\d+(\.\d{1,2})?$/.test(v) || !Number.isFinite(n)) {
        throw new UsageError(`amount takes a number such as -12.50, not "${raw}".`);
      }
      return n.toFixed(2);
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`date takes YYYY-MM-DD, not "${raw}".`);
      return v;
    case "hideFromReports":
    case "needsReview":
    case "reviewed":
      if (v !== "true" && v !== "false") throw new UsageError(`${field} takes true or false, not "${raw}".`);
      return v;
  }
}

export type FieldChange = { field: Field; from: string | null; to: string | null };

export type ChangeResult = {
  id: string;
  status: "verified" | "would-change" | "unchanged" | "conflict" | "failed";
  changes: FieldChange[];
  conflicts?: { field: Field; expected: string | null; actual: string | null }[];
  error?: string;
};

const UPDATE = `mutation Web_TransactionDrawerUpdateTransaction($input: UpdateTransactionMutationInput!) {
  updateTransaction(input: $input) { transaction { id } errors { message code fieldErrors { field messages } } } }`;
const SET_TAGS = `mutation Web_SetTransactionTags($input: SetTransactionTagsInput!) {
  setTransactionTags(input: $input) { transaction { id } errors { message code fieldErrors { field messages } } } }`;

/**
 * Change one transaction safely: check `expect`, send what differs, read it back.
 * With `dryRun`, it reads and compares, and sends nothing.
 */
export async function changeTransaction(
  client: ApiClient,
  id: string,
  set: ChangeSpec,
  expect: ChangeSpec,
  lookups: Lookups,
  dryRun: boolean
): Promise<ChangeResult> {
  const wanted = new Map<Field, string | null>();
  for (const [f, raw] of Object.entries(set) as [Field, string][]) wanted.set(f, normalize(f, raw, lookups));
  const expected = new Map<Field, string | null>();
  for (const [f, raw] of Object.entries(expect) as [Field, string][]) {
    expected.set(f, raw === "" ? null : normalize(f, raw, lookups));
  }

  const before = await getTransaction(client, id);
  const conflicts = [...expected].flatMap(([field, exp]) => {
    const actual = EDITABLE[field].read(before);
    return actual === exp ? [] : [{ field, expected: exp, actual }];
  });
  const changes: FieldChange[] = [...wanted]
    .map(([field, to]) => ({ field, from: EDITABLE[field].read(before), to }))
    .filter((c) => c.from !== c.to);

  if (conflicts.length) return { id, status: "conflict", changes, conflicts };
  if (changes.length === 0) return { id, status: "unchanged", changes };
  if (dryRun) return { id, status: "would-change", changes };

  const input: Record<string, unknown> = { id };
  for (const { field, to } of changes) {
    if (field === "category") input.category = to;
    else if (field === "merchant") input.name = to;
    else if (field === "date") input.date = to;
    else if (field === "amount") input.amount = Number(to);
    else if (field === "notes") input.notes = to ?? "";
    else if (field === "hideFromReports") input.hideFromReports = to === "true";
    else if (field === "needsReview") input.needsReview = to === "true";
    else if (field === "reviewed") input.reviewed = to === "true";
  }
  if (Object.keys(input).length > 1) {
    payload(await client.graphql("Web_TransactionDrawerUpdateTransaction", UPDATE, { input }), "updateTransaction", "updateTransaction");
  }
  const tagChange = changes.find((c) => c.field === "tags");
  if (tagChange) {
    const tagIds = tagChange.to ? resolveTags(lookups.tags, splitTagList(tagChange.to)).map((t) => t.id) : [];
    payload(
      await client.graphql("Web_SetTransactionTags", SET_TAGS, { input: { transactionId: id, tagIds } }),
      "setTransactionTags",
      "setTransactionTags"
    );
  }

  const after = await getTransaction(client, id);
  const wrong = changes.filter((c) => EDITABLE[c.field].read(after) !== c.to);
  if (wrong.length) {
    return {
      id,
      status: "failed",
      changes,
      error: `Sent, but Monarch reads back ${wrong
        .map((c) => `${c.field}=${JSON.stringify(EDITABLE[c.field].read(after))}`)
        .join(", ")}`,
    };
  }
  return { id, status: "verified", changes };
}

const CREATE = `mutation Common_CreateTransactionMutation($input: CreateTransactionMutationInput!) {
  createTransaction(input: $input) { transaction { id } errors { message code fieldErrors { field messages } } } }`;
const DELETE = `mutation Common_DeleteTransactionMutation($input: DeleteTransactionMutationInput!) {
  deleteTransaction(input: $input) { deleted errors { message code fieldErrors { field messages } } } }`;

export async function createTransaction(
  client: ApiClient,
  input: { date: string; accountId: string; amount: number; merchantName: string; categoryId: string; notes: string; shouldUpdateBalance: boolean }
): Promise<Transaction> {
  const result = payload<{ transaction: { id: string } }>(
    await client.graphql("Common_CreateTransactionMutation", CREATE, { input }),
    "createTransaction",
    "createTransaction"
  );
  return await getTransaction(client, result.transaction.id);
}

export async function deleteTransaction(client: ApiClient, id: string): Promise<boolean> {
  const result = payload<{ deleted: boolean }>(
    await client.graphql("Common_DeleteTransactionMutation", DELETE, { input: { transactionId: id } }),
    "deleteTransaction",
    "deleteTransaction"
  );
  return Boolean(result.deleted);
}

function shapeError(operation: string, detail: string): ApiError {
  return new ApiError({ status: 502, statusText: "Unexpected reply", operation: `GraphQL ${operation}`, safeDetail: detail });
}
