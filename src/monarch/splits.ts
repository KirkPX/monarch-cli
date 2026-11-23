// Splits: one transaction divided into parts, each with its own amount and category.
// Monarch replaces the whole set on each change, and an empty set removes the split.

import type { ApiClient } from "../client.js";
import { ApiError, UsageError } from "../errors.js";
import { payload } from "./payload.js";

export type Split = {
  id: string;
  amount: number;
  notes: string | null;
  merchant: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
};

export type SplitView = {
  id: string;
  amount: number;
  hasSplitTransactions: boolean;
  category: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  splitTransactions: Split[];
};

const SPLIT_FIELDS = `id amount notes merchant { id name } category { id name }`;

const SHOW = `query TransactionSplitQuery($id: UUID!) { getTransaction(id: $id) {
  id amount hasSplitTransactions category { id name } merchant { id name } splitTransactions { ${SPLIT_FIELDS} } } }`;

const SET = `mutation Common_SplitTransactionMutation($input: UpdateTransactionSplitMutationInput!) {
  updateTransactionSplit(input: $input) {
    errors { message code fieldErrors { field messages } }
    transaction { id hasSplitTransactions splitTransactions { ${SPLIT_FIELDS} } } } }`;

export async function getSplits(client: ApiClient, id: string): Promise<SplitView> {
  const data = await client.graphql<{ getTransaction: SplitView | null }>("TransactionSplitQuery", SHOW, { id });
  if (!data.getTransaction) {
    throw new ApiError({ status: 404, statusText: "Not found", operation: "GraphQL TransactionSplitQuery", safeDetail: `no transaction ${id}` });
  }
  return data.getTransaction;
}

export type SplitInput = { amount: number; categoryId: string; merchantName?: string; notes?: string };

/** Cents, so 0.1 + 0.2 sums the way a person expects. */
export const cents = (n: number) => Math.round(n * 100);

/** Refuse splits that do not add up to the transaction, before anything is sent. */
export function checkSum(total: number, splits: SplitInput[]): void {
  if (splits.length === 1) throw new UsageError("A split needs at least two parts.", "Use `splits clear` to remove a split.");
  const sum = splits.reduce((s, x) => s + cents(x.amount), 0);
  if (sum !== cents(total)) {
    throw new UsageError(
      `The splits add up to ${(sum / 100).toFixed(2)}, but the transaction is ${total.toFixed(2)}.`,
      "Change the amounts so they add up exactly. Spending is negative."
    );
  }
}

export async function setSplits(client: ApiClient, id: string, splits: SplitInput[]): Promise<void> {
  payload(
    await client.graphql("Common_SplitTransactionMutation", SET, { input: { transactionId: id, splitData: splits } }),
    "updateTransactionSplit",
    "updateTransactionSplit"
  );
}
