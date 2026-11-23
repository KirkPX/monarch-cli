// `monarch splits …`: see, replace or remove the parts a transaction is split into.
// Monarch replaces the whole set each time. The parts must add up to the
// transaction exactly; that is checked before anything is sent, and every change
// is read back.

import { z } from "zod";
import { UsageError } from "../../errors.js";
import { listCategories, resolveCategory } from "../../monarch/categories.js";
import { cents, checkSum, getSplits, setSplits, type SplitInput, type SplitView } from "../../monarch/splits.js";
import { createClient } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun, type GuardOptions } from "../guardrails.js";
import { reporter } from "../output.js";
import { readJsonBody } from "../read-file.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

function render(v: SplitView): string {
  const head = `${v.amount.toFixed(2)}  ${v.merchant?.name ?? ""}  (${v.category?.name ?? "no category"})  ${v.id}`;
  if (!v.splitTransactions.length) return `${head}\nNot split.`;
  return [
    head,
    ...v.splitTransactions.map(
      (s) => `  ${s.amount.toFixed(2).padStart(10)}  ${(s.merchant?.name ?? "").padEnd(24).slice(0, 24)}  ${(s.category?.name ?? "").padEnd(22).slice(0, 22)}  ${s.notes ?? ""}`
    ),
  ].join("\n");
}

export async function showCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  const v = await getSplits(createClient(opts), id);
  r.result(v, render(v));
}

const splitFile = z
  .array(
    z.strictObject({
      amount: z.number(),
      category: z.string().min(1),
      merchant: z.string().min(1).optional(),
      notes: z.string().optional(),
    })
  )
  .min(2, "a split needs at least two parts");

export async function setCommand(id: string, file: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const source = file === "-" || file.startsWith("@") ? file : `@${file}`;
  const parsed = splitFile.safeParse(await readJsonBody({ data: source }));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(
      `The split file is not a list of parts: ${issue?.path.join(".") || "file"}: ${issue?.message}.`,
      'Each part is {"amount": -12.50, "category": "Groceries", "merchant": "optional", "notes": "optional"}.'
    );
  }
  const client = createClient(opts);
  const before = await getSplits(client, id);
  const cats = await listCategories(client);
  const parts: SplitInput[] = parsed.data.map((p) => ({
    amount: cents(p.amount) / 100,
    categoryId: resolveCategory(cats, p.category).id,
    merchantName: p.merchant ?? before.merchant?.name ?? undefined,
    ...(p.notes !== undefined ? { notes: p.notes } : {}),
  }));
  checkSum(before.amount, parts);
  const summary = `${parts.length} parts on ${before.amount.toFixed(2)} ${before.merchant?.name ?? ""}`.trim();
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would split ${id} into ${summary}` }, true, r, { before, parts });
    return;
  }
  await setSplits(client, id, parts);
  const after = await getSplits(client, id);
  const want = parts.map((p) => `${cents(p.amount)}:${p.categoryId}`).sort();
  const got = after.splitTransactions.map((s) => `${cents(s.amount)}:${s.category?.id}`).sort();
  if (want.join(",") !== got.join(",")) {
    throw new UsageError(`Sent, but Monarch reads back ${after.splitTransactions.length} parts that differ from the ones sent.`);
  }
  printDryRun({ changed: true, summary: `Split ${id} into ${summary} (checked)` }, false, r, { transaction: after });
}

export async function clearCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const before = await getSplits(client, id);
  if (!before.splitTransactions.length) {
    printDryRun({ changed: false, summary: `${id} is not split` }, Boolean(opts.dryRun), r);
    return;
  }
  const what = `the ${before.splitTransactions.length} parts of ${before.amount.toFixed(2)} ${before.merchant?.name ?? ""}`.trim();
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would remove ${what}` }, true, r);
    return;
  }
  const ok = await confirmDestructive(`Remove ${what}?`, opts);
  if (!ok.confirmed) {
    r.result(abortOutcome(ok.reason, "Nothing changed."), "Nothing changed.");
    if (ok.reason === "needs-yes") process.exitCode = 1;
    return;
  }
  await setSplits(client, id, []);
  const after = await getSplits(client, id);
  if (after.splitTransactions.length) throw new UsageError(`Sent, but ${id} still reads back ${after.splitTransactions.length} parts.`);
  printDryRun({ changed: true, summary: `Removed ${what} (checked)` }, false, r, { transaction: after });
}
