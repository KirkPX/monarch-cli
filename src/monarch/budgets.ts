// Budgets: planned versus actual per category and month, and setting a planned amount.

import type { ApiClient } from "../client.js";
import { ApiError, UsageError } from "../errors.js";

type MonthAmounts = {
  month: string;
  plannedCashFlowAmount: number | null;
  actualAmount: number | null;
  remainingAmount: number | null;
  previousMonthRolloverAmount: number | null;
  rolloverType: string | null;
};

type BudgetGroup = {
  id: string;
  name: string;
  type: string;
  groupLevelBudgetingEnabled: boolean;
  categories: { id: string; name: string }[];
};

type BudgetData = {
  budgetData: {
    monthlyAmountsByCategory: { category: { id: string }; monthlyAmounts: MonthAmounts[] }[];
    monthlyAmountsByCategoryGroup: { categoryGroup: { id: string }; monthlyAmounts: MonthAmounts[] }[];
    totalsByMonth: {
      month: string;
      totalIncome: Totals;
      totalExpenses: Totals;
    }[];
  };
  categoryGroups: BudgetGroup[];
};

type Totals = { plannedAmount: number | null; actualAmount: number | null; remainingAmount: number | null };

const BUDGETS = `query GetJointPlanningData($startDate: Date!, $endDate: Date!) {
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory { category { id } monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount previousMonthRolloverAmount rolloverType } }
    monthlyAmountsByCategoryGroup { categoryGroup { id } monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount previousMonthRolloverAmount rolloverType } }
    totalsByMonth { month
      totalIncome { plannedAmount actualAmount remainingAmount }
      totalExpenses { plannedAmount actualAmount remainingAmount } }
  }
  categoryGroups { id name type groupLevelBudgetingEnabled categories { id name } }
}`;

export type BudgetRow = {
  month: string;
  kind: "category" | "group";
  id: string;
  name: string;
  group: string;
  groupType: string;
  planned: number | null;
  actual: number | null;
  remaining: number | null;
  rollover: number | null;
};

export type Budgets = {
  start: string;
  end: string;
  rows: BudgetRow[];
  totals: { month: string; income: Totals; expenses: Totals }[];
};

/** First day of a YYYY-MM month, and the last day of the end month. */
export function monthRange(start: string, end: string): { startDate: string; endDate: string } {
  const [y, m] = end.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startDate: `${start}-01`, endDate: `${end}-${String(last).padStart(2, "0")}` };
}

export function parseMonth(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new UsageError(`Expected a month as YYYY-MM, not "${value}".`);
  }
  return `${m[1]}-${m[2]}`;
}

export async function getBudgets(client: ApiClient, start: string, end: string): Promise<Budgets> {
  const range = monthRange(start, end);
  const data = await client.graphql<BudgetData>("GetJointPlanningData", BUDGETS, range);
  if (!data.budgetData || !Array.isArray(data.categoryGroups)) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation: "GraphQL GetJointPlanningData", safeDetail: "no budgetData" });
  }
  const catInfo = new Map<string, { name: string; group: BudgetGroup }>();
  const groupInfo = new Map<string, BudgetGroup>();
  for (const g of data.categoryGroups) {
    groupInfo.set(g.id, g);
    for (const c of g.categories ?? []) catInfo.set(c.id, { name: c.name, group: g });
  }
  const rows: BudgetRow[] = [];
  const add = (kind: BudgetRow["kind"], id: string, name: string, group: BudgetGroup | undefined, a: MonthAmounts) =>
    rows.push({
      month: a.month.slice(0, 7),
      kind,
      id,
      name,
      group: group?.name ?? "",
      groupType: group?.type ?? "",
      planned: a.plannedCashFlowAmount,
      actual: a.actualAmount,
      remaining: a.remainingAmount,
      rollover: a.previousMonthRolloverAmount,
    });
  for (const c of data.budgetData.monthlyAmountsByCategory ?? []) {
    const info = catInfo.get(c.category.id);
    for (const a of c.monthlyAmounts) add("category", c.category.id, info?.name ?? c.category.id, info?.group, a);
  }
  for (const g of data.budgetData.monthlyAmountsByCategoryGroup ?? []) {
    const info = groupInfo.get(g.categoryGroup.id);
    if (!info?.groupLevelBudgetingEnabled) continue; // a group's own row matters only when it is budgeted as a whole
    for (const a of g.monthlyAmounts) add("group", g.categoryGroup.id, info.name, info, a);
  }
  rows.sort((a, b) => a.month.localeCompare(b.month) || a.groupType.localeCompare(b.groupType) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return {
    start,
    end,
    rows,
    totals: (data.budgetData.totalsByMonth ?? []).map((t) => ({ month: t.month.slice(0, 7), income: t.totalIncome, expenses: t.totalExpenses })),
  };
}

const SET_BUDGET = `mutation Common_UpdateBudgetItem($input: UpdateOrCreateBudgetItemMutationInput!) {
  updateOrCreateBudgetItem(input: $input) { budgetItem { id budgetAmount } } }`;

/** Set the planned amount for one category or one group in one month. Monarch reads 0 as "no budget". */
export async function setBudget(
  client: ApiClient,
  target: { categoryId?: string; categoryGroupId?: string },
  month: string,
  amount: number,
  applyToFuture: boolean
): Promise<void> {
  const data = await client.graphql<Record<string, unknown>>("Common_UpdateBudgetItem", SET_BUDGET, {
    input: {
      startDate: `${month}-01`,
      timeframe: "month",
      categoryId: target.categoryId ?? null,
      categoryGroupId: target.categoryGroupId ?? null,
      amount,
      applyToFuture,
    },
  });
  if (!data.updateOrCreateBudgetItem) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation: "GraphQL Common_UpdateBudgetItem", safeDetail: "no budget item in the reply" });
  }
}

/** The planned amount Monarch now holds for one category or group in one month. */
export async function plannedAmount(client: ApiClient, kind: "category" | "group", id: string, month: string): Promise<number | null> {
  const b = await getBudgets(client, month, month);
  return b.rows.find((r) => r.kind === kind && r.id === id && r.month === month)?.planned ?? null;
}
