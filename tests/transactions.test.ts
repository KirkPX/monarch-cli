// Drives the built CLI against a fake Monarch (tests/stub.ts). Every transaction
// command is covered, with the safety rules: dry runs send nothing, conflicts send
// nothing, a write counts only after it reads back, deletes need --yes.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byOperation, startStub, type Stub, type StubCall } from "./stub.js";

const dist = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
const dir = mkdtempSync(path.join(tmpdir(), "monarch tx ü "));

type Run = { code: number; stdout: string; stderr: string };
function run(stub: Stub, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [dist, "--json", ...args],
      {
        env: {
          ...process.env,
          MONARCH_API_KEY: "test-token",
          MONARCH_BASE_URL: stub.url,
          MONARCH_CLI_CONFIG_FILE: path.join(dir, `config-${Math.random()}.json`),
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
  });
}

const CATEGORIES = {
  categories: [
    { id: "c1", name: "Groceries", group: { id: "g1", name: "Food", type: "expense" } },
    { id: "c2", name: "Medical", group: { id: "g2", name: "Health", type: "expense" } },
  ],
};
const TAGS = { householdTransactionTags: [{ id: "t1", name: "Business", color: null, order: 1 }, { id: "t2", name: "Reimburse", color: null, order: 2 }] };

function txn(over: Record<string, unknown> = {}) {
  return {
    id: "x1", date: "2026-11-02", amount: -12.5, pending: false, notes: null, hideFromReports: false,
    needsReview: false, reviewStatus: null, reviewedAt: null, isSplitTransaction: false, plaidName: "SHOP",
    merchant: { id: "m1", name: "Shop" }, category: { id: "c1", name: "Groceries" },
    account: { id: "a1", displayName: "Card" }, tags: [], ...over,
  };
}

/** A fake Monarch holding one transaction that updates apply to. */
function monarchWith(state: Record<string, unknown>, opts: { ignoreWrites?: boolean; refuse?: boolean } = {}) {
  return byOperation({
    GetCategories: CATEGORIES,
    GetHouseholdTransactionTags: TAGS,
    GetTransaction: () => ({ getTransaction: state }),
    Web_TransactionDrawerUpdateTransaction: (call: StubCall) => {
      if (opts.refuse) return { updateTransaction: { transaction: null, errors: { message: "Something went wrong", code: null, fieldErrors: [] } } };
      const input = (call.variables as { input: Record<string, unknown> }).input;
      if (!opts.ignoreWrites) {
        if (input.category) state.category = { id: input.category, name: "?" };
        if (input.notes !== undefined) state.notes = input.notes || null;
        if (input.name) state.merchant = { id: "m", name: input.name };
        if (input.hideFromReports !== undefined) state.hideFromReports = input.hideFromReports;
      }
      return { updateTransaction: { transaction: { id: state.id }, errors: null } };
    },
    Web_SetTransactionTags: (call: StubCall) => {
      const ids = (call.variables as { input: { tagIds: string[] } }).input.tagIds;
      state.tags = TAGS.householdTransactionTags.filter((t) => ids.includes(t.id));
      return { setTransactionTags: { transaction: { id: state.id }, errors: null } };
    },
  });
}

