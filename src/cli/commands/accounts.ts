// `monarch accounts …`: balances, history, bank connection health, bank refresh,
// and manual accounts. Every change is read back before it reports success.

import { UsageError } from "../../errors.js";
import {
  accountHistory,
  accountTypes,
  aggregateSnapshots,
  createManualAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  recentBalances,
  refreshAccounts,
  snapshotsByType,
  syncInProgress,
  updateAccount,
  type Account,
  type AccountChange,
  type AccountDetail,
} from "../../monarch/accounts.js";
import { createClient } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun, type GuardOptions, type MutationOutcome } from "../guardrails.js";
import { reporter } from "../output.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

const DAY = 86_400_000;

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n: number): string {
  return isoDate(new Date(Date.now() - n * DAY));
}

function money(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
}

// ── Connection state ─────────────────────────────────────────────────────────

export type ConnectionState = "manual" | "needs bank sign-in" | "disconnected" | "syncing" | "stale" | "ok";

export type AccountHealth = {
  id: string;
  name: string;
  institution: string | null;
  state: ConnectionState;
  lastUpdated: string | null;
  daysSinceUpdate: number | null;
  syncInProgress: boolean;
  updateRequired: boolean;
  disconnectedAt: string | null;
  institutionStatus: string | null;
  syncDisabled: boolean;
};

/** Why an account's data may be old, worst reason first. */
export function health(a: Account, syncing: boolean, staleDays: number, now = Date.now()): AccountHealth {
  const last = a.displayLastUpdatedAt ?? a.updatedAt ?? null;
  const days = last ? Math.floor((now - Date.parse(last)) / DAY) : null;
  const c = a.credential ?? null;
  let state: ConnectionState;
  if (a.isManual || !c) state = "manual";
  else if (c.updateRequired) state = "needs bank sign-in";
  else if (c.disconnectedFromDataProviderAt) state = "disconnected";
  else if (syncing) state = "syncing";
  else if (days !== null && days > staleDays) state = "stale";
  else state = "ok";
  return {
    id: a.id,
    name: a.displayName,
    institution: a.institution?.name ?? c?.institution?.name ?? null,
    state,
    lastUpdated: last,
    daysSinceUpdate: days,
    syncInProgress: syncing,
    updateRequired: Boolean(c?.updateRequired),
    disconnectedAt: c?.disconnectedFromDataProviderAt ?? null,
    institutionStatus: c?.institution?.status ?? null,
    syncDisabled: Boolean(a.syncDisabled),
  };
}

const ORDER: ConnectionState[] = ["needs bank sign-in", "disconnected", "stale", "syncing", "ok", "manual"];

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listCommand(opts: Common & { includeHidden?: boolean }): Promise<void> {
  const r = reporter(opts);
  const accounts = (await listAccounts(createClient(opts))).filter((a) => opts.includeHidden || !a.isHidden);
  const rows = accounts.map((a) => ({ ...a, connection: health(a, false, 3).state }));
  r.result(
    rows,
    rows.length === 0
      ? "No accounts."
      : rows
          .map(
            (a) =>
              `${a.displayName.padEnd(34).slice(0, 34)}  ${(a.type?.display ?? "").padEnd(16).slice(0, 16)}  ${money(a.displayBalance ?? a.currentBalance).padStart(14)}  ${(a.institution?.name ?? "").padEnd(22).slice(0, 22)}  ${(a.displayLastUpdatedAt ?? "").slice(0, 10)}  ${a.connection}  ${a.id}`
          )
          .join("\n")
  );
}

export async function getCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  const a = await getAccount(createClient(opts), id);
  if (!a) throw new UsageError(`There is no account ${id}.`, "`monarch accounts list` shows the ids.");
  r.result(a);
}

export async function typesCommand(opts: Common): Promise<void> {
  const r = reporter(opts);
  const options = await accountTypes(createClient(opts));
  r.result(
    options,
    options
      .map((o) => `${o.type.name.padEnd(18)} ${o.type.display.padEnd(22)} subtypes: ${o.type.possibleSubtypes.map((s) => s.name).join(", ")}`)
      .join("\n")
  );
}

