// The accounts, institutions and holdings commands. Handlers are imported only
// when a command runs, so `monarch --help` stays fast.

import type { Command } from "commander";
import { parseCount, parseDate } from "../parse.js";

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerAccounts(program: Command): void {
  // Commander types parsed options loosely. Each handler declares the shape it reads,
  // and the command-wiring test proves every option it reads is declared here.
  const merged = (opts: Record<string, unknown>) => ({ ...(program.opts() as Record<string, unknown>), ...opts }) as never;
  const accounts = program.command("accounts").description("Balances, history, bank connections, refresh, and manual accounts");

  accounts
    .command("list")
    .description("Every account with its balance, bank and connection state")
    .option("--include-hidden", "include accounts hidden in Monarch")
    .action(async (opts) => {
      const { listCommand } = await import("../commands/accounts.js");
      await listCommand(merged(opts));
    });

  accounts
    .command("get <id>")
    .description("Show one account in detail")
    .action(async (id: string, opts) => {
      const { getCommand } = await import("../commands/accounts.js");
      await getCommand(id, merged(opts));
    });

  accounts
    .command("types")
    .description("The account types and subtypes Monarch accepts")
    .action(async (opts) => {
      const { typesCommand } = await import("../commands/accounts.js");
      await typesCommand(merged(opts));
    });

  accounts
    .command("history <id>")
    .description("One account's balance on each day Monarch recorded it")
    .option("--start <date>", "first date (YYYY-MM-DD)", parseDate)
    .option("--end <date>", "last date (YYYY-MM-DD)", parseDate)
    .action(async (id: string, opts) => {
      const { historyCommand } = await import("../commands/accounts.js");
      await historyCommand(id, merged(opts));
    });

  accounts
    .command("balances")
    .description("Every account's daily balance since a date")
    .option("--start <date>", "first date (default: 30 days ago)", parseDate)
    .action(async (opts) => {
      const { balancesCommand } = await import("../commands/accounts.js");
      await balancesCommand(merged(opts));
    });

  accounts
    .command("snapshots")
    .description("Total balance by account type, per month or year")
    .option("--start <date>", "first date (default: 1 January this year)", parseDate)
    .option("--timeframe <month|year>", "month (default) or year")
    .action(async (opts) => {
      const { snapshotsCommand } = await import("../commands/accounts.js");
      await snapshotsCommand(merged(opts));
    });

  accounts
    .command("net-worth")
    .description("Net worth on each day")
    .option("--start <date>", "first date (default: a year ago)", parseDate)
    .option("--end <date>", "last date (default: today)", parseDate)
    .option("--type <account-type>", "only this account type, for example brokerage")
    .action(async (opts) => {
      const { netWorthCommand } = await import("../commands/accounts.js");
      await netWorthCommand(merged(opts));
    });

  accounts
    .command("refresh-status")
    .description("Which accounts are out of date, and why: bank sign-in needed, disconnected, or stale")
    .option("--stale-days <n>", "call a linked account stale after this many days without an update (default 3)", parseCount)
    .action(async (opts) => {
      const { refreshStatusCommand } = await import("../commands/accounts.js");
      await refreshStatusCommand(merged(opts));
    });

  accounts
    .command("refresh [ids...]")
    .description("Ask Monarch to fetch new data from the banks now (default: every linked account)")
    .option("--wait", "wait until the refresh finishes")
    .option("--timeout <seconds>", "with --wait, give up after this long (default 300)", parseCount)
    .option("--interval <seconds>", "with --wait, check this often (default 5)", parseCount)
    .option("--dry-run", "show which accounts would be refreshed and send nothing")
    .action(async (ids: string[], opts) => {
      const { refreshCommand } = await import("../commands/accounts.js");
      await refreshCommand(ids, merged(opts));
    });

  accounts
    .command("create")
    .description("Create a manual account (one you keep up to date yourself)")
    .requiredOption("--type <type>", "account type, from `accounts types` (for example other_asset)")
    .requiredOption("--subtype <subtype>", "account subtype, from `accounts types` (for example other)")
    .requiredOption("--name <name>", "the account name")
    .option("--balance <number>", "the starting balance (default 0)")
    .option("--exclude-from-net-worth", "leave it out of net worth")
    .option("--dry-run", "show what would be created and send nothing")
    .action(async (opts) => {
      const { createCommand } = await import("../commands/accounts.js");
      await createCommand(merged(opts));
    });

  accounts
    .command("update <id>")
    .description("Change an account, and read it back to check")
    .option("--name <name>", "new name")
    .option("--balance <number>", "new balance (manual accounts)")
    .option("--type <type>", "new account type")
    .option("--subtype <subtype>", "new account subtype")
    .option("--in-net-worth <true|false>", "count it in net worth")
    .option("--hide <true|false>", "hide it from the accounts list")
    .option("--hide-transactions <true|false>", "leave its transactions out of budgets and reports")
    .option("--dry-run", "show what would change and send nothing")
    .action(async (id: string, opts) => {
      const { updateCommand } = await import("../commands/accounts.js");
      await updateCommand(id, merged(opts));
    });

  accounts
    .command("delete <id>")
    .description("Delete an account and its transactions")
    .option("--yes", "do not ask for confirmation")
    .option("--dry-run", "show what would be deleted and send nothing")
    .action(async (id: string, opts) => {
      const { deleteCommand } = await import("../commands/accounts.js");
      await deleteCommand(id, merged(opts));
    });

  program
    .command("institutions")
    .description("Bank connections")
    .command("list")
    .description("Each bank connection, its status, when it last updated, and its accounts")
    .action(async (opts) => {
      const { institutionsCommand } = await import("../commands/institutions.js");
      await institutionsCommand(merged(opts));
    });

  program
    .command("holdings")
    .description("Investment holdings")
    .command("list")
    .description("What each investment account holds, valued today")
    .option("--account <id>", "only this account (repeatable; default: every brokerage account)", collect)
    .action(async (opts) => {
      const { holdingsCommand } = await import("../commands/holdings.js");
      await holdingsCommand(merged(opts));
    });
}