const mutations = (stub: Stub) => stub.calls.filter((c) => /mutation/.test(String(c.body.query))).map((c) => c.operationName);

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe("transactions list", () => {
  it("pages through every match with --all and checks the count", async () => {
    const all = Array.from({ length: 300 }, (_, i) => txn({ id: `t${i}` }));
    stub = await startStub(byOperation({
      GetTransactionsList: (call: StubCall) => {
        const { offset, limit } = call.variables as { offset: number; limit: number };
        return { allTransactions: { totalCount: 300, results: all.slice(offset, offset + limit) } };
      },
    }));
    const r = await run(stub, ["transactions", "list", "--all", "--start", "2026-11-01", "--end", "2026-11-30"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(300);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]!.variables).toMatchObject({ filters: { startDate: "2026-11-01", endDate: "2026-11-30" } });
  });

  it("fails when Monarch's total and the rows read disagree", async () => {
    stub = await startStub(byOperation({ GetTransactionsList: { allTransactions: { totalCount: 5, results: [txn()] } } }));
    const r = await run(stub, ["transactions", "list", "--all"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).message).toContain("Monarch reports 5");
  });

  it("turns category and tag names into ids, and stops at --limit", async () => {
    stub = await startStub(byOperation({
      GetCategories: CATEGORIES,
      GetHouseholdTransactionTags: TAGS,
      GetTransactionsList: { allTransactions: { totalCount: 9, results: [txn(), txn({ id: "x2" })] } },
    }));
    const r = await run(stub, ["transactions", "list", "--category", "medical", "--tag", "Business", "--limit", "2"]);
    expect(r.code).toBe(0);
    const list = stub.calls.find((c) => c.operationName === "GetTransactionsList")!;
    expect(list.variables).toMatchObject({ limit: 2, filters: { categories: ["c2"], tags: ["t1"] } });
  });

  it("asks for every field with --full", async () => {
    stub = await startStub(byOperation({ GetTransactionsList: { allTransactions: { totalCount: 0, results: [] } } }));
    await run(stub, ["transactions", "list", "--full"]);
    expect(String(stub.calls[0]!.body.query)).toContain("plaidTransactionId");
  });

  it("refuses half a date range", async () => {
    stub = await startStub(byOperation({}));
    const r = await run(stub, ["transactions", "list", "--start", "2026-11-01"]);
    expect(r.code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("transactions get and summary", () => {
  it("gets one transaction with every field", async () => {
    stub = await startStub(byOperation({ GetTransaction: { getTransaction: txn() } }));
    const r = await run(stub, ["transactions", "get", "x1"]);
    expect(JSON.parse(r.stdout).id).toBe("x1");
    expect(String(stub.calls[0]!.body.query)).toContain("householdMerchant");
  });

  it("says plainly when a transaction does not exist", async () => {
    stub = await startStub(byOperation({ GetTransaction: { getTransaction: null } }));
    const r = await run(stub, ["transactions", "get", "nope"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).message).toContain("no transaction nope");
  });

  it("returns the summary totals", async () => {
    stub = await startStub(byOperation({ GetTransactionsPage: { aggregates: [{ summary: { count: 3, sum: -10 } }] } }));
    const r = await run(stub, ["transactions", "summary", "--start", "2026-11-01", "--end", "2026-11-02"]);
    expect(JSON.parse(r.stdout)).toEqual({ count: 3, sum: -10 });
  });
});

describe("transactions update", () => {
  it("changes, then reads back and reports verified", async () => {
    const state = txn();
    stub = await startStub(monarchWith(state));
    const r = await run(stub, ["transactions", "update", "x1", "--category", "Medical", "--notes", "therapy", "--tags", "Reimburse; Business"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, changed: true, dryRun: false, results: [{ status: "verified" }] });
    expect(mutations(stub)).toEqual(["Web_TransactionDrawerUpdateTransaction", "Web_SetTransactionTags"]);
    const input = (stub.calls.find((c) => c.operationName === "Web_TransactionDrawerUpdateTransaction")!.variables as { input: object }).input;
    expect(input).toEqual({ id: "x1", category: "c2", notes: "therapy" });
    expect(stub.calls.filter((c) => c.operationName === "GetTransaction")).toHaveLength(2);
  });

  it("sends nothing on a dry run", async () => {
    stub = await startStub(monarchWith(txn()));
    const r = await run(stub, ["transactions", "update", "x1", "--category", "Medical", "--dry-run"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, changed: false, results: [{ status: "would-change" }] });
    expect(mutations(stub)).toEqual([]);
  });

  it("refuses when Monarch no longer holds the expected value", async () => {
    stub = await startStub(monarchWith(txn()));
    const r = await run(stub, ["transactions", "update", "x1", "--category", "Medical", "--expect", "category=Medical"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).results[0]).toMatchObject({ status: "conflict", conflicts: [{ field: "category", expected: "c2", actual: "c1" }] });
    expect(mutations(stub)).toEqual([]);
  });

  it("goes ahead when the expected value matches, in flag spelling too", async () => {
    stub = await startStub(monarchWith(txn()));
    const r = await run(stub, ["transactions", "update", "x1", "--hide-from-reports", "true", "--expect", "category=Groceries", "--expect", "hide-from-reports=false"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).results[0].status).toBe("verified");
  });

  it("fails when Monarch accepts the write but reads back the old value", async () => {
    stub = await startStub(monarchWith(txn(), { ignoreWrites: true }));
    const r = await run(stub, ["transactions", "update", "x1", "--notes", "hello"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).results[0]).toMatchObject({ status: "failed", error: expect.stringContaining("reads back") });
  });

  it("fails when Monarch puts an error in the reply", async () => {
    stub = await startStub(monarchWith(txn(), { refuse: true }));
    const r = await run(stub, ["transactions", "update", "x1", "--notes", "hello"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).message).toContain("Something went wrong");
  });

  it("reports unchanged when the value is already there", async () => {
    stub = await startStub(monarchWith(txn()));
    const r = await run(stub, ["transactions", "update", "x1", "--category", "Groceries"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ changed: false, results: [{ status: "unchanged" }] });
    expect(mutations(stub)).toEqual([]);
  });

  it("refuses an unknown tag and a bad --expect before sending", async () => {
    stub = await startStub(monarchWith(txn()));
    expect((await run(stub, ["transactions", "update", "x1", "--tags", "Nope"])).code).toBe(1);
    expect((await run(stub, ["transactions", "update", "x1", "--notes", "a", "--expect", "colour=red"])).code).toBe(1);
    expect(mutations(stub)).toEqual([]);
  });

  it("refuses in read-only mode", async () => {
    stub = await startStub(monarchWith(txn()));
    const r = await run(stub, ["--read-only", "transactions", "update", "x1", "--notes", "a"]);
    expect(r.code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("transactions batch-update", () => {
  it("applies each change and stops at the first conflict", async () => {
    const state = txn();
    stub = await startStub(monarchWith(state));
    const file = path.join(dir, "batch.json");
    writeFileSync(file, JSON.stringify([
      { id: "x1", set: { notes: "one" } },
      { id: "x1", set: { notes: "two" }, expect: { notes: "not this" } },
      { id: "x1", set: { notes: "three" } },
    ]));
    const r = await run(stub, ["transactions", "batch-update", file]);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.results.map((x: { status: string }) => x.status)).toEqual(["verified", "conflict"]);
    expect(out.counts).toEqual({ total: 3, succeeded: 1, failed: 1 });
    expect(state.notes).toBe("one");
  });

  it("carries on with --keep-going", async () => {
    stub = await startStub(monarchWith(txn()));
    const file = path.join(dir, "batch2.json");
    writeFileSync(file, JSON.stringify([
      { id: "x1", set: { notes: "a" }, expect: { notes: "zzz" } },
      { id: "x1", set: { notes: "b" } },
    ]));
    const r = await run(stub, ["transactions", "batch-update", `@${file}`, "--keep-going"]);
    expect(JSON.parse(r.stdout).results.map((x: { status: string }) => x.status)).toEqual(["conflict", "verified"]);
  });

  it("refuses a file that is not a list of changes", async () => {
    stub = await startStub(monarchWith(txn()));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify([{ id: "x1", set: { colour: "red" } }]));
    const r = await run(stub, ["transactions", "batch-update", file]);
    expect(r.code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("transactions create and delete", () => {
  it("creates with the category id and reads the new transaction back", async () => {
    stub = await startStub(byOperation({
      GetCategories: CATEGORIES,
      Common_CreateTransactionMutation: { createTransaction: { transaction: { id: "new1" }, errors: null } },
      GetTransaction: { getTransaction: txn({ id: "new1" }) },
    }));
    const r = await run(stub, ["transactions", "create", "--account", "a1", "--date", "2026-11-02", "--amount", "-10", "--merchant", "Test", "--category", "Groceries"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ changed: true, transaction: { id: "new1" } });
    const create = stub.calls.find((c) => c.operationName === "Common_CreateTransactionMutation")!;
    expect((create.variables as { input: object }).input).toMatchObject({ accountId: "a1", amount: -10, categoryId: "c1", shouldUpdateBalance: false });
  });

  it("refuses to delete without --yes when nobody can answer", async () => {
    stub = await startStub(byOperation({ GetTransaction: { getTransaction: txn() } }));
    const r = await run(stub, ["transactions", "delete", "x1"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ aborted: true, changed: false });
    expect(mutations(stub)).toEqual([]);
  });

  it("deletes with --yes and checks it is gone", async () => {
    let deleted = false;
    stub = await startStub(byOperation({
      GetTransaction: () => ({ getTransaction: deleted ? null : txn() }),
      Common_DeleteTransactionMutation: () => {
        deleted = true;
        return { deleteTransaction: { deleted: true, errors: null } };
      },
    }));
    const r = await run(stub, ["transactions", "delete", "x1", "--yes"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ changed: true });
  });
});

describe("export", () => {
  it("writes one file with accounts, categories and every field of each transaction", async () => {
    const { FULL_KEYS } = await import("../src/monarch/transactions.js");
    const full = Object.fromEntries(FULL_KEYS.map((k) => [k, null]));
    stub = await startStub(byOperation({
      GetAccounts: { accounts: [{ id: "a1" }] },
      GetCategories: CATEGORIES,
      GetTransactionsList: { allTransactions: { totalCount: 1, results: [{ ...full, id: "x1" }] } },
    }));
    const out = path.join(dir, "sub folder", "export.json");
    const r = await run(stub, ["export", "--since", "2026-11-01", "--until", "2026-11-15", "--out", out]);
    expect(r.code).toBe(0);
    const file = JSON.parse(readFileSync(out, "utf-8"));
    expect(file).toMatchObject({ window: { since: "2026-11-01", until: "2026-11-15" }, counts: { accounts: 1, categories: 2, transactions: 1 } });
  });

  it("refuses to write when a transaction lacks a field it asked for", async () => {
    stub = await startStub(byOperation({
      GetAccounts: { accounts: [] },
      GetCategories: CATEGORIES,
      GetTransactionsList: { allTransactions: { totalCount: 1, results: [{ id: "x1" }] } },
    }));
    const r = await run(stub, ["export"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).message).toContain("lack fields");
  });
});
