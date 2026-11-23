import type { ApiClient } from "../client.js";
import { ApiError } from "../errors.js";
import { payload } from "./payload.js";

export type Account = {
  id: string;
  displayName: string;
  currentBalance: number | null;
  displayBalance?: number | null;
  includeInNetWorth: boolean;
  isHidden: boolean;
  isManual?: boolean;
  mask?: string | null;
  updatedAt: string | null;
  displayLastUpdatedAt?: string | null;
  syncDisabled?: boolean;
  type: { name: string; display: string } | null;
  subtype: { name: string; display: string } | null;
  institution: { id?: string; name: string } | null;
  isAsset?: boolean;
  deactivatedAt?: string | null;
  dataProvider?: string | null;
  transactionsCount?: number;
  /** The bank connection. `updateRequired` means Monarch needs you to sign in to the bank again. */
  credential?: {
    id: string;
    updateRequired: boolean;
    disconnectedFromDataProviderAt: string | null;
    dataProvider: string | null;
    institution: { id: string; name: string; status: string | null } | null;
  } | null;
};

const ACCOUNTS = `query GetAccounts { accounts { id displayName currentBalance displayBalance includeInNetWorth
  isHidden isManual isAsset mask updatedAt displayLastUpdatedAt syncDisabled deactivatedAt dataProvider transactionsCount
  type { name display } subtype { name display } institution { id name }
  credential { id updateRequired disconnectedFromDataProviderAt dataProvider institution { id name status } } } }`;

export async function listAccounts(client: ApiClient): Promise<Account[]> {
  return (await client.graphql<{ accounts: Account[] }>("GetAccounts", ACCOUNTS)).accounts;
}

// ── One account, in more detail ──────────────────────────────────────────────

/** The fields `accounts get` shows, and that a write is checked against. */
const DETAIL_FIELDS = `id displayName currentBalance displayBalance includeInNetWorth isHidden hideFromList
  hideTransactionsFromReports isManual isAsset mask createdAt updatedAt displayLastUpdatedAt syncDisabled
  deactivatedAt deletedAt dataProvider transactionsCount holdingsCount
  type { name display group } subtype { name display } institution { id name url }
  credential { id updateRequired disconnectedFromDataProviderAt dataProvider institution { id name status } }`;

export type AccountDetail = Account & {
  hideFromList?: boolean;
  hideTransactionsFromReports?: boolean;
  createdAt?: string | null;
  holdingsCount?: number;
  /** Set once the account is deleted. Monarch still answers for a deleted account by id. */
  deletedAt?: string | null;
};

export async function getAccount(client: ApiClient, id: string): Promise<AccountDetail | null> {
  const data = await client.graphql<{ account: AccountDetail | null }>(
    "AccountDetails_getAccount",
    `query AccountDetails_getAccount($id: UUID!) { account(id: $id) { ${DETAIL_FIELDS} } }`,
    { id }
  );
  return data.account ?? null;
}

// ── Balances over time ───────────────────────────────────────────────────────

export type Snapshot = { date: string; signedBalance: number };

const HISTORY = `query AccountDetails_getAccount($id: UUID!) {
  account(id: $id) { id displayName }
  snapshots: snapshotsForAccount(accountId: $id) { date signedBalance } }`;

/** The account's balance on each day Monarch recorded one, oldest first. */
export async function accountHistory(
  client: ApiClient,
  id: string
): Promise<{ account: { id: string; displayName: string } | null; snapshots: Snapshot[] }> {
  return await client.graphql("AccountDetails_getAccount", HISTORY, { id });
}

const RECENT = `query GetAccountRecentBalances($startDate: Date!) { accounts { id displayName recentBalances(startDate: $startDate) } }`;

/** One balance per day since `startDate`, for every account. */
export async function recentBalances(
  client: ApiClient,
  startDate: string
): Promise<{ id: string; displayName: string; recentBalances: (number | null)[] }[]> {
  return (await client.graphql<{ accounts: { id: string; displayName: string; recentBalances: (number | null)[] }[] }>(
    "GetAccountRecentBalances",
    RECENT,
    { startDate }
  )).accounts;
}

const BY_TYPE = `query GetSnapshotsByAccountType($startDate: Date!, $timeframe: Timeframe!) {
  snapshotsByAccountType(startDate: $startDate, timeframe: $timeframe) { accountType month balance }
  accountTypes { name group } }`;

export type TypeSnapshot = { accountType: string; month: string; balance: number };

/** Total balance per account type, per month or year. */
export async function snapshotsByType(
  client: ApiClient,
  startDate: string,
  timeframe: "month" | "year"
): Promise<{ snapshotsByAccountType: TypeSnapshot[]; accountTypes: { name: string; group: string }[] }> {
  return await client.graphql("GetSnapshotsByAccountType", BY_TYPE, { startDate, timeframe });
}

