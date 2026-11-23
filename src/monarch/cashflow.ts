// Cash flow: income, spending and savings over a date range, and the same split
// by category, category group and merchant.

import type { ApiClient } from "../client.js";

export type CashflowSummary = { sumIncome: number; sumExpense: number; savings: number; savingsRate: number };

const SUMMARY = `query Web_GetCashFlowPage($filters: TransactionFilterInput) {
  summary: aggregates(filters: $filters, fillEmptyValues: true) { summary { sumIncome sumExpense savings savingsRate } } }`;

const DETAIL = `query Web_GetCashFlowPage($filters: TransactionFilterInput) {
  byCategory: aggregates(filters: $filters, groupBy: ["category"]) {
    groupBy { category { id name group { id name type } } } summary { sum } }
  byCategoryGroup: aggregates(filters: $filters, groupBy: ["categoryGroup"]) {
    groupBy { categoryGroup { id name type } } summary { sum } }
  byMerchant: aggregates(filters: $filters, groupBy: ["merchant"]) {
    groupBy { merchant { id name } } summary { sumIncome sumExpense } }
  summary: aggregates(filters: $filters, fillEmptyValues: true) { summary { sumIncome sumExpense savings savingsRate } }
}`;

export type CashflowFilters = { startDate?: string; endDate?: string };

export async function cashflowSummary(client: ApiClient, filters: CashflowFilters): Promise<CashflowSummary> {
  const data = await client.graphql<{ summary: { summary: CashflowSummary }[] }>("Web_GetCashFlowPage", SUMMARY, { filters });
  return data.summary?.[0]?.summary ?? { sumIncome: 0, sumExpense: 0, savings: 0, savingsRate: 0 };
}

export type CashflowDetail = {
  summary: CashflowSummary;
  byCategory: { id: string; name: string; group: string; groupType: string; sum: number }[];
  byGroup: { id: string; name: string; type: string; sum: number }[];
  byMerchant: { id: string; name: string; income: number; expense: number }[];
};

type Agg<G, S> = { groupBy: G; summary: S }[];

export async function cashflowDetail(client: ApiClient, filters: CashflowFilters): Promise<CashflowDetail> {
  const data = await client.graphql<{
    byCategory: Agg<{ category: { id: string; name: string; group: { id: string; name: string; type: string } | null } | null }, { sum: number }>;
    byCategoryGroup: Agg<{ categoryGroup: { id: string; name: string; type: string } | null }, { sum: number }>;
    byMerchant: Agg<{ merchant: { id: string; name: string } | null }, { sumIncome: number; sumExpense: number }>;
    summary: { summary: CashflowSummary }[];
  }>("Web_GetCashFlowPage", DETAIL, { filters });
  const bySize = <T extends { sum: number }>(a: T[]) => a.sort((x, y) => Math.abs(y.sum) - Math.abs(x.sum));
  return {
    summary: data.summary?.[0]?.summary ?? { sumIncome: 0, sumExpense: 0, savings: 0, savingsRate: 0 },
    byCategory: bySize(
      (data.byCategory ?? []).map((x) => ({
        id: x.groupBy.category?.id ?? "",
        name: x.groupBy.category?.name ?? "(none)",
        group: x.groupBy.category?.group?.name ?? "",
        groupType: x.groupBy.category?.group?.type ?? "",
        sum: x.summary.sum,
      }))
    ),
    byGroup: bySize(
      (data.byCategoryGroup ?? []).map((x) => ({
        id: x.groupBy.categoryGroup?.id ?? "",
        name: x.groupBy.categoryGroup?.name ?? "(none)",
        type: x.groupBy.categoryGroup?.type ?? "",
        sum: x.summary.sum,
      }))
    ),
    byMerchant: (data.byMerchant ?? [])
      .map((x) => ({
        id: x.groupBy.merchant?.id ?? "",
        name: x.groupBy.merchant?.name ?? "(none)",
        income: x.summary.sumIncome,
        expense: x.summary.sumExpense,
      }))
      .sort((a, b) => a.expense - b.expense),
  };
}