export async function historyCommand(id: string, opts: Common & { start?: string; end?: string }): Promise<void> {
  const r = reporter(opts);
  const h = await accountHistory(createClient(opts), id);
  if (!h.account) throw new UsageError(`There is no account ${id}.`, "`monarch accounts list` shows the ids.");
  const snapshots = h.snapshots.filter((s) => (!opts.start || s.date >= opts.start) && (!opts.end || s.date <= opts.end));
  r.result(
    { account: h.account, count: snapshots.length, snapshots },
    snapshots.length === 0
      ? `No balances recorded for ${h.account.displayName} in that range.`
      : [`${h.account.displayName}`, ...snapshots.map((s) => `${s.date}  ${money(s.signedBalance).padStart(14)}`)].join("\n")
  );
}

export async function balancesCommand(opts: Common & { start?: string }): Promise<void> {
  const r = reporter(opts);
  const start = opts.start ?? daysAgo(30);
  const rows = await recentBalances(createClient(opts), start);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const out = rows.map((a) => ({
    id: a.id,
    name: a.displayName,
    balances: a.recentBalances.map((balance, i) => ({ date: new Date(startMs + i * DAY).toISOString().slice(0, 10), balance })),
  }));
  r.result(
    { start, accounts: out },
    out
      .map((a) => {
        const last = a.balances.at(-1);
        return `${a.name.padEnd(34).slice(0, 34)}  ${a.balances[0]?.date ?? ""} ${money(a.balances[0]?.balance).padStart(14)}  ->  ${last?.date ?? ""} ${money(last?.balance).padStart(14)}`;
      })
      .join("\n")
  );
}

export async function snapshotsCommand(opts: Common & { start?: string; timeframe?: string }): Promise<void> {
  const r = reporter(opts);
  const timeframe = opts.timeframe ?? "month";
  if (timeframe !== "month" && timeframe !== "year") throw new UsageError(`--timeframe takes month or year, not "${timeframe}".`);
  const start = opts.start ?? `${new Date().getFullYear()}-01-01`;
  const data = await snapshotsByType(createClient(opts), start, timeframe);
  r.result(
    { start, timeframe, ...data },
    data.snapshotsByAccountType.length === 0
      ? "No balances in that range."
      : data.snapshotsByAccountType.map((s) => `${s.month}  ${s.accountType.padEnd(16)} ${money(s.balance).padStart(16)}`).join("\n")
  );
}

export async function netWorthCommand(opts: Common & { start?: string; end?: string; type?: string }): Promise<void> {
  const r = reporter(opts);
  const start = opts.start ?? daysAgo(365);
  const rows = await aggregateSnapshots(createClient(opts), { startDate: start, endDate: opts.end, accountType: opts.type });
  r.result(
    { start, end: opts.end ?? null, accountType: opts.type ?? null, count: rows.length, snapshots: rows },
    rows.length === 0 ? "No balances in that range." : rows.map((s) => `${s.date}  ${money(s.balance).padStart(16)}`).join("\n")
  );
}

export async function refreshStatusCommand(opts: Common & { staleDays?: number }): Promise<void> {
  const r = reporter(opts);
  const client = createClient(opts);
  const [accounts, syncing] = [await listAccounts(client), await syncInProgress(client)];
  const rows = accounts
    .filter((a) => !a.isHidden || a.credential)
    .map((a) => health(a, syncing.get(a.id) ?? false, opts.staleDays ?? 3))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.daysSinceUpdate ?? 0) - (a.daysSinceUpdate ?? 0));
  const problems = rows.filter((x) => x.state === "needs bank sign-in" || x.state === "disconnected" || x.state === "stale");
  r.result(
    { problems: problems.length, accounts: rows },
    [
      ...rows.map(
        (x) =>
          `${x.state.padEnd(18)}  ${x.name.padEnd(34).slice(0, 34)}  ${(x.institution ?? "").padEnd(24).slice(0, 24)}  ${x.lastUpdated ? `${x.lastUpdated.slice(0, 10)} (${x.daysSinceUpdate}d ago)` : "never updated"}${x.institutionStatus && x.institutionStatus !== "HEALTHY" ? `  bank status ${x.institutionStatus}` : ""}`
      ),
      "",
      problems.length
        ? `${problems.length} accounts need attention. "needs bank sign-in" means sign in to that bank again in the Monarch app.`
        : "Every linked account is up to date.",
    ].join("\n")
  );
}