const AGGREGATE = `query GetAggregateSnapshots($filters: AggregateSnapshotFilters) { aggregateSnapshots(filters: $filters) { date balance } }`;

/** Net worth (all accounts, or one account type) on each day. */
export async function aggregateSnapshots(
  client: ApiClient,
  filters: { startDate: string; endDate?: string; accountType?: string }
): Promise<{ date: string; balance: number }[]> {
  return (await client.graphql<{ aggregateSnapshots: { date: string; balance: number }[] }>(
    "GetAggregateSnapshots",
    AGGREGATE,
    { filters: { startDate: filters.startDate, endDate: filters.endDate ?? null, accountType: filters.accountType ?? null } }
  )).aggregateSnapshots;
}

// ── Account types ────────────────────────────────────────────────────────────

export type AccountTypeOption = {
  type: { name: string; display: string; group: string; possibleSubtypes: { name: string; display: string }[] };
  subtype: { name: string; display: string } | null;
};

const TYPES = `query GetAccountTypeOptions { accountTypeOptions {
  type { name display group possibleSubtypes { name display } } subtype { name display } } }`;

export async function accountTypes(client: ApiClient): Promise<AccountTypeOption[]> {
  return (await client.graphql<{ accountTypeOptions: AccountTypeOption[] }>("GetAccountTypeOptions", TYPES)).accountTypeOptions;
}

// ── Bank refresh ─────────────────────────────────────────────────────────────

const REFRESH = `mutation Common_ForceRefreshAccountsMutation($input: ForceRefreshAccountsInput!) {
  forceRefreshAccounts(input: $input) { success errors { message code fieldErrors { field messages } } } }`;

/** Ask Monarch to fetch fresh data from the banks now, as the app's refresh button does. */
export async function refreshAccounts(client: ApiClient, accountIds: string[]): Promise<boolean> {
  const result = payload<{ success: boolean }>(
    await client.graphql("Common_ForceRefreshAccountsMutation", REFRESH, { input: { accountIds } }),
    "forceRefreshAccounts",
    "forceRefreshAccounts"
  );
  return Boolean(result.success);
}

const SYNC = `query ForceRefreshAccountsQuery { accounts { id hasSyncInProgress } }`;

export async function syncInProgress(client: ApiClient): Promise<Map<string, boolean>> {
  const data = await client.graphql<{ accounts: { id: string; hasSyncInProgress: boolean }[] }>("ForceRefreshAccountsQuery", SYNC);
  return new Map(data.accounts.map((a) => [a.id, Boolean(a.hasSyncInProgress)]));
}

// ── Manual accounts: create, change, delete ──────────────────────────────────

const ERRORS = `errors { message code fieldErrors { field messages } }`;
const CREATE = `mutation Web_CreateManualAccount($input: CreateManualAccountMutationInput!) {
  createManualAccount(input: $input) { account { id } ${ERRORS} } }`;
const UPDATE = `mutation Common_UpdateAccount($input: UpdateAccountMutationInput!) {
  updateAccount(input: $input) { account { id } ${ERRORS} } }`;
const DELETE = `mutation Common_DeleteAccount($id: UUID!) { deleteAccount(id: $id) { deleted ${ERRORS} } }`;

export type NewAccount = { type: string; subtype: string; name: string; displayBalance: number; includeInNetWorth: boolean };

export async function createManualAccount(client: ApiClient, input: NewAccount): Promise<string> {
  const result = payload<{ account: { id: string } | null }>(
    await client.graphql("Web_CreateManualAccount", CREATE, { input }),
    "createManualAccount",
    "createManualAccount"
  );
  if (!result.account?.id) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation: "createManualAccount", safeDetail: "no account id in the reply" });
  }
  return result.account.id;
}

/** The account fields `accounts update` can change, as Monarch names them in the input. */
export type AccountChange = {
  name?: string;
  displayBalance?: number;
  type?: string;
  subtype?: string;
  includeInNetWorth?: boolean;
  hideFromList?: boolean;
  hideTransactionsFromReports?: boolean;
};

export async function updateAccount(client: ApiClient, id: string, change: AccountChange): Promise<void> {
  payload(await client.graphql("Common_UpdateAccount", UPDATE, { input: { id, ...change } }), "updateAccount", "updateAccount");
}

export async function deleteAccount(client: ApiClient, id: string): Promise<boolean> {
  const result = payload<{ deleted: boolean }>(
    await client.graphql("Common_DeleteAccount", DELETE, { id }),
    "deleteAccount",
    "deleteAccount"
  );
  return Boolean(result.deleted);
}
