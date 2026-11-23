// The transactions and export commands. Handlers are imported only when a command
// runs, so `monarch --help` stays fast.

import type { Command } from "commander";
import { parseCount, parseDate } from "../parse.js";

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerTransactions(program: Command): void {
  // Commander types parsed options loosely. Each handler declares the shape it reads,
  // and the command-wiring test proves every option it reads is declared here.
  const merged = (opts: Record<string, unknown>) => ({ ...(program.opts() as Record<string, unknown>), ...opts }) as never;
  const tx = program.command("transactions").description("List, read, change, create and delete transactions");

  tx.command("list")
    .description("List transactions, newest first")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .option("--account <id>", "only this account (repeatable)", collect)
    .option("--category <name-or-id>", "only this category (repeatable)", collect)
    .option("--tag <name-or-id>", "only this tag (repeatable)", collect)
    .option("--search <text>", "match merchant, notes and statement text")
    .option("--needs-review", "only transactions waiting for review")
    .option("--limit <n>", "at most this many (default 100)", parseCount)
    .option("--all", "every match, however many")
    .option("--full", "every field Monarch offers, not the short set")
    .action(async (opts) => {
      const { listCommand } = await import("../commands/transactions.js");
      await listCommand(merged(opts));
    });

  tx.command("get <id>")
    .description("Show one transaction with every field")
    .action(async (id: string, opts) => {
      const { getCommand } = await import("../commands/transactions.js");
      await getCommand(id, merged(opts));
    });

  tx.command("summary")
    .description("Totals: count, income, spending, first and last date")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .action(async (opts) => {
      const { summaryCommand } = await import("../commands/transactions.js");
      await summaryCommand(merged(opts));
    });

  tx.command("update <id>")
    .description("Change one transaction, check nobody changed it first, and read it back")
    .option("--category <name-or-id>", "new category")
    .option("--merchant <name>", "new merchant name")
    .option("--date <date>", "new date (YYYY-MM-DD)", parseDate)
    .option("--amount <number>", "new amount (spending is negative)")
    .option("--notes <text>", 'new notes ("" clears them)')
    .option("--tags <names>", 'the full set of tags, joined by "; " ("" clears them)')
    .option("--hide-from-reports <true|false>", "hide it from reports and budgets")
    .option("--needs-review <true|false>", "mark it as waiting for review, or not")
    .option("--reviewed <true|false>", "mark it reviewed, or not")
    .option("--expect <field=value>", "refuse unless the field holds this now (repeatable)", collect)
    .option("--dry-run", "show what would change and send nothing")
    .action(async (id: string, opts) => {
      const { updateCommand } = await import("../commands/transactions.js");
      await updateCommand(id, merged(opts));
    });

  tx.command("batch-update <file>")
    .description("Apply many changes from a JSON file (@path or - for stdin), stopping at the first failure")
    .option("--dry-run", "show what would change and send nothing")
    .option("--keep-going", "carry on after a conflict or failure")
    .action(async (file: string, opts) => {
      const { batchUpdateCommand } = await import("../commands/transactions.js");
      await batchUpdateCommand(file, merged(opts));
    });

  tx.command("create")
    .description("Add a transaction to a manual account")
    .requiredOption("--account <id>", "the account")
    .requiredOption("--date <date>", "the date (YYYY-MM-DD)", parseDate)
    .requiredOption("--amount <number>", "the amount (spending is negative)")
    .requiredOption("--merchant <name>", "the merchant name")
    .requiredOption("--category <name-or-id>", "the category")
    .option("--notes <text>", "notes")
    .option("--update-balance", "also change the account balance by this amount")
    .option("--dry-run", "show what would be created and send nothing")
    .action(async (opts) => {
      const { createCommand } = await import("../commands/transactions.js");
      await createCommand(merged(opts));
    });

  tx.command("delete <id>")
    .description("Delete a transaction")
    .option("--yes", "do not ask for confirmation")
    .option("--dry-run", "show what would be deleted and send nothing")
    .action(async (id: string, opts) => {
      const { deleteCommand } = await import("../commands/transactions.js");
      await deleteCommand(id, merged(opts));
    });

  program
    .command("export")
    .description("Download accounts, categories and every field of every transaction in a date range, as one JSON file")
    .option("--since <date>", "first date (default: 90 days ago)", parseDate)
    .option("--until <date>", "last date (default: today)", parseDate)
    .option("--out <path>", "write to this file instead of standard output")
    .action(async (opts) => {
      const { exportCommand } = await import("../commands/export.js");
      await exportCommand(merged(opts));
    });
}
