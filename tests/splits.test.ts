// Splits and attachments through the built CLI against a fake Monarch, and the
// upload transport on its own with a mocked fetch.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/client.js";
import { uploadFile, UPLOAD_URL } from "../src/client-upload.js";
import { addAttachment } from "../src/monarch/attachments.js";
import { startStub, type Stub, type StubCall } from "./stub.js";

const dist = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
const dir = mkdtempSync(path.join(tmpdir(), "monarch splits ü "));
let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dist, "--json", ...args], {
      env: {
        ...process.env,
        MONARCH_API_KEY: "test-token",
        MONARCH_BASE_URL: stub!.url,
        MONARCH_CLI_CONFIG_FILE: path.join(mkdtempSync(path.join(tmpdir(), "monarch cfg ")), "config.json"),
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

function file(name: string, body: string | Uint8Array): string {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  return p;
}

type Part = { id: string; amount: number; notes: string | null; merchant: { id: string; name: string }; category: { id: string; name: string } };

const CATS = [
  { id: "c1", name: "Groceries", group: { id: "g1", name: "Food", type: "expense" } },
  { id: "c2", name: "Household", group: { id: "g2", name: "Home", type: "expense" } },
];

/** A fake Monarch holding one -10.00 transaction. */
async function fake(opts: { split?: boolean; ignoreSet?: boolean; attachments?: { id: string; filename: string }[] } = {}) {
  let parts: Part[] = opts.split
    ? [
        { id: "s1", amount: -6, notes: null, merchant: { id: "m1", name: "Shop" }, category: { id: "c1", name: "Groceries" } },
        { id: "s2", amount: -4, notes: null, merchant: { id: "m1", name: "Shop" }, category: { id: "c2", name: "Household" } },
      ]
    : [];
  stub = await startStub((call: StubCall) => {
    const op = call.operationName;
    const v = (call.variables ?? {}) as Record<string, unknown>;
    const data = (d: unknown) => ({ body: { data: d } });
    if (op === "GetCategories") return data({ categories: CATS });
    if (op === "TransactionSplitQuery") {
      if (v.id !== "t1") return data({ getTransaction: null });
      return data({
        getTransaction: { id: "t1", amount: -10, hasSplitTransactions: parts.length > 0, category: CATS[0], merchant: { id: "m1", name: "Shop" }, splitTransactions: parts },
      });
    }
    if (op === "Common_SplitTransactionMutation") {
      const input = v.input as { splitData: { amount: number; categoryId: string }[] };
      if (!opts.ignoreSet) {
        parts = input.splitData.map((s, i) => ({
          id: `n${i}`,
          amount: s.amount,
          notes: null,
          merchant: { id: "m1", name: "Shop" },
          category: { id: s.categoryId, name: CATS.find((c) => c.id === s.categoryId)!.name },
        }));
      }
      return data({ updateTransactionSplit: { errors: null, transaction: { id: "t1", hasSplitTransactions: parts.length > 0, splitTransactions: parts } } });
    }
    if (op === "GetTransactionAttachments") return data({ getTransaction: { id: "t1", attachments: opts.attachments ?? [] } });
    return { body: { errors: [{ message: `no answer for ${op}` }] } };
  });
  return stub;
}

const splitCalls = (s: Stub) => s.calls.filter((c) => c.operationName === "Common_SplitTransactionMutation");

describe("splits", () => {
  it("shows the parts", async () => {
    await fake({ split: true });
    const d = JSON.parse((await run(["splits", "show", "t1"])).stdout);
    expect(d.splitTransactions.map((p: Part) => p.amount)).toEqual([-6, -4]);
  });

  it("refuses parts that do not add up, and a one-part split, before sending", async () => {
    const s = await fake();
    const bad = await run(["splits", "set", "t1", file("bad.json", JSON.stringify([{ amount: -6, category: "Groceries" }, { amount: -3, category: "Household" }]))]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stderr).message).toContain("add up to -9.00");
    const one = await run(["splits", "set", "t1", file("one.json", JSON.stringify([{ amount: -10, category: "Groceries" }]))]);
    expect(JSON.parse(one.stderr).message).toContain("at least two parts");
    expect(splitCalls(s)).toHaveLength(0);
  });

  it("adds cents exactly, so -0.1 and -9.9 make -10.00", async () => {
    const s = await fake();
    const { code } = await run(["splits", "set", "t1", file("cents.json", JSON.stringify([{ amount: -0.1, category: "c1" }, { amount: -9.9, category: "c2" }]))]);
    expect(code).toBe(0);
    expect(splitCalls(s)).toHaveLength(1);
  });

  it("sets parts by category name, keeps the merchant, and reads them back", async () => {
    const s = await fake();
    const { code, stdout } = await run(["splits", "set", "t1", `@${file("ok.json", JSON.stringify([{ amount: -6, category: "groceries", notes: "food" }, { amount: -4, category: "Household" }]))}`]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ changed: true });
    expect(splitCalls(s)[0]!.variables).toEqual({
      input: {
        transactionId: "t1",
        splitData: [
          { amount: -6, categoryId: "c1", merchantName: "Shop", notes: "food" },
          { amount: -4, categoryId: "c2", merchantName: "Shop" },
        ],
      },
    });
  });

  it("sends nothing on a dry run or under read-only", async () => {
    const s = await fake();
    const f = file("dry.json", JSON.stringify([{ amount: -6, category: "c1" }, { amount: -4, category: "c2" }]));
    expect(JSON.parse((await run(["splits", "set", "t1", f, "--dry-run"])).stdout)).toMatchObject({ dryRun: true, changed: false });
    expect((await run(["--read-only", "splits", "set", "t1", f])).code).toBe(1);
    expect(splitCalls(s)).toHaveLength(0);
  });

  it("fails when the parts do not read back", async () => {
    await fake({ ignoreSet: true });
    const f = file("lost.json", JSON.stringify([{ amount: -6, category: "c1" }, { amount: -4, category: "c2" }]));
    const { code, stderr } = await run(["splits", "set", "t1", f]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toContain("reads back");
  });

  it("names the problem in a file that is not a list of parts", async () => {
    await fake();
    const { stderr } = await run(["splits", "set", "t1", file("shape.json", JSON.stringify([{ amount: "six", category: "c1" }, { amount: -4, category: "c2" }]))]);
    expect(JSON.parse(stderr).message).toContain("0.amount");
  });

  it("clears only with --yes, and reports a transaction that is not split", async () => {
    const s = await fake({ split: true });
    const no = await run(["splits", "clear", "t1"]);
    expect(no.code).toBe(1);
    expect(JSON.parse(no.stdout)).toMatchObject({ aborted: true });
    expect(splitCalls(s)).toHaveLength(0);
    const yes = await run(["splits", "clear", "t1", "--yes"]);
    expect(yes.code).toBe(0);
    expect(splitCalls(s)[0]!.variables).toEqual({ input: { transactionId: "t1", splitData: [] } });
    const again = await run(["splits", "clear", "t1", "--yes"]);
    expect(JSON.parse(again.stdout)).toMatchObject({ changed: false });
  });

  it("says plainly when the transaction does not exist", async () => {
    await fake();
    const { code, stderr } = await run(["splits", "show", "missing"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toContain("no transaction missing");
  });
});

describe("attachments through the CLI", () => {
  it("lists the files on a transaction", async () => {
    await fake({ attachments: [{ id: "a1", filename: "r.png" }] });
    expect(JSON.parse((await run(["attachments", "list", "t1"])).stdout)).toHaveLength(1);
  });

  it("checks the file before asking Monarch for anything", async () => {
    const s = await fake();
    expect(JSON.parse((await run(["attachments", "add", "t1", path.join(dir, "nope.png")])).stderr).message).toContain("does not exist");
    expect(JSON.parse((await run(["attachments", "add", "t1", file("notes.txt", "x")])).stderr).message).toContain("images and PDFs");
    expect(JSON.parse((await run(["attachments", "add", "t1", file("empty.png", "")])).stderr).message).toContain("empty");
    expect(s.calls).toHaveLength(0);
  });

  it("sends nothing to the upload host on a dry run, or under read-only", async () => {
    const s = await fake();
    const png = file("r.png", new Uint8Array([137, 80, 78, 71]));
    expect(JSON.parse((await run(["attachments", "add", "t1", png, "--dry-run"])).stdout)).toMatchObject({ dryRun: true });
    expect((await run(["--read-only", "attachments", "add", "t1", png])).code).toBe(1);
    expect(s.calls.map((c) => c.operationName)).toEqual(["GetTransactionAttachments"]);
  });
});

describe("the upload transport", () => {
  const TICKET = { timestamp: 1, folder: "f", signature: "sig", api_key: "upload-key", upload_preset: "p" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const pdf = { name: "r.pdf", type: "application/pdf", data: new Uint8Array([1, 2, 3]) };

  it("never sends the Monarch token, or any Monarch header, to the upload host", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), init });
        const body = init.body as FormData | string;
        if (String(url).startsWith("https://api.cloudinary.com")) return json({ public_id: "pid", format: "pdf", bytes: 3 });
        const op = JSON.parse(body as string).operationName;
        if (op === "Common_GetTransactionAttachmentUploadInfo") return json({ data: { getTransactionAttachmentUploadInfo: { info: { path: "x", requestParams: TICKET } } } });
        return json({ data: { addTransactionAttachment: { errors: null, attachment: { id: "a1", publicId: "pid", extension: "pdf", sizeBytes: 3, filename: "r.pdf", originalAssetUrl: null } } } });
      })
    );
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:9", apiKey: "monarch-secret-token", deviceId: "dev-1" });
    const added = await addAttachment(client, "t1", pdf);
    expect(added.id).toBe("a1");
    const upload = seen.find((s) => s.url === UPLOAD_URL)!;
    expect(upload.init.headers).toBeUndefined();
    const fields = Object.fromEntries([...(upload.init.body as FormData).entries()].map(([k, v]) => [k, typeof v === "string" ? v : "(file)"]));
    expect(fields).toEqual({ file: "(file)", timestamp: "1", folder: "f", signature: "sig", api_key: "upload-key", upload_preset: "p" });
    expect(JSON.stringify(fields)).not.toContain("monarch-secret-token");
    const add = seen.find((s) => String(s.init.body).includes("Common_AddTransactionAttachment"))!;
    expect(JSON.parse(add.init.body as string).variables.input).toEqual({ transactionId: "t1", filename: "r.pdf", publicId: "pid", extension: "pdf", sizeBytes: 3 });
  });

  it("retries a 429 a bounded number of times, and never retries a 500", async () => {
    const busy = vi.fn(async () => json({ error: { message: "slow down" } }, 429));
    vi.stubGlobal("fetch", busy);
    await expect(uploadFile(pdf, TICKET, { retryDelayMs: 0, maxRetries: 3 })).rejects.toThrow("slow down");
    expect(busy).toHaveBeenCalledTimes(3);
    const broken = vi.fn(async () => json({ error: { message: "boom" } }, 500));
    vi.stubGlobal("fetch", broken);
    await expect(uploadFile(pdf, TICKET, { retryDelayMs: 0 })).rejects.toThrow("500");
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("stops at its time limit, and refuses a reply with no file id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))))
    );
    await expect(uploadFile(pdf, TICKET, { timeoutMs: 20 })).rejects.toThrow("timed out after 20ms");
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
    await expect(uploadFile(pdf, TICKET)).rejects.toThrow("no file id");
  });
});
