// `monarch cashflow …`: income, spending and savings over a date range.

import { UsageError } from "../../errors.js";
import { cashflowDetail, cashflowSummary, type CashflowSummary } from "../../monarch/cashflow.js";
import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";

type Opts = { json?: boolean; baseUrl?: string; start?: string; end?: string; limit?: number };

/** Default range: the first of this month to today. */
export function range(opts: Opts, now = new Date()): { startDate: string; endDate: string } {
  if (Boolean(opts.start) !== Boolean(opts.end)) throw new UsageError("Give both --start and --end, or neither.");
  if (opts.start && opts.end) {
    if (opts.end < opts.start) throw new UsageError("--end is before --start.");
    return { startDate: opts.start, endDate: opts.end };
  }
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  return { startDate: `${ymd}-01`, endDate: `${ymd}-${p(now.getDate())}` };
}

function summaryLines(s: CashflowSummary): string[] {
  return [
    `Income    ${s.sumIncome.toFixed(2).padStart(12)}`,
    `Spending  ${s.sumExpense.toFixed(2).padStart(12)}`,
    `Savings   ${s.savings.toFixed(2).padStart(12)}  (${(s.savingsRate * 100).toFixed(1)}% of income)`,
  ];
}

export async function summaryCommand(opts: Opts): Promise<void> {
  const r = reporter(opts);
  const f = range(opts);
  const s = await cashflowSummary(createClient(opts), f);
  r.result({ ...f, ...s }, [`${f.startDate} to ${f.endDate}`, ...summaryLines(s)].join("\n"));
}

export async function detailCommand(opts: Opts): Promise<void> {
  const r = reporter(opts);
  const f = range(opts);
  const d = await cashflowDetail(createClient(opts), f);
  const n = opts.limit ?? 15;
  const row = (name: string, v: number) => `  ${name.padEnd(34).slice(0, 34)} ${v.toFixed(2).padStart(12)}`;
  r.result(
    { ...f, ...d },
    [
      `${f.startDate} to ${f.endDate}`,
      ...summaryLines(d.summary),
      "",
      "By group:",
      ...d.byGroup.slice(0, n).map((x) => row(x.name, x.sum)),
      "",
      "By category:",
      ...d.byCategory.slice(0, n).map((x) => row(x.name, x.sum)),
      "",
      "Biggest spending by merchant:",
      ...d.byMerchant.slice(0, n).map((x) => row(x.name, x.expense)),
    ].join("\n")
  );
}
