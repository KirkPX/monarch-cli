// The categories and tags commands. Handlers load only when a command runs.

import type { Command } from "commander";

export function registerCategories(program: Command): void {
  const merged = (opts: Record<string, unknown>) => ({ ...(program.opts() as Record<string, unknown>), ...opts }) as never;

  const cat = program.command("categories").description("List, add and remove categories");
  cat.command("list").description("Every category, with its group").action(async (opts) => {
    const { listCommand } = await import("../commands/categories.js");
    await listCommand(merged(opts));
  });
  cat.command("groups").description("The category groups (income, expense, transfer)").action(async (opts) => {
    const { groupsCommand } = await import("../commands/categories.js");
    await groupsCommand(merged(opts));
  });
  cat.command("create")
    .description("Add a category to a group")
    .requiredOption("--group <name-or-id>", "the group it goes in")
    .requiredOption("--name <name>", "the new category's name")
    .option("--icon <emoji>", "the icon Monarch shows (one emoji)")
    .option("--dry-run", "show what would be created and send nothing")
    .action(async (opts) => {
      const { createCommand } = await import("../commands/categories.js");
      await createCommand(merged(opts));
    });
  cat.command("delete <name-or-id>")
    .description("Remove a category")
    .option("--move-to <name-or-id>", "move its transactions to this category first")
    .option("--yes", "do not ask for confirmation")
    .option("--dry-run", "show what would be deleted and send nothing")
    .action(async (value: string, opts) => {
      const { deleteCommand } = await import("../commands/categories.js");
      await deleteCommand(value, merged(opts));
    });

  const tags = program.command("tags").description("List, add and remove tags");
  tags.command("list").description("Every tag, with how many transactions carry it").action(async (opts) => {
    const { listCommand } = await import("../commands/tags.js");
    await listCommand(merged(opts));
  });
  tags.command("create <name>")
    .description("Add a tag")
    .option("--color <hex>", "its colour, such as #19D2A5")
    .option("--dry-run", "show what would be created and send nothing")
    .action(async (name: string, opts) => {
      const { createCommand } = await import("../commands/tags.js");
      await createCommand(name, merged(opts));
    });
  tags.command("delete <name-or-id>")
    .description("Remove a tag from Monarch and from every transaction that carries it")
    .option("--yes", "do not ask for confirmation")
    .option("--dry-run", "show what would be deleted and send nothing")
    .action(async (value: string, opts) => {
      const { deleteCommand } = await import("../commands/tags.js");
      await deleteCommand(value, merged(opts));
    });
}