// ── Bank refresh ─────────────────────────────────────────────────────────────

export async function refreshCommand(
  ids: string[],
  opts: Common & { wait?: boolean; timeout?: number; interval?: number }
): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const accounts = await listAccounts(client);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new UsageError(`No account ${unknown.join(", ")}.`, "`monarch accounts list` shows the ids.");
  const targets = ids.length ? ids : accounts.filter((a) => a.credential && !a.isManual).map((a) => a.id);
  const names = targets.map((id) => byId.get(id)?.displayName ?? id);
  if (targets.length === 0) {
    printDryRun({ changed: false, summary: "No linked accounts to refresh" }, Boolean(opts.dryRun), r);
    return;
  }
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would ask Monarch to refresh ${targets.length} accounts: ${names.join(", ")}` }, true, r, { accountIds: targets });
    return;
  }
  const accepted = await refreshAccounts(client, targets);
  if (!accepted) throw new UsageError("Monarch did not accept the refresh request.", "Try again in a few minutes, or refresh in the Monarch app.");

  let pending = targets;
  let waited = false;
  if (opts.wait) {
    waited = true;
    const deadline = Date.now() + (opts.timeout ?? 300) * 1000;
    const interval = (opts.interval ?? 5) * 1000;
    for (;;) {
      await new Promise((res) => setTimeout(res, interval));
      const syncing = await syncInProgress(client);
      pending = targets.filter((id) => syncing.get(id));
      r.note(`${targets.length - pending.length} of ${targets.length} finished…`);
      if (pending.length === 0 || Date.now() >= deadline) break;
    }
  }
  const results = targets.map((id) => ({ id, name: byId.get(id)?.displayName ?? id, stillSyncing: waited ? pending.includes(id) : null }));
  const summary = !waited
    ? `Asked Monarch to refresh ${targets.length} accounts. Run \`monarch accounts refresh-status\` in a few minutes to see the result.`
    : pending.length
      ? `Asked Monarch to refresh ${targets.length} accounts; ${pending.length} were still updating when the wait ended`
      : `Refreshed ${targets.length} accounts`;
  const outcome: MutationOutcome<(typeof results)[number]> = {
    ok: pending.length === 0 || !waited,
    dryRun: false,
    changed: true,
    summary,
    counts: { total: targets.length, succeeded: targets.length - (waited ? pending.length : 0), failed: waited ? pending.length : 0 },
    results,
  };
  r.result(outcome, summary);
  if (waited && pending.length) process.exitCode = 1;
}

// ── Manual accounts ──────────────────────────────────────────────────────────

function parseAmount(option: string, raw: string): number {
  const v = raw.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) throw new UsageError(`${option} takes a number such as 1250.00, not "${raw}".`);
  return Number(v);
}

function parseBool(option: string, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new UsageError(`${option} takes true or false, not "${raw}".`);
}

export type CreateOpts = Common & { type: string; subtype: string; name: string; balance?: string; excludeFromNetWorth?: boolean };

export async function createCommand(opts: CreateOpts): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const input = {
    type: opts.type,
    subtype: opts.subtype,
    name: opts.name,
    displayBalance: opts.balance === undefined ? 0 : parseAmount("--balance", opts.balance),
    includeInNetWorth: !opts.excludeFromNetWorth,
  };
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would create manual account "${input.name}" (${input.type}/${input.subtype}, balance ${money(input.displayBalance)})` }, true, r, { input });
    return;
  }
  const client = createClient(opts);
  const id = await createManualAccount(client, input);
  const created = await getAccount(client, id);
  if (!created || created.displayName !== input.name) {
    throw new UsageError(`Monarch answered with account ${id}, but it does not read back as "${input.name}".`, `Check it with \`monarch accounts get ${id}\`.`);
  }
  printDryRun({ changed: true, summary: `Created manual account "${created.displayName}" (${id})` }, false, r, { account: created });
}

export type UpdateOpts = Common & {
  name?: string;
  balance?: string;
  type?: string;
  subtype?: string;
  inNetWorth?: string;
  hide?: string;
  hideTransactions?: string;
};

