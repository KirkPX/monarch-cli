// The budgets, cashflow and recurring commands. Handlers load only when a command runs.

import type { Command } from "commander";
import { parseCount, parseDate } from "../parse.js";

export function registerPlanning(program: Command): void {
  const merged = (opts: Record<string, unknown>) => ({ ...(program.opts() as Record<string, unknown>), ...opts }) as never;

  const budgets = program.command("budgets").description("Planned versus actual spending, and setting a plan");
  budgets.command("list")
    .description("Planned, actual and remaining per category, month by month")
    .option("--start <month>", "first month, YYYY-MM (default: this month)")
    .option("--end <month>", "last month, YYYY-MM (default: the first month)")
    .option("--all", "include categories with no plan and no spending")
    .action(async (opts) => {
      const { listCommand } = await import("../commands/budgets.js");
      await listCommand(merged(opts));
    });
  budgets.command("set")
    .description("Set the planned amount for one category or group in one month, and read it back")
    .option("--category <name-or-id>", "the category")
    .option("--group <name-or-id>", "the category group (when it is budgeted as a whole)")
    .option("--month <month>", "the month, YYYY-MM (default: this month)")
    .requiredOption("--amount <number>", "the planned amount; 0 removes the plan")
    .option("--apply-to-future", "also use this amount for every later month")
    .option("--dry-run", "show what would change and send nothing")
    .action(async (opts) => {
      const { setCommand } = await import("../commands/budgets.js");
      await setCommand(merged(opts));
    });

  const cash = program.command("cashflow").description("Income, spending and savings over a date range");
  cash.command("summary")
    .description("Income, spending, savings and savings rate (default: this month so far)")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .action(async (opts) => {
      const { summaryCommand } = await import("../commands/cashflow.js");
      await summaryCommand(merged(opts));
    });
  cash.command("detail")
    .description("The same, split by category group, category and merchant")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .option("--limit <n>", "rows per section in the terminal view (default 15)", parseCount)
    .action(async (opts) => {
      const { detailCommand } = await import("../commands/cashflow.js");
      await detailCommand(merged(opts));
    });

  const rec = program.command("recurring").description("Bills and income Monarch sees repeating");
  rec.command("list")
    .description("Recurring items due or paid in a date range (default: this month)")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .action(async (opts) => {
      const { listCommand } = await import("../commands/recurring.js");
      await listCommand(merged(opts));
    });
  rec.command("streams")
    .description("Every recurring pattern, with its next expected date")
    .option("--no-liabilities", "leave out loan and card payments Monarch reads from credit reports")
    .action(async (opts) => {
      const { streamsCommand } = await import("../commands/recurring.js");
      await streamsCommand(merged(opts));
    });
}
