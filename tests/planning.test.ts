// Budgets, cash flow and recurring items, driven through the built CLI against a fake Monarch.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { monthRange } from "../src/monarch/budgets.js";
import { startStub, type Stub, type StubCall } from "./stub.js";

const dist = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dist, "--json", ...args], {
      env: {
        ...process.env,
        MONARCH_API_KEY: "test-token",
        MONARCH_BASE_URL: stub!.url,
        MONARCH_CLI_CONFIG_FILE: path.join(mkdtempSync(path.join(tmpdir(), "monarch plan ü ")), "config.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const amounts = (month: string, planned: number | null, actual: number | null) => ({
  month: `${month}-01`,
  plannedCashFlowAmount: planned,
  actualAmount: actual,
  remainingAmount: planned === null || actual === null ? null : planned - actual,
  previousMonthRolloverAmount: null,
  rolloverType: null,
});

/** A fake Monarch with two categories and one group budgeted as a whole. */
async function fake(opts: { ignoreSet?: boolean } = {}) {
  const planned: Record<string, number> = { c1: 100, c2: 0, g2: 500 };
  stub = await startStub((call: StubCall) => {
    const op = call.operationName;
    const v = (call.variables ?? {}) as Record<string, unknown>;
    const data = (d: unknown) => ({ body: { data: d } });
    if (op === "GetCategories") {
      return data({
        categories: [
          { id: "c1", name: "Groceries", isSystemCategory: false, group: { id: "g1", name: "Food", type: "expense" } },
          { id: "c2", name: "Coffee", isSystemCategory: false, group: { id: "g1", name: "Food", type: "expense" } },
        ],
      });
    }
    if (op === "ManageGetCategoryGroups") {
      return data({ categoryGroups: [{ id: "g1", name: "Food", order: 1, type: "expense" }, { id: "g2", name: "Home", order: 2, type: "expense" }] });
    }
    if (op === "GetJointPlanningData") {
      const month = String(v.startDate).slice(0, 7);
      return data({
        budgetData: {
          monthlyAmountsByCategory: [
            { category: { id: "c1" }, monthlyAmounts: [amounts(month, planned.c1!, 80)] },
            { category: { id: "c2" }, monthlyAmounts: [amounts(month, planned.c2!, 0)] },
          ],
          monthlyAmountsByCategoryGroup: [
            { categoryGroup: { id: "g1" }, monthlyAmounts: [amounts(month, 100, 80)] },
            { categoryGroup: { id: "g2" }, monthlyAmounts: [amounts(month, planned.g2!, 450)] },
          ],
          totalsByMonth: [
            { month: `${month}-01`, totalIncome: { plannedAmount: 1000, actualAmount: 900, remainingAmount: 100 }, totalExpenses: { plannedAmount: 600, actualAmount: 530, remainingAmount: 70 } },
          ],
        },
        categoryGroups: [
          { id: "g1", name: "Food", type: "expense", groupLevelBudgetingEnabled: false, categories: [{ id: "c1", name: "Groceries" }, { id: "c2", name: "Coffee" }] },
          { id: "g2", name: "Home", type: "expense", groupLevelBudgetingEnabled: true, categories: [] },
        ],
      });
    }
    if (op === "Common_UpdateBudgetItem") {
      const input = v.input as { categoryId: string | null; categoryGroupId: string | null; amount: number };
      if (!opts.ignoreSet) planned[(input.categoryId ?? input.categoryGroupId)!] = input.amount;
      return data({ updateOrCreateBudgetItem: { budgetItem: { id: "b1", budgetAmount: input.amount } } });
    }
    if (op === "Web_GetCashFlowPage") {
      const summary = [{ summary: { sumIncome: 1000, sumExpense: -600, savings: 400, savingsRate: 0.4 } }];
      if (!call.body.query || !String(call.body.query).includes("byCategory")) return data({ summary });
      return data({
        summary,
        byCategory: [
          { groupBy: { category: { id: "c2", name: "Coffee", group: { id: "g1", name: "Food", type: "expense" } } }, summary: { sum: -50 } },
          { groupBy: { category: { id: "c1", name: "Groceries", group: { id: "g1", name: "Food", type: "expense" } } }, summary: { sum: -550 } },
        ],
        byCategoryGroup: [{ groupBy: { categoryGroup: { id: "g1", name: "Food", type: "expense" } }, summary: { sum: -600 } }],
        byMerchant: [
          { groupBy: { merchant: { id: "m1", name: "Cafe" } }, summary: { sumIncome: 0, sumExpense: -50 } },
          { groupBy: { merchant: { id: "m2", name: "Market" } }, summary: { sumIncome: 0, sumExpense: -550 } },
        ],
      });
    }
    if (op === "Web_GetUpcomingRecurringTransactionItems") {
      return data({
        recurringTransactionItems: [
          { date: "2026-11-20", isPast: false, transactionId: null, amount: -15, amountDiff: null, stream: { id: "s2", frequency: "monthly", amount: -15, isApproximate: false, merchant: { id: "m3", name: "Music" } }, category: null, account: null },
          { date: "2026-11-02", isPast: true, transactionId: "t1", amount: -9, amountDiff: 0, stream: { id: "s1", frequency: "monthly", amount: -9, isApproximate: false, merchant: { id: "m4", name: "Video" } }, category: null, account: null },
        ],
      });
    }
    if (op === "Common_GetRecurringStreams") {
      return data({
        recurringTransactionStreams: [
          { stream: { id: "s1", reviewStatus: null, frequency: "monthly", amount: -9, baseDate: null, dayOfTheMonth: 2, isApproximate: false, isActive: true, name: "Video", recurringType: "expense", merchant: { id: "m4", name: "Video" } }, nextForecastedTransaction: { date: "2026-12-02", amount: -9 }, category: null, account: null },
        ],
      });
    }
    return { body: { errors: [{ message: `no answer for ${op}` }] } };
  });
  return stub;
}

const sets = (s: Stub) => s.calls.filter((c) => c.operationName === "Common_UpdateBudgetItem");

describe("budgets", () => {
  it("lists rows with names, skips empty ones, and shows a group only when budgeted as a whole", async () => {
    await fake();
    const { code, stdout } = await run(["budgets", "list", "--start", "2026-11"]);
    expect(code).toBe(0);
    const d = JSON.parse(stdout);
    expect(d.rows.map((r: { name: string; kind: string }) => `${r.kind}:${r.name}`).sort()).toEqual(["category:Groceries", "group:Home"]);
    expect(d.totals[0]).toMatchObject({ month: "2026-11", income: { plannedAmount: 1000 } });
    const all = JSON.parse((await run(["budgets", "list", "--start", "2026-11", "--all"])).stdout);
    expect(all.rows).toHaveLength(3);
  });

  it("refuses a bad month and a range that runs backwards", async () => {
    await fake();
    expect(JSON.parse((await run(["budgets", "list", "--start", "2026-13"])).stderr).message).toContain("YYYY-MM");
    expect(JSON.parse((await run(["budgets", "list", "--start", "2026-11", "--end", "2026-10"])).stderr).message).toContain("before");
  });

  it("sets one month for a category, sends the first of the month, and reads it back", async () => {
    const s = await fake();
    const { code, stdout } = await run(["budgets", "set", "--category", "groceries", "--month", "2026-11", "--amount", "120"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ changed: true, before: 100, after: 120 });
    expect(sets(s)[0]!.variables).toEqual({
      input: { startDate: "2026-11-01", timeframe: "month", categoryId: "c1", categoryGroupId: null, amount: 120, applyToFuture: false },
    });
  });

  it("sets a group budget", async () => {
    const s = await fake();
    const { code } = await run(["budgets", "set", "--group", "Home", "--month", "2026-11", "--amount", "450"]);
    expect(code).toBe(0);
    expect(sets(s)[0]!.variables).toMatchObject({ input: { categoryId: null, categoryGroupId: "g2", amount: 450 } });
  });

  it("sends nothing on a dry run, when the amount is already set, or under read-only", async () => {
    const s = await fake();
    expect(JSON.parse((await run(["budgets", "set", "--category", "c1", "--amount", "120", "--month", "2026-11", "--dry-run"])).stdout)).toMatchObject({ dryRun: true });
    expect(JSON.parse((await run(["budgets", "set", "--category", "c1", "--amount", "100", "--month", "2026-11"])).stdout)).toMatchObject({ changed: false });
    expect((await run(["--read-only", "budgets", "set", "--category", "c1", "--amount", "1"])).code).toBe(1);
    expect(sets(s)).toHaveLength(0);
  });

  it("fails when the new amount does not read back", async () => {
    await fake({ ignoreSet: true });
    const { code, stderr } = await run(["budgets", "set", "--category", "c1", "--month", "2026-11", "--amount", "120"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toContain("reads back 100.00");
  });

  it("refuses both or neither of --category and --group, and a bad amount", async () => {
    await fake();
    expect(JSON.parse((await run(["budgets", "set", "--amount", "1"])).stderr).message).toContain("--category or --group");
    expect(JSON.parse((await run(["budgets", "set", "--category", "c1", "--group", "g2", "--amount", "1"])).stderr).message).toContain("not both");
    expect(JSON.parse((await run(["budgets", "set", "--category", "c1", "--amount", "lots"])).stderr).message).toContain("--amount");
  });

  it("works out a month's last day, leap years included", () => {
    expect(monthRange("2028-02", "2028-02")).toEqual({ startDate: "2028-02-01", endDate: "2028-02-29" });
    expect(monthRange("2026-09", "2026-12")).toEqual({ startDate: "2026-09-01", endDate: "2026-12-31" });
  });
});

describe("cashflow", () => {
  it("summarises a range and sends it as filters", async () => {
    const s = await fake();
    const { code, stdout } = await run(["cashflow", "summary", "--start", "2026-10-01", "--end", "2026-10-31"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-31", savings: 400 });
    expect(s.calls[0]!.variables).toEqual({ filters: { startDate: "2026-10-01", endDate: "2026-10-31" } });
  });

  it("defaults to this month so far, and refuses half a range", async () => {
    const s = await fake();
    expect((await run(["cashflow", "summary"])).code).toBe(0);
    expect((s.calls[0]!.variables as { filters: { startDate: string } }).filters.startDate).toMatch(/^\d{4}-\d{2}-01$/);
    expect(JSON.parse((await run(["cashflow", "summary", "--start", "2026-10-01"])).stderr).message).toContain("both");
  });

  it("splits by group, category (largest first) and merchant (most spent first)", async () => {
    await fake();
    const d = JSON.parse((await run(["cashflow", "detail", "--start", "2026-10-01", "--end", "2026-10-31"])).stdout);
    expect(d.byCategory.map((x: { name: string }) => x.name)).toEqual(["Groceries", "Coffee"]);
    expect(d.byMerchant.map((x: { name: string }) => x.name)).toEqual(["Market", "Cafe"]);
    expect(d.byGroup[0]).toMatchObject({ name: "Food", sum: -600 });
  });
});

describe("recurring", () => {
  it("lists items in date order for the range asked", async () => {
    const s = await fake();
    const d = JSON.parse((await run(["recurring", "list", "--start", "2026-11-01", "--end", "2026-11-30"])).stdout);
    expect(d.items.map((i: { date: string }) => i.date)).toEqual(["2026-11-02", "2026-11-20"]);
    expect(s.calls[0]!.variables).toEqual({ startDate: "2026-11-01", endDate: "2026-11-30" });
  });

  it("lists streams, with or without credit-report payments", async () => {
    const s = await fake();
    expect(JSON.parse((await run(["recurring", "streams"])).stdout)).toHaveLength(1);
    await run(["recurring", "streams", "--no-liabilities"]);
    expect(s.calls.map((c) => c.variables)).toEqual([{ includeLiabilities: true }, { includeLiabilities: false }]);
  });
});
