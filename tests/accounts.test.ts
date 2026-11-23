// The accounts, institutions and holdings commands, driven through the built CLI
// against a fake Monarch (tests/stub.ts). Nothing here reaches the real service.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { byOperation, startStub, type Stub, type StubCall } from "./stub.js";

const distIndex = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

type Run = { code: number | null; stdout: string; stderr: string; json: any };

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const dir = mkdtempSync(path.join(tmpdir(), "monarch accounts ü "));
  dirs.push(dir);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: {
        ...process.env,
        MONARCH_API_KEY: "test-token",
        MONARCH_BASE_URL: stub!.url,
        MONARCH_CLI_CONFIG_FILE: path.join(dir, "config.json"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout || stderr);
      } catch {
        json = undefined;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

const linked = {
  id: "a1",
  displayName: "Checking (...1111)",
  currentBalance: 100,
  displayBalance: 100,
  includeInNetWorth: true,
  isHidden: false,
  isManual: false,
  mask: "1111",
  updatedAt: new Date().toISOString(),
  displayLastUpdatedAt: new Date().toISOString(),
  syncDisabled: false,
  type: { name: "depository", display: "Cash" },
  subtype: { name: "checking", display: "Checking" },
  institution: { id: "i1", name: "Bank One" },
  credential: { id: "c1", updateRequired: false, disconnectedFromDataProviderAt: null, dataProvider: "PLAID", institution: { id: "i1", name: "Bank One", status: "HEALTHY" } },
};
const signInNeeded = {
  ...linked,
  id: "a2",
  displayName: "Old Bank (...2222)",
  displayLastUpdatedAt: "2026-01-01T00:00:00Z",
  credential: { ...linked.credential, id: "c2", updateRequired: true },
};
const brokerage = { ...linked, id: "a3", displayName: "Brokerage", type: { name: "brokerage", display: "Investments" } };
const hidden = { ...linked, id: "a4", displayName: "Hidden", isHidden: true, credential: null, isManual: true };
const manual = { ...linked, id: "m1", displayName: "House", isManual: true, credential: null, institution: null };
const ACCOUNTS = [linked, signInNeeded, brokerage, hidden, manual];

const detail = (over: Record<string, unknown> = {}) => ({
  ...manual,
  hideFromList: false,
  hideTransactionsFromReports: false,
  deletedAt: null,
  transactionsCount: 0,
  ...over,
});

const mutations = (s: Stub) => s.calls.filter((c) => String(c.body.query ?? "").trimStart().startsWith("mutation"));
const isHistory = (c: StubCall) => String(c.body.query).includes("snapshotsForAccount");

describe("accounts reads", () => {
  it("list hides hidden accounts unless asked, and gives each a connection state", async () => {
    stub = await startStub(byOperation({ GetAccounts: { accounts: ACCOUNTS } }));
    const shown = await run(["accounts", "list"]);
    expect(shown.code).toBe(0);
    expect(shown.json.map((a: any) => a.id)).toEqual(["a1", "a2", "a3", "m1"]);
    expect(shown.json.find((a: any) => a.id === "a2").connection).toBe("needs bank sign-in");
    const all = await run(["accounts", "list", "--include-hidden"]);
    expect(all.json).toHaveLength(5);
    expect(stub.calls[0]!.headers.authorization).toBe("Token test-token");
  });

  it("get shows one account, and names a missing one", async () => {
    stub = await startStub(byOperation({ AccountDetails_getAccount: (c: StubCall) => ({ account: c.variables?.id === "m1" ? detail() : null }) }));
    const ok = await run(["accounts", "get", "m1"]);
    expect(ok.json).toMatchObject({ id: "m1", displayName: "House" });
    const missing = await run(["accounts", "get", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.json).toMatchObject({ error: true, message: "There is no account nope." });
  });

  it("types lists the type options", async () => {
    const opt = { type: { name: "other_asset", display: "Other Asset", group: "asset", possibleSubtypes: [{ name: "other", display: "Other" }] }, subtype: null };
    stub = await startStub(byOperation({ GetAccountTypeOptions: { accountTypeOptions: [opt] } }));
    const r = await run(["accounts", "types"]);
    expect(r.json).toEqual([opt]);
  });

  it("history filters the balances to the dates asked for", async () => {
    const snapshots = [
      { date: "2026-10-31", signedBalance: 1 },
      { date: "2026-11-01", signedBalance: 2 },
      { date: "2026-11-02", signedBalance: 3 },
    ];
    stub = await startStub(byOperation({ AccountDetails_getAccount: { account: { id: "a1", displayName: "Checking" }, snapshots } }));
    const r = await run(["accounts", "history", "a1", "--start", "2026-11-01", "--end", "20261101"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ count: 1, snapshots: [{ date: "2026-11-01", signedBalance: 2 }] });
    expect(isHistory(stub.calls[0]!)).toBe(true);
  });

  it("balances dates each daily balance from the start date", async () => {
    stub = await startStub(byOperation({ GetAccountRecentBalances: { accounts: [{ id: "a1", displayName: "Checking", recentBalances: [5, 6, null] }] } }));
    const r = await run(["accounts", "balances", "--start", "2026-11-01"]);
    expect(stub.calls[0]!.variables).toEqual({ startDate: "2026-11-01" });
    expect(r.json.accounts[0].balances).toEqual([
      { date: "2026-11-01", balance: 5 },
      { date: "2026-11-02", balance: 6 },
      { date: "2026-11-03", balance: null },
    ]);
  });

  it("snapshots sends the timeframe and refuses a bad one", async () => {
    stub = await startStub(byOperation({ GetSnapshotsByAccountType: { snapshotsByAccountType: [{ accountType: "depository", month: "2026-01", balance: 9 }], accountTypes: [] } }));
    const r = await run(["accounts", "snapshots", "--start", "2026-01-01", "--timeframe", "year"]);
    expect(stub.calls[0]!.variables).toEqual({ startDate: "2026-01-01", timeframe: "year" });
    expect(r.json.snapshotsByAccountType).toHaveLength(1);
    const bad = await run(["accounts", "snapshots", "--timeframe", "week"]);
    expect(bad.code).toBe(1);
    expect(bad.json.message).toContain("month or year");
    expect(stub.calls).toHaveLength(1);
  });

  it("net-worth sends the date range and account type", async () => {
    stub = await startStub(byOperation({ GetAggregateSnapshots: { aggregateSnapshots: [{ date: "2026-11-01", balance: 10 }] } }));
    const r = await run(["accounts", "net-worth", "--start", "2026-11-01", "--end", "2026-11-02", "--type", "brokerage"]);
    expect(stub.calls[0]!.variables).toEqual({ filters: { startDate: "2026-11-01", endDate: "2026-11-02", accountType: "brokerage" } });
    expect(r.json).toMatchObject({ count: 1, accountType: "brokerage" });
  });

  it("refresh-status puts accounts that need a bank sign-in first and counts the problems", async () => {
    const stale = { ...linked, id: "a5", displayName: "Stale", displayLastUpdatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() };
    stub = await startStub(
      byOperation({
        GetAccounts: { accounts: [linked, stale, signInNeeded, manual] },
        ForceRefreshAccountsQuery: { accounts: [{ id: "a1", hasSyncInProgress: true }] },
      })
    );
    const r = await run(["accounts", "refresh-status"]);
    expect(r.code).toBe(0);
    expect(r.json.accounts.map((a: any) => [a.id, a.state])).toEqual([
      ["a2", "needs bank sign-in"],
      ["a5", "stale"],
      ["a1", "syncing"],
      ["m1", "manual"],
    ]);
    expect(r.json.problems).toBe(2);
    const lenient = await run(["accounts", "refresh-status", "--stale-days", "30"]);
    expect(lenient.json.accounts.find((a: any) => a.id === "a5").state).toBe("ok");
  });

  it("institutions list groups each connection's accounts", async () => {
    stub = await startStub(
      byOperation({
        Web_GetInstitutionSettings: {
          credentials: [{ id: "c1", updateRequired: true, disconnectedFromDataProviderAt: null, displayLastUpdatedAt: "2026-11-01", dataProvider: "PLAID", institution: { id: "i1", name: "Bank One", url: null, hasIssuesReported: false, hasIssuesReportedMessage: null, status: "HEALTHY", balanceStatus: null, transactionsStatus: null } }],
          accounts: [
            { id: "a1", displayName: "Checking", mask: "1111", deletedAt: null, subtype: null, credential: { id: "c1" } },
            { id: "gone", displayName: "Closed", mask: null, deletedAt: "2026-01-01", subtype: null, credential: { id: "c1" } },
          ],
        },
      })
    );
    const r = await run(["institutions", "list"]);
    expect(r.json[0]).toMatchObject({ id: "c1", updateRequired: true, accounts: [{ id: "a1", name: "Checking", mask: "1111" }] });
  });

  it("holdings list reads every brokerage account by default, or the ones named", async () => {
    const node = { id: "h1", quantity: 2, basis: 1, totalValue: 20, securityPriceChangeDollars: 0, securityPriceChangePercent: 0, lastSyncedAt: null, holdings: [], security: { id: "s1", name: "Fund", ticker: "FND", type: null, typeDisplay: null, currentPrice: 10, currentPriceUpdatedAt: null, closingPrice: 10, closingPriceUpdatedAt: null, oneDayChangePercent: 0, oneDayChangeDollars: 0 } };
    stub = await startStub(byOperation({ GetAccounts: { accounts: ACCOUNTS }, Web_GetHoldings: { portfolio: { aggregateHoldings: { edges: [{ node }] } } } }));
    const r = await run(["holdings", "list"]);
    expect(r.json).toEqual([{ account: { id: "a3", name: "Brokerage" }, holdings: [node] }]);
    const holdingsCall = stub.calls.find((c) => c.operationName === "Web_GetHoldings")!;
    expect((holdingsCall.variables as any).input.accountIds).toEqual(["a3"]);
    const named = await run(["holdings", "list", "--account", "a1", "--account", "a3"]);
    expect(named.json.map((x: any) => x.account.id)).toEqual(["a1", "a3"]);
    const missing = await run(["holdings", "list", "--account", "zzz"]);
    expect(missing.code).toBe(1);
  });
});

describe("accounts refresh", () => {
  const answers = (extra: Record<string, unknown> = {}) =>
    byOperation({
      GetAccounts: { accounts: ACCOUNTS },
      Common_ForceRefreshAccountsMutation: { forceRefreshAccounts: { success: true, errors: null } },
      ForceRefreshAccountsQuery: { accounts: [{ id: "a1", hasSyncInProgress: false }] },
      ...extra,
    });

  it("a dry run names the accounts and sends no mutation", async () => {
    stub = await startStub(answers());
    const r = await run(["accounts", "refresh", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ dryRun: true, changed: false, accountIds: ["a1", "a2", "a3"] });
    expect(mutations(stub)).toHaveLength(0);
  });

  it("read-only mode refuses before anything is sent", async () => {
    stub = await startStub(answers());
    const r = await run(["--read-only", "accounts", "refresh", "a1"]);
    expect(r.code).toBe(1);
    expect(r.json.message).toContain("Read-only");
    expect(stub.calls).toHaveLength(0);
    const fromEnv = await run(["accounts", "refresh", "a1"], { MONARCH_READ_ONLY: "1" });
    expect(fromEnv.code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends the accounts asked for, and waits until they finish", async () => {
    stub = await startStub(answers());
    const r = await run(["accounts", "refresh", "a1", "--wait", "--interval", "0"]);
    expect(r.code).toBe(0);
    expect(mutations(stub)[0]!.variables).toEqual({ input: { accountIds: ["a1"] } });
    expect(r.json).toMatchObject({ ok: true, changed: true, results: [{ id: "a1", stillSyncing: false }] });
  });

  it("exits 1 when the wait ends with accounts still updating", async () => {
    stub = await startStub(answers({ ForceRefreshAccountsQuery: { accounts: [{ id: "a1", hasSyncInProgress: true }] } }));
    const r = await run(["accounts", "refresh", "a1", "--wait", "--interval", "0", "--timeout", "0"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, results: [{ id: "a1", stillSyncing: true }] });
  });

  it("exits 1 with Monarch's reason when it refuses", async () => {
    stub = await startStub(answers({ Common_ForceRefreshAccountsMutation: { forceRefreshAccounts: { success: false, errors: { message: "Too many refreshes", code: "RATE", fieldErrors: [] } } } }));
    const r = await run(["accounts", "refresh", "a1"]);
    expect(r.code).toBe(1);
    expect(r.json.message).toContain("Too many refreshes");
  });

  it("refuses an id that is not an account", async () => {
    stub = await startStub(answers());
    const r = await run(["accounts", "refresh", "nope"]);
    expect(r.code).toBe(1);
    expect(mutations(stub)).toHaveLength(0);
  });
});

describe("manual accounts", () => {
  it("create: a dry run sends nothing; a real one sends the input and reads the account back", async () => {
    stub = await startStub(
      byOperation({
        Web_CreateManualAccount: { createManualAccount: { account: { id: "m9" }, errors: null } },
        AccountDetails_getAccount: { account: detail({ id: "m9", displayName: "Test" }) },
      })
    );
    const dry = await run(["accounts", "create", "--type", "other_asset", "--subtype", "other", "--name", "Test", "--balance", "1.50", "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true, input: { displayBalance: 1.5, includeInNetWorth: true } });
    expect(mutations(stub)).toHaveLength(0);
    const real = await run(["accounts", "create", "--type", "other_asset", "--subtype", "other", "--name", "Test", "--exclude-from-net-worth"]);
    expect(real.code).toBe(0);
    expect(mutations(stub)[0]!.variables).toEqual({ input: { type: "other_asset", subtype: "other", name: "Test", displayBalance: 0, includeInNetWorth: false } });
    expect(real.json).toMatchObject({ changed: true, account: { id: "m9" } });
  });

  it("create fails when the new account does not read back", async () => {
    stub = await startStub(
      byOperation({
        Web_CreateManualAccount: { createManualAccount: { account: { id: "m9" }, errors: null } },
        AccountDetails_getAccount: { account: null },
      })
    );
    const r = await run(["accounts", "create", "--type", "other_asset", "--subtype", "other", "--name", "Test"]);
    expect(r.code).toBe(1);
    expect(r.json.message).toContain("does not read back");
  });

  it("create refuses a balance that is not a number, before sending", async () => {
    stub = await startStub(byOperation({}));
    const r = await run(["accounts", "create", "--type", "x", "--subtype", "y", "--name", "n", "--balance", "lots"]);
    expect(r.code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  it("update sends only what differs and checks it by reading back", async () => {
    let current = detail();
    stub = await startStub(
      byOperation({
        AccountDetails_getAccount: () => ({ account: current }),
        Common_UpdateAccount: (c: StubCall) => {
          const input = (c.variables as any).input;
          current = detail({ displayName: input.name ?? current.displayName, displayBalance: input.displayBalance ?? current.displayBalance, hideFromList: input.hideFromList ?? current.hideFromList });
          return { updateAccount: { account: { id: "m1" }, errors: null } };
        },
      })
    );
    const dry = await run(["accounts", "update", "m1", "--name", "Home", "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true, changes: [{ field: "name", from: "House", to: "Home" }] });
    expect(mutations(stub)).toHaveLength(0);

    const r = await run(["accounts", "update", "m1", "--name", "Home", "--balance", "100", "--hide", "true"]);
    expect(r.code).toBe(0);
    // The balance already was 100, so only name and hide are sent.
    expect(mutations(stub)[0]!.variables).toEqual({ input: { id: "m1", name: "Home", hideFromList: true } });
    expect(r.json).toMatchObject({ changed: true });

    const again = await run(["accounts", "update", "m1", "--name", "Home"]);
    expect(again.json).toMatchObject({ changed: false });
    expect(mutations(stub)).toHaveLength(1);
  });

  it("update exits 1 when Monarch accepts the change but reads back the old value", async () => {
    stub = await startStub(
      byOperation({
        AccountDetails_getAccount: { account: detail() },
        Common_UpdateAccount: { updateAccount: { account: { id: "m1" }, errors: { message: "Something went wrong", code: null, fieldErrors: [] } } },
      })
    );
    const refused = await run(["accounts", "update", "m1", "--name", "Home"]);
    expect(refused.code).toBe(1);
    expect(refused.json.message).toContain("Something went wrong");

    await stub.close();
    stub = await startStub(
      byOperation({ AccountDetails_getAccount: { account: detail() }, Common_UpdateAccount: { updateAccount: { account: { id: "m1" }, errors: null } } })
    );
    const silent = await run(["accounts", "update", "m1", "--name", "Home"]);
    expect(silent.code).toBe(1);
    expect(silent.json).toMatchObject({ ok: false, changed: false });
    expect(silent.json.summary).toContain("reads back");
  });

  it("update refuses a bad true/false and an empty change", async () => {
    stub = await startStub(byOperation({ AccountDetails_getAccount: { account: detail() } }));
    expect((await run(["accounts", "update", "m1", "--hide", "yes"])).code).toBe(1);
    expect((await run(["accounts", "update", "m1"])).json.message).toBe("Nothing to change.");
    expect(mutations(stub)).toHaveLength(0);
  });

  it("delete refuses without --yes when nobody can answer, and sends nothing", async () => {
    stub = await startStub(byOperation({ AccountDetails_getAccount: { account: detail() } }));
    const r = await run(["accounts", "delete", "m1"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ aborted: true, changed: false });
    const dry = await run(["accounts", "delete", "m1", "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true });
    expect(mutations(stub)).toHaveLength(0);
  });

  it("delete with --yes checks the account reads back as deleted", async () => {
    let deleted = false;
    stub = await startStub(
      byOperation({
        AccountDetails_getAccount: () => ({ account: detail({ deletedAt: deleted ? "2026-11-23T00:00:00Z" : null }) }),
        Common_DeleteAccount: () => {
          deleted = true;
          return { deleteAccount: { deleted: true, errors: null } };
        },
      })
    );
    const r = await run(["accounts", "delete", "m1", "--yes"]);
    expect(r.code).toBe(0);
    expect(mutations(stub)[0]!.variables).toEqual({ id: "m1" });
    const again = await run(["accounts", "delete", "m1", "--yes"]);
    expect(again.code).toBe(1);
    expect(again.json.message).toContain("it was deleted");
  });

  it("delete fails when the account still reads back as not deleted", async () => {
    stub = await startStub(
      byOperation({ AccountDetails_getAccount: { account: detail() }, Common_DeleteAccount: { deleteAccount: { deleted: true, errors: null } } })
    );
    const r = await run(["accounts", "delete", "m1", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.json.message).toContain("still reads back");
  });
});