/** Each change, with how to read the same value back from the account. */
const READ: Record<keyof AccountChange, (a: AccountDetail) => unknown> = {
  name: (a) => a.displayName,
  displayBalance: (a) => a.displayBalance,
  type: (a) => a.type?.name,
  subtype: (a) => a.subtype?.name,
  includeInNetWorth: (a) => a.includeInNetWorth,
  hideFromList: (a) => a.hideFromList,
  hideTransactionsFromReports: (a) => a.hideTransactionsFromReports,
};

export async function updateCommand(id: string, opts: UpdateOpts): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const wanted: AccountChange = {};
  if (opts.name !== undefined) wanted.name = opts.name;
  if (opts.balance !== undefined) wanted.displayBalance = parseAmount("--balance", opts.balance);
  if (opts.type !== undefined) wanted.type = opts.type;
  if (opts.subtype !== undefined) wanted.subtype = opts.subtype;
  if (opts.inNetWorth !== undefined) wanted.includeInNetWorth = parseBool("--in-net-worth", opts.inNetWorth);
  if (opts.hide !== undefined) wanted.hideFromList = parseBool("--hide", opts.hide);
  if (opts.hideTransactions !== undefined) wanted.hideTransactionsFromReports = parseBool("--hide-transactions", opts.hideTransactions);
  if (Object.keys(wanted).length === 0) throw new UsageError("Nothing to change.", "Pass at least one of --name, --balance, --hide, …");

  const client = createClient(opts);
  const before = await getAccount(client, id);
  if (!before) throw new UsageError(`There is no account ${id}.`, "`monarch accounts list` shows the ids.");
  const changes = (Object.entries(wanted) as [keyof AccountChange, unknown][])
    .map(([field, to]) => ({ field, from: READ[field](before), to }))
    .filter((c) => c.from !== c.to);
  const describe = changes.map((c) => `${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join(", ");
  if (changes.length === 0) {
    printDryRun({ changed: false, summary: `${before.displayName} already holds those values` }, Boolean(opts.dryRun), r, { id, changes });
    return;
  }
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would change ${before.displayName}: ${describe}` }, true, r, { id, changes });
    return;
  }
  await updateAccount(client, id, Object.fromEntries(changes.map((c) => [c.field, c.to])) as AccountChange);
  const after = await getAccount(client, id);
  const wrong = changes.filter((c) => !after || READ[c.field](after) !== c.to);
  if (wrong.length) {
    const got = wrong.map((c) => `${c.field}=${JSON.stringify(after ? READ[c.field](after) : null)}`).join(", ");
    const outcome: MutationOutcome = { ok: false, dryRun: false, changed: false, summary: `Sent, but Monarch reads back ${got}`, results: changes };
    r.warn(outcome.summary);
    r.result(outcome, outcome.summary);
    process.exitCode = 1;
    return;
  }
  printDryRun({ changed: true, summary: `Changed ${before.displayName} and checked it: ${describe}` }, false, r, { id, changes });
}

export async function deleteCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const a = await getAccount(client, id);
  if (!a || a.deletedAt) throw new UsageError(`There is no account ${id}${a?.deletedAt ? " (it was deleted)" : ""}.`, "`monarch accounts list` shows the ids.");
  const what = `${a.displayName} (${a.isManual ? "manual" : "linked"}, ${a.transactionsCount ?? 0} transactions)`;
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would delete ${what} and its transactions` }, true, r);
    return;
  }
  const ok = await confirmDestructive(`Delete ${what} and all its transactions?`, opts);
  if (!ok.confirmed) {
    r.result(abortOutcome(ok.reason, "Nothing deleted."), "Nothing deleted.");
    if (ok.reason === "needs-yes") process.exitCode = 1;
    return;
  }
  await deleteAccount(client, id);
  // Read back. Monarch still answers for a deleted account by id, with deletedAt set.
  const still = await getAccount(client, id);
  if (still && !still.deletedAt) throw new UsageError(`Monarch said it deleted ${id}, but it still reads back as not deleted.`);
  printDryRun({ changed: true, summary: `Deleted ${what}` }, false, r, { id });
}
