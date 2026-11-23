// Recurring bills and income as Monarch detects them: the upcoming items in a
// date range, and the streams (the pattern behind each one).

import type { ApiClient } from "../client.js";

export type RecurringItem = {
  date: string;
  isPast: boolean;
  transactionId: string | null;
  amount: number | null;
  amountDiff: number | null;
  stream: { id: string; frequency: string; amount: number | null; isApproximate: boolean; merchant: { id: string; name: string } | null };
  category: { id: string; name: string } | null;
  account: { id: string; displayName: string } | null;
};

const ITEMS = `query Web_GetUpcomingRecurringTransactionItems($startDate: Date!, $endDate: Date!, $filters: RecurringTransactionFilter) {
  recurringTransactionItems(startDate: $startDate, endDate: $endDate, filters: $filters) {
    stream { id frequency amount isApproximate merchant { id name } }
    date isPast transactionId amount amountDiff
    category { id name } account { id displayName } } }`;

export async function recurringItems(client: ApiClient, startDate: string, endDate: string): Promise<RecurringItem[]> {
  const data = await client.graphql<{ recurringTransactionItems: RecurringItem[] }>(
    "Web_GetUpcomingRecurringTransactionItems",
    ITEMS,
    { startDate, endDate }
  );
  return data.recurringTransactionItems ?? [];
}

export type RecurringStream = {
  stream: {
    id: string;
    reviewStatus: string | null;
    frequency: string;
    amount: number | null;
    baseDate: string | null;
    dayOfTheMonth: number | null;
    isApproximate: boolean;
    isActive: boolean;
    name: string | null;
    recurringType: string | null;
    merchant: { id: string; name: string } | null;
  };
  nextForecastedTransaction: { date: string; amount: number } | null;
  category: { id: string; name: string } | null;
  account: { id: string; displayName: string } | null;
};

const STREAMS = `query Common_GetRecurringStreams($includeLiabilities: Boolean) {
  recurringTransactionStreams(includePending: true, includeLiabilities: $includeLiabilities) {
    stream { id reviewStatus frequency amount baseDate dayOfTheMonth isApproximate isActive name recurringType merchant { id name } }
    nextForecastedTransaction { date amount }
    category { id name } account { id displayName } } }`;

export async function recurringStreams(client: ApiClient, includeLiabilities = true): Promise<RecurringStream[]> {
  const data = await client.graphql<{ recurringTransactionStreams: RecurringStream[] }>("Common_GetRecurringStreams", STREAMS, {
    includeLiabilities,
  });
  return data.recurringTransactionStreams ?? [];
}
