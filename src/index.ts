#!/usr/bin/env node
import { Command } from "commander";
import { registerAccounts } from "./cli/registry/accounts.js";
import { registerCategories } from "./cli/registry/categories.js";
import { registerPlanning } from "./cli/registry/planning.js";
import { registerSplits } from "./cli/registry/splits.js";
import { registerTransactions } from "./cli/registry/transactions.js";

// Exit cleanly when the reader closes the pipe early (`monarch doctor | head -1`).
// Without this, the next write raises an uncaught EPIPE, and the CLI dies with a
// stack trace and a non-zero exit. Any other stream error still propagates.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

const program = new Command();

// Commander's own errors (a missing option, an unknown command) follow the output
// contract too: one JSON object on stderr when the output is JSON. This is set
// before any subcommand is added, because each subcommand copies it when created.
program.configureOutput({
  outputError: (text, write) => {
    const json = process.argv.includes("--json") || !process.stdout.isTTY;
    if (!json) return write(text);
    const message = text.replace(/^error: /, "").trim();
    write(JSON.stringify({ error: true, message, hint: "Run the command with --help to see its options." }) + "\n");
  },
});

// --json is declared once, here on the root. Commander still accepts it after a
// subcommand (`monarch whoami --json`), and each action merges
// `program.opts()` so the value reaches the handler. Declaring it again on a
// subcommand would bind each copy to its own command, and the handler would read
// whichever object is empty.
program
  .name("monarch")
  .description("Monarch Money from the terminal: download, categorise and write back safely")
  .version("0.1.0")
  .option("--json", "emit machine-readable JSON")
  .option("--read-only", "refuse any command that would change remote data")
  .option("--verbose", "emit diagnostic details");

// Running `monarch` bare should do the obvious thing: sign you in if you
// never have, and otherwise show what you can do.
program.action(async () => {
  const { isConfigured, loginCommand } = await import("./cli/commands/login.js");
  if (isConfigured()) {
    program.help();
    return;
  }
  const { reporter } = await import("./cli/output.js");
  reporter(program.opts()).note("Welcome to monarch. Let's connect your account.\n");
  await loginCommand(program.opts());
});

program
  .command("login")
  .description("Sign in with your Monarch email and password (and the code Monarch emails)")
  .option("--email <address>", "Monarch email (default: the saved one, or MONARCH_EMAIL)")
  .option("--password-stdin", "Read the password from standard input")
  .option("--code <code>", "The 6-digit code Monarch emailed or your authenticator shows")
  .option("--code-command <path>", "A program that prints the emailed code (no arguments)")
  .option("--paste", "Paste a Monarch token instead of signing in with a password")
  .option("--force", "Sign in again, even if already signed in")
  .option("--account <name>", "Named account (default: default)")
  .action(async (opts) => {
    const { loginCommand } = await import("./cli/commands/login.js");
    await loginCommand({ ...program.opts(), ...opts });
  });

program
  .command("logout")
  .description("Sign out and clear the stored credential")
  .option("--account <name>", "Named account (default: default)")
  .action(async (opts) => {
    const { logoutCommand } = await import("./cli/commands/login.js");
    await logoutCommand({ ...program.opts(), ...opts });
  });

program
  .command("doctor")
  .description("Check the install, the settings file and the credential store")
  .option("--install", "Close with an install verdict (used by `npm run setup`)")
  .action(async (opts) => {
    const { doctorCommand } = await import("./cli/commands/doctor.js");
    await doctorCommand({ ...program.opts(), ...opts });
  });

const configCmd = program
  .command("config")
  .description("Inspect and change the settings file");

configCmd
  .command("path")
  .description("Print where the settings file lives")
  .action(async (opts) => {
    const { configPath } = await import("./cli/commands/config.js");
    await configPath({ ...program.opts(), ...opts });
  });

configCmd
  .command("show")
  .description("Validate the settings file and print it")
  .action(async (opts) => {
    const { configShow } = await import("./cli/commands/config.js");
    await configShow({ ...program.opts(), ...opts });
  });

configCmd
  .command("set <name> <value>")
  .description("Set one setting, for example `config set readOnly true`")
  .action(async (name: string, value: string, opts) => {
    const { configSet } = await import("./cli/commands/config.js");
    await configSet(name, value, { ...program.opts(), ...opts });
  });

configCmd
  .command("unset <name>")
  .description("Remove one setting")
  .action(async (name: string, opts) => {
    const { configUnset } = await import("./cli/commands/config.js");
    await configUnset(name, { ...program.opts(), ...opts });
  });

program
  .command("auth")
  .description("Manage the stored API key from a script")
  .option("--status", "Show current auth status (default)")
  .option("--login", "Store an API key")
  .option("--logout", "Clear the stored API key")
  .option("--api-key <key>", "API key to store")
  .option("--account <name>", "Named account (default: default)")
  .action(async (opts) => {
    const { authCommand } = await import("./cli/commands/auth.js");
    await authCommand({ ...program.opts(), ...opts });
  });

program
  .command("whoami")
  .description("Show which Monarch user the saved token belongs to")
  .option("--account <name>", "Named account (default: default)")
  .option("--base-url <url>", "API base URL")
  .action(async (opts) => {
    const { whoamiCommand } = await import("./cli/commands/whoami.js");
    await whoamiCommand({ ...program.opts(), ...opts });
  });

// Each group of Monarch commands is registered from its own file in src/cli/registry/.
// Commands that change data go through src/cli/guardrails.ts (assertWritable,
// confirmDestructive, printDryRun) and read what they changed back.
registerTransactions(program);
registerAccounts(program);
registerCategories(program);
registerPlanning(program);
registerSplits(program);

program.parseAsync(process.argv).catch(async (error: unknown) => {
  const { resolveFormat } = await import("./cli/output.js");
  const { InterruptedError, safeErrorMessage } = await import("./errors.js");

  // Ctrl-C at a prompt: a person is at the terminal and knows why it stopped.
  if (error instanceof InterruptedError) {
    console.error(error.message);
    process.exitCode = 130;
    return;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const message = safeErrorMessage(raw);
  // Login and config failures carry a next step. Printing the cause without it
  // leaves the user guessing.
  const rawHint = (error as { hint?: unknown })?.hint;
  const hint = typeof rawHint === "string" && rawHint ? rawHint : undefined;

  // --verbose adds the stack. In json it goes INSIDE the envelope, not as a
  // second stderr write, so stderr stays parseable as one object.
  const verbose = Boolean(program.opts().verbose);
  const stack = verbose && error instanceof Error ? error.stack : undefined;

  if (resolveFormat(program.opts()) === "json") {
    console.error(
      JSON.stringify({
        error: true,
        message,
        ...(hint ? { hint } : {}),
        ...(stack ? { stack: safeErrorMessage(stack) } : {}),
      })
    );
  } else {
    console.error(`Error: ${message}`);
    if (hint) console.error(hint);
    if (stack) console.error(safeErrorMessage(stack));
  }

  // exitCode, not process.exit: exit() can cut off output still buffered for a pipe.
  process.exitCode = 1;
});
