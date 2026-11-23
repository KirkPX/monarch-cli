// The splits and attachments commands. Handlers load only when a command runs.

import type { Command } from "commander";

export function registerSplits(program: Command): void {
  const merged = (opts: Record<string, unknown>) => ({ ...(program.opts() as Record<string, unknown>), ...opts }) as never;

  const splits = program.command("splits").description("Split one transaction into parts with their own categories");
  splits.command("show <transaction-id>").description("The parts a transaction is split into").action(async (id: string, opts) => {
    const { showCommand } = await import("../commands/splits.js");
    await showCommand(id, merged(opts));
  });
  splits.command("set <transaction-id> <file>")
    .description("Replace the parts from a JSON file (@path, a path, or - for stdin); they must add up exactly")
    .option("--dry-run", "check the parts and send nothing")
    .action(async (id: string, file: string, opts) => {
      const { setCommand } = await import("../commands/splits.js");
      await setCommand(id, file, merged(opts));
    });
  splits.command("clear <transaction-id>")
    .description("Remove the split, so the transaction is one line again")
    .option("--yes", "do not ask for confirmation")
    .option("--dry-run", "show what would change and send nothing")
    .action(async (id: string, opts) => {
      const { clearCommand } = await import("../commands/splits.js");
      await clearCommand(id, merged(opts));
    });

  const att = program.command("attachments").description("Receipts and other files on a transaction");
  att.command("list <transaction-id>").description("The files on a transaction").action(async (id: string, opts) => {
    const { listCommand } = await import("../commands/attachments.js");
    await listCommand(id, merged(opts));
  });
  att.command("add <transaction-id> <file>")
    .description("Attach an image or PDF to a transaction")
    .option("--dry-run", "check the file and send nothing")
    .action(async (id: string, file: string, opts) => {
      const { addCommand } = await import("../commands/attachments.js");
      await addCommand(id, file, merged(opts));
    });
}
