// `monarch tags …`: list tags, add one, remove one. Each change is read back.

import { UsageError } from "../../errors.js";
import { createTag, deleteTag, listTags, resolveTags } from "../../monarch/tags.js";
import { createClient } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun, type GuardOptions } from "../guardrails.js";
import { reporter } from "../output.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

export async function listCommand(opts: Common): Promise<void> {
  const r = reporter(opts);
  const tags = await listTags(createClient(opts));
  r.result(
    tags,
    tags.length ? tags.map((t) => `${t.name.padEnd(30).slice(0, 30)} ${String(t.transactionCount ?? "").padStart(6)}  ${t.color ?? ""}  ${t.id}`).join("\n") : "No tags."
  );
}

export async function createCommand(name: string, opts: Common & { color?: string }): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const clean = name.trim();
  if (!clean) throw new UsageError("The tag name cannot be empty.");
  const color = opts.color ?? "#19D2A5";
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new UsageError(`--color takes a colour such as #19D2A5, not "${color}".`);
  const client = createClient(opts);
  const existing = (await listTags(client)).find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    printDryRun({ changed: false, summary: `A tag called "${existing.name}" already exists (${existing.id})` }, false, r, { tag: existing });
    return;
  }
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would create tag "${clean}"` }, true, r);
    return;
  }
  const tag = await createTag(client, clean, color);
  const back = (await listTags(client)).find((t) => t.id === tag.id);
  if (!back) throw new UsageError(`Monarch said it created "${clean}", but it does not read back.`);
  printDryRun({ changed: true, summary: `Created tag "${back.name}" (${back.id})` }, false, r, { tag: back });
}

export async function deleteCommand(value: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const [tag] = resolveTags(await listTags(client), [value]);
  const what = `tag "${tag!.name}" (on ${tag!.transactionCount ?? 0} transactions)`;
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would delete ${what}` }, true, r);
    return;
  }
  const ok = await confirmDestructive(`Delete ${what}?`, opts);
  if (!ok.confirmed) {
    r.result(abortOutcome(ok.reason, "Nothing deleted."), "Nothing deleted.");
    if (ok.reason === "needs-yes") process.exitCode = 1;
    return;
  }
  await deleteTag(client, tag!.id);
  if ((await listTags(client)).some((t) => t.id === tag!.id)) {
    throw new UsageError(`Monarch said it deleted "${tag!.name}", but it still reads back.`);
  }
  printDryRun({ changed: true, summary: `Deleted ${what}` }, false, r, { id: tag!.id });
}
