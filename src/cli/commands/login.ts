// `monarch login` signs in the way Monarch's own app does: email, password, then
// the 6-digit code Monarch emails (or an authenticator code) when it asks for one.
// The token Monarch returns is checked against the API, then saved.
//
// With nobody at the keyboard: give the password on stdin (--password-stdin) or in
// MONARCH_PASSWORD, and either pass --code, or name a program that prints the code
// (`codeCommand` setting, or --code-command).
//
// `login --paste` stores a token copied from elsewhere instead.

import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { getCredentialStore, storeLabel, type StoreKind } from "../../auth.js";
import { ApiClient } from "../../client.js";
import { resolveConfig } from "../../config.js";
import { ApiError, LoginError, UsageError } from "../../errors.js";
import { runCodeCommand, signIn, type CodeKind } from "../../login/monarch.js";
import { promptLine, promptSecret } from "../../login/prompt.js";
import { getMe } from "../../monarch/me.js";
import { loadSettings, updateSettings } from "../../settings.js";
import { reporter } from "../output.js";

export type LoginOpts = {
  json?: boolean;
  paste?: boolean;
  force?: boolean;
  account?: string;
  email?: string;
  passwordStdin?: boolean;
  code?: string;
  codeCommand?: string;
};

type Verified = {
  account: string;
  identity: string | null;
  credentialStore: StoreKind;
  tokenExpiration?: string | null;
};

export async function loginCommand(opts: LoginOpts = {}): Promise<void> {
  const r = reporter(opts);
  const cfg = resolveConfig({ account: opts.account });

  if (!opts.force && cfg.apiKey) {
    r.result(
      { loggedIn: true, account: cfg.account, changed: false },
      `Already signed in (${cfg.account}).\n` + pc.dim("Run `monarch login --force` to sign in again.")
    );
    return;
  }

  const verified = opts.paste ? await pasteLogin(cfg) : await passwordLogin(cfg, opts, r.note);

  const { persistent } = getCredentialStore();
  if (!persistent) {
    r.warn(pc.yellow("Warning: this token will not persist after the process exits. Use MONARCH_API_KEY for automation."));
  }
  r.result(
    { loggedIn: true, ...verified, persistent },
    `${pc.green("Signed in")}${verified.identity ? ` as ${verified.identity}` : ""}.\n` +
      pc.dim(`Token saved to your ${storeLabel(verified.credentialStore)}.`) +
      (verified.tokenExpiration ? pc.dim(`\nMonarch says it expires ${verified.tokenExpiration}.`) : "") +
      "\n\nTry it: " +
      pc.cyan("monarch accounts list")
  );
}

export async function logoutCommand(opts: LoginOpts = {}): Promise<void> {
  const { account } = resolveConfig({ account: opts.account });
  getCredentialStore().deleteApiKey(account);
  reporter(opts).result({ cleared: true, account }, pc.green(`Signed out (${account}).`));
}

/** True when a usable token is already on hand. */
export function isConfigured(): boolean {
  return Boolean(resolveConfig().apiKey);
}

type Cfg = ReturnType<typeof resolveConfig>;

async function passwordLogin(cfg: Cfg, opts: LoginOpts, note: (m: string) => void): Promise<Verified> {
  const settings = loadSettings();
  const interactive = process.stdin.isTTY === true;

  const email = (opts.email || env("MONARCH_EMAIL") || settings.email || (interactive ? await promptLine("Monarch email: ") : "")).trim();
  if (!email) {
    throw new UsageError("No email given.", "Pass --email, set MONARCH_EMAIL, or run `monarch config set email <address>`.");
  }

  let password = env("MONARCH_PASSWORD") ?? "";
  if (opts.passwordStdin) password = await promptSecret("");
  else if (!password) {
    if (!interactive) {
      throw new UsageError("No password given.", "Pipe it in with --password-stdin, or set MONARCH_PASSWORD.");
    }
    password = await promptSecret("Monarch password: ");
  }
  if (!password) throw new LoginError("Nothing entered for the password.");

  const deviceId = settings.deviceId ?? randomUUID();
  if (!settings.deviceId) updateSettings({ deviceId });

  const base = { baseUrl: cfg.baseUrl, deviceId, email, password, timeoutMs: cfg.timeoutMs };
  const given = opts.code?.trim();
  let result = await signIn(given ? { ...base, code: { kind: "email", value: given } } : base);

  if (result.status === "code-needed") {
    const kind: CodeKind = result.kind;
    if (given && kind === "totp") {
      // The code was sent as an emailed code, but Monarch wants an authenticator code.
      result = await signIn({ ...base, code: { kind, value: given } });
    } else if (given) {
      throw new LoginError("Monarch asked for a new code.", "Run `monarch login` again and use the newest code.");
    } else {
      const code = await getCode(kind, email, opts, settings.codeCommand, interactive, note);
      result = await signIn({ ...base, code: { kind, value: code } });
    }
  }
  if (result.status !== "ok") {
    throw new LoginError("Monarch did not accept the code.", "Run `monarch login` again for a new code.");
  }

  const verified = await verify(result.token, cfg);
  if (settings.email !== email) updateSettings({ email });
  return { ...verified, tokenExpiration: result.tokenExpiration };
}

async function getCode(
  kind: CodeKind,
  email: string,
  opts: LoginOpts,
  fromSettings: string | undefined,
  interactive: boolean,
  note: (m: string) => void
): Promise<string> {
  const what = kind === "email" ? `the 6-digit code Monarch just emailed to ${email}` : "the code from your authenticator app";
  const program = opts.codeCommand || fromSettings;
  if (program && kind === "email") {
    note(`Monarch emailed a code. Waiting for ${program} to find it…`);
    return await runCodeCommand(program);
  }
  if (!interactive) {
    throw new LoginError(
      `Monarch wants ${what}.`,
      "Run `monarch login --code <code>` within a few minutes, or set a code program: `monarch config set codeCommand <path>`."
    );
  }
  const code = (await promptLine(`Enter ${what}: `)).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new LoginError(`"${code}" is not a 6-digit code.`, "Run `monarch login` again.");
  return code;
}

async function pasteLogin(cfg: Cfg): Promise<Verified> {
  const token = await promptSecret("Paste your Monarch token: ");
  if (!token) throw new LoginError("Nothing entered.");
  return await verify(token, cfg);
}

/** Prove the token works, THEN store it. Storing first would report a typo as success. */
async function verify(credential: string, cfg: Cfg): Promise<Verified> {
  const token = credential.trim();
  if (!token) throw new LoginError("Nothing entered.");
  const client = new ApiClient({ baseUrl: cfg.baseUrl, apiKey: token, timeoutMs: cfg.timeoutMs, deviceId: cfg.deviceId });
  let identity: string | null;
  try {
    const me = await getMe(client);
    identity = me.email || me.name || null;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw new LoginError(`Monarch refused that token for ${cfg.baseUrl}.`, "Sign in with email and password instead: `monarch login`.");
    }
    throw error;
  }
  const store = getCredentialStore();
  const credentialStore = store.setApiKey(cfg.account, token) ?? store.kind;
  return { account: cfg.account, identity, credentialStore };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}
