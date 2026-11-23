// Categories and tags, driven through the built CLI against a fake Monarch.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStub, type Stub, type StubCall } from "./stub.js";

const dist = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dist, "--json", ...args], {
      env: {
        ...process.env,
        MONARCH_API_KEY: "test-token",
        MONARCH_BASE_URL: stub!.url,
        MONARCH_CLI_CONFIG_FILE: path.join(mkdtempSync(path.join(tmpdir(), "monarch cat ü ")), "config.json"),
        ...env,
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

const GROUPS = [
  { id: "g1", name: "Food", order: 1, type: "expense", updatedAt: null, createdAt: null },
  { id: "g2", name: "Income", order: 2, type: "income", updatedAt: null, createdAt: null },
];

type Cat = { id: string; name: string; isSystemCategory: boolean; group: { id: string; name: string; type: string } };

/** A fake Monarch whose category and tag lists change when the mutations run. */
async function fake(opts: { createErrors?: unknown; keepAfterDelete?: boolean; dropAfterCreate?: boolean } = {}) {
  const cats: Cat[] = [
    { id: "c1", name: "Groceries", isSystemCategory: false, group: { id: "g1", name: "Food", type: "expense" } },
    { id: "c2", name: "Paychecks", isSystemCategory: true, group: { id: "g2", name: "Income", type: "income" } },
  ];
  const tags = [{ id: "t1", name: "Business", color: "#111111", order: 1, transactionCount: 3 }];
  stub = await startStub((call: StubCall) => {
    const op = call.operationName;
    const v = call.variables ?? {};
    const data = (d: unknown) => ({ body: { data: d } });
    if (op === "GetCategories") return data({ categories: cats });
    if (op === "ManageGetCategoryGroups") return data({ categoryGroups: GROUPS });
    if (op === "GetHouseholdTransactionTags") return data({ householdTransactionTags: tags });
    if (op === "Web_CreateCategory") {
      if (opts.createErrors) return data({ createCategory: { errors: opts.createErrors, category: null } });
      const input = v.input as { name: string; group: string };
      const c = { id: "c9", name: input.name, isSystemCategory: false, group: { id: input.group, name: "Food", type: "expense" } };
      if (!opts.dropAfterCreate) cats.push(c);
      return data({ createCategory: { errors: null, category: c } });
    }
    if (op === "Web_DeleteCategory") {
      if (!opts.keepAfterDelete) cats.splice(cats.findIndex((c) => c.id === v.id), 1);
      return data({ deleteCategory: { errors: null, deleted: true } });
    }
    if (op === "Common_CreateTransactionTag") {
      const input = v.input as { name: string; color: string };
      const t = { id: "t9", name: input.name, color: input.color, order: 2, transactionCount: 0 };
      tags.push(t);
      return data({ createTransactionTag: { tag: t, errors: null } });
    }
    if (op === "Common_DeleteTransactionTag") {
      tags.splice(tags.findIndex((t) => t.id === v.tagId), 1);
      return data({ deleteTransactionTag: { errors: null } });
    }
    return { body: { errors: [{ message: `no answer for ${op}` }] } };
  });
  return stub;
}

const mutations = (s: Stub) => s.calls.filter((c) => /^(Web_Create|Web_Delete|Common_Create|Common_Delete)/.test(c.operationName ?? ""));

describe("categories", () => {
  it("lists categories with their group, and the groups", async () => {
    await fake();
    const list = await run(["categories", "list"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).map((c: Cat) => c.name)).toEqual(["Groceries", "Paychecks"]);
    const groups = await run(["categories", "groups"]);
    expect(JSON.parse(groups.stdout)).toHaveLength(2);
  });

  it("creates a category in a group named in any case, and reads it back", async () => {
    const s = await fake();
    const { code, stdout } = await run(["categories", "create", "--group", "food", "--name", "Coffee"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ changed: true, category: { id: "c9", name: "Coffee" } });
    expect(mutations(s)[0]!.variables).toMatchObject({ input: { group: "g1", name: "Coffee" } });
  });

  it("sends nothing on a dry run, under read-only, or when the name exists", async () => {
    const s = await fake();
    const dry = await run(["categories", "create", "--group", "Food", "--name", "Coffee", "--dry-run"]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, changed: false });
    const ro = await run(["--read-only", "categories", "create", "--group", "Food", "--name", "Coffee"]);
    expect(ro.code).toBe(1);
    expect(JSON.parse(ro.stderr).message).toContain("Read-only");
    const same = await run(["categories", "create", "--group", "Food", "--name", "groceries"]);
    expect(JSON.parse(same.stdout)).toMatchObject({ changed: false });
    expect(mutations(s)).toHaveLength(0);
  });

  it("fails when Monarch refuses, or when the new category does not read back", async () => {
    await fake({ createErrors: { message: "Name taken", code: "BAD", fieldErrors: [] } });
    const refused = await run(["categories", "create", "--group", "Food", "--name", "X"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).message).toContain("Name taken");
    await stub!.close();
    await fake({ dropAfterCreate: true });
    const lost = await run(["categories", "create", "--group", "Food", "--name", "X"]);
    expect(lost.code).toBe(1);
    expect(JSON.parse(lost.stderr).message).toContain("does not read back");
  });

  it("refuses a delete without --yes, then deletes with it, moving transactions", async () => {
    const s = await fake();
    const no = await run(["categories", "delete", "Groceries"]);
    expect(no.code).toBe(1);
    expect(JSON.parse(no.stdout)).toMatchObject({ aborted: true, changed: false });
    expect(mutations(s)).toHaveLength(0);
    const yes = await run(["categories", "delete", "Groceries", "--move-to", "c2", "--yes"]);
    expect(yes.code).toBe(0);
    expect(mutations(s)[0]!.variables).toEqual({ id: "c1", moveToCategoryId: "c2" });
  });

  it("will not delete one of Monarch's own categories, and fails when a delete does not take", async () => {
    await fake({ keepAfterDelete: true });
    const system = await run(["categories", "delete", "Paychecks", "--yes"]);
    expect(JSON.parse(system.stderr).message).toContain("cannot be deleted");
    const stuck = await run(["categories", "delete", "Groceries", "--yes"]);
    expect(stuck.code).toBe(1);
    expect(JSON.parse(stuck.stderr).message).toContain("still reads back");
  });
});

describe("tags", () => {
  it("lists, creates with read-back, and deletes with --yes", async () => {
    const s = await fake();
    expect(JSON.parse((await run(["tags", "list"])).stdout)).toHaveLength(1);
    const made = await run(["tags", "create", "Travel", "--color", "#AABBCC"]);
    expect(JSON.parse(made.stdout)).toMatchObject({ changed: true, tag: { name: "Travel", color: "#AABBCC" } });
    const no = await run(["tags", "delete", "travel"]);
    expect(no.code).toBe(1);
    const gone = await run(["tags", "delete", "travel", "--yes"]);
    expect(gone.code).toBe(0);
    expect(s.calls.find((c) => c.operationName === "Common_DeleteTransactionTag")!.variables).toEqual({ tagId: "t9" });
  });

  it("refuses a bad colour and an unknown tag before sending anything", async () => {
    const s = await fake();
    const color = await run(["tags", "create", "X", "--color", "red"]);
    expect(JSON.parse(color.stderr).message).toContain("--color");
    const unknown = await run(["tags", "delete", "Nope", "--yes"]);
    expect(JSON.parse(unknown.stderr).message).toContain("No tag called");
    expect(mutations(s)).toHaveLength(0);
  });
});
