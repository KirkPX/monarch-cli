// `monarch budgets …`: planned versus actual per category and month, and setting
// one planned amount. A change is read back before it is reported.

import { UsageError } from "../../errors.js";
import { getBudgets, parseMonth, plannedAmount, setBudget, type BudgetRow } from "../../monarch/budgets.js";
import { listCategories, listCategoryGroups, resolveCategory, resolveGroup } from "../../monarch/categories.js";
import { createClient } from "../client-helpers.js";
import { assertWritable, printDryRun, type GuardOptions } from "../guardrails.js";
import { reporter } from "../output.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

export function thisMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const money = (n: number | null) => (n === null || n === undefined ? "" : n.toFixed(2)).padStart(11);

export async function listCommand(opts: Common & { start?: string; end?: string; all?: boolean }): Promise<void> {
  const r = reporter(opts);
  const start = parseMonth(opts.start ?? thisMonth());
  const end = parseMonth(opts.end ?? start);
  if (end < start) throw new UsageError("--end is before --start.");
  const b = await getBudgets(createClient(opts), start, end);
  // By default show only rows with a plan or some spending; --all shows every category.
  const rows = opts.all ? b.rows : b.rows.filter((x) => x.planned || x.actual);
  const header = `${"month".padEnd(8)} ${"group".padEnd(22)} ${"category".padEnd(26)} ${"planned".padStart(11)} ${"actual".padStart(11)} ${"remaining".padStart(11)}`;
  const lines = rows.map(
    (x: BudgetRow) =>
      `${x.month.padEnd(8)} ${x.group.padEnd(22).slice(0, 22)} ${(x.kind === "group" ? `(${x.name} total)` : x.name).padEnd(26).slice(0, 26)} ${money(x.planned)} ${money(x.actual)} ${money(x.remaining)}`
  );
  const totals = b.totals.map(
    (t) => `${t.month}  income planned ${money(t.income.plannedAmount)} actual ${money(t.income.actualAmount)}   spending planned ${money(t.expenses.plannedAmount)} actual ${money(t.expenses.actualAmount)}`
  );
  r.result({ ...b, rows }, [header, ...lines, "", ...totals].join("\n"));
}

export async function setCommand(
  opts: Common & { category?: string; group?: string; month?: string; amount: string; applyToFuture?: boolean }
): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  if (Boolean(opts.category) === Boolean(opts.group)) throw new UsageError("Give --category or --group, not both and not neither.");
  const amount = Number(opts.amount);
  if (!/^-?\d+(\.\d{1,2})?$/.test(opts.amount.trim()) || !Number.isFinite(amount)) {
    throw new UsageError(`--amount takes a number such as 250 or 99.50, not "${opts.amount}".`);
  }
  const month = parseMonth(opts.month ?? thisMonth());
  const client = createClient(opts);
  const target = opts.category
    ? { kind: "category" as const, ...pick(resolveCategory(await listCategories(client), opts.category)) }
    : { kind: "group" as const, ...pick(resolveGroup(await listCategoryGroups(client), opts.group!)) };

  const before = await plannedAmount(client, target.kind, target.id, month);
  const label = `${target.kind} "${target.name}" for ${month}${opts.applyToFuture ? " and every later month" : ""}`;
  if ((before ?? 0) === amount && !opts.applyToFuture) {
    printDryRun({ changed: false, summary: `The plan for ${label} is already ${amount.toFixed(2)}` }, Boolean(opts.dryRun), r, { before, after: before });
    return;
  }
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would set the plan for ${label}: ${fmt(before)} -> ${amount.toFixed(2)}` }, true, r, { before });
    return;
  }
  await setBudget(client, target.kind === "category" ? { categoryId: target.id } : { categoryGroupId: target.id }, month, amount, Boolean(opts.applyToFuture));
  const after = await plannedAmount(client, target.kind, target.id, month);
  if ((after ?? 0) !== amount) {
    throw new UsageError(`Sent, but Monarch reads back ${fmt(after)} for ${label}, not ${amount.toFixed(2)}.`);
  }
  printDryRun({ changed: true, summary: `Set the plan for ${label}: ${fmt(before)} -> ${amount.toFixed(2)} (checked)` }, false, r, { before, after });
}

function pick(x: { id: string; name: string }) {
  return { id: x.id, name: x.name };
}

function fmt(n: number | null): string {
  return n === null ? "none" : n.toFixed(2);
}
