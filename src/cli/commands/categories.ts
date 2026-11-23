// `monarch categories …`: list categories and their groups, add one, remove one.
// Each change is read back before it is reported.

import { UsageError } from "../../errors.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  listCategoryGroups,
  resolveCategory,
  resolveGroup,
} from "../../monarch/categories.js";
import { createClient } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun, type GuardOptions } from "../guardrails.js";
import { reporter } from "../output.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

export async function listCommand(opts: Common): Promise<void> {
  const r = reporter(opts);
  const cats = await listCategories(createClient(opts));
  const sorted = [...cats].sort(
    (a, b) => (a.group?.type ?? "").localeCompare(b.group?.type ?? "") || (a.group?.name ?? "").localeCompare(b.group?.name ?? "") || a.name.localeCompare(b.name)
  );
  r.result(
    sorted,
    sorted.length
      ? sorted.map((c) => `${(c.group?.type ?? "").padEnd(8)} ${(c.group?.name ?? "").padEnd(24).slice(0, 24)} ${c.name.padEnd(30).slice(0, 30)} ${c.id}`).join("\n")
      : "No categories."
  );
}

export async function groupsCommand(opts: Common): Promise<void> {
  const r = reporter(opts);
  const groups = await listCategoryGroups(createClient(opts));
  r.result(groups, groups.length ? groups.map((g) => `${g.type.padEnd(8)} ${g.name.padEnd(30).slice(0, 30)} ${g.id}`).join("\n") : "No groups.");
}

export async function createCommand(opts: Common & { group: string; name: string; icon?: string }): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const name = opts.name.trim();
  if (!name) throw new UsageError("--name cannot be empty.");
  const client = createClient(opts);
  const group = resolveGroup(await listCategoryGroups(client), opts.group);
  const existing = (await listCategories(client)).filter((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing.length) {
    printDryRun({ changed: false, summary: `A category called "${name}" already exists (${existing[0]!.id})` }, false, r, { category: existing[0] });
    return;
  }
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would create category "${name}" in ${group.name}` }, true, r);
    return;
  }
  const created = await createCategory(client, { groupId: group.id, name, icon: opts.icon });
  const back = (await listCategories(client)).find((c) => c.id === created.id);
  if (!back) throw new UsageError(`Monarch said it created "${name}", but it does not read back.`);
  printDryRun({ changed: true, summary: `Created category "${back.name}" in ${group.name} (${back.id})` }, false, r, { category: back });
}

export async function deleteCommand(value: string, opts: Common & { moveTo?: string }): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const client = createClient(opts);
  const cats = await listCategories(client);
  const cat = resolveCategory(cats, value);
  if (cat.isSystemCategory) throw new UsageError(`"${cat.name}" is one of Monarch's own categories and cannot be deleted.`);
  const moveTo = opts.moveTo ? resolveCategory(cats, opts.moveTo) : undefined;
  if (moveTo?.id === cat.id) throw new UsageError("--move-to must be a different category.");
  const what = `category "${cat.name}"${moveTo ? `, moving its transactions to "${moveTo.name}"` : ""}`;
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
  await deleteCategory(client, cat.id, moveTo?.id);
  if ((await listCategories(client)).some((c) => c.id === cat.id)) {
    throw new UsageError(`Monarch said it deleted "${cat.name}", but it still reads back.`);
  }
  printDryRun({ changed: true, summary: `Deleted ${what}` }, false, r, { id: cat.id });
}
