// Monarch's sign-in: email and password, then a 6-digit code when Monarch asks for
// one. This is the route Monarch's own web app uses.
//
// What Monarch expects (read from its web app):
//   * POST /auth/login/ must say the client supports MFA, emailed codes and
//     reCAPTCHA. Without those flags Monarch answers 403 "Please update to the
//     latest version of the app".
//   * The first call answers 403 with error_code EMAIL_OTP_REQUIRED and emails a
//     code, or MFA_REQUIRED for an authenticator-app code. The second call adds
//     the code. The reply holds `token`, sent later as "Authorization: Token <token>".
//   * Monarch skips the code for a device it has seen, so the CLI sends the same
//     device id each time (`deviceId` in the settings file).

import { spawn } from "node:child_process";
import { ApiClient } from "../client.js";
import { ConfigError, LoginError } from "../errors.js";

export type CodeKind = "email" | "totp";

export type SignInResult =
  | { status: "ok"; token: string; tokenExpiration: string | null }
  | { status: "code-needed"; kind: CodeKind };

type LoginReply = {
  token?: unknown;
  tokenExpiration?: unknown;
  error_code?: unknown;
  detail?: unknown;
};

export async function signIn(opts: {
  baseUrl: string;
  deviceId: string;
  email: string;
  password: string;
  code?: { kind: CodeKind; value: string };
  timeoutMs?: number;
}): Promise<SignInResult> {
  const client = new ApiClient({ baseUrl: opts.baseUrl, apiKey: "", deviceId: opts.deviceId, timeoutMs: opts.timeoutMs });
  const body: Record<string, unknown> = {
    username: opts.email,
    password: opts.password,
    supports_mfa: true,
    supports_email_otp: true,
    supports_recaptcha: true,
    trusted_device: true,
  };
  if (opts.code) body[opts.code.kind === "email" ? "email_otp" : "totp"] = opts.code.value;

  const { status, data } = await client.request<LoginReply>("/auth/login/", {
    method: "POST",
    body,
    headers: { "Monarch-Client": "monarch-core-web-app-rest" },
    acceptStatus: [400, 401, 403, 404],
  });
  const reply = data ?? {};
  if (status === 200 && typeof reply.token === "string" && reply.token) {
    return {
      status: "ok",
      token: reply.token,
      tokenExpiration: typeof reply.tokenExpiration === "string" ? reply.tokenExpiration : null,
    };
  }
  if (reply.error_code === "EMAIL_OTP_REQUIRED") return { status: "code-needed", kind: "email" };
  if (reply.error_code === "MFA_REQUIRED") return { status: "code-needed", kind: "totp" };

  const detail = typeof reply.detail === "string" ? reply.detail : "";
  if (opts.code) {
    throw new LoginError(
      `Monarch refused the code${detail ? `: ${detail}` : ""}.`,
      "Codes expire after a few minutes. Run `monarch login` again for a new one."
    );
  }
  throw new LoginError(
    `Monarch refused the sign-in for ${opts.email}${detail ? `: ${detail}` : ` (HTTP ${status})`}.`,
    "Check the email and password. Or sign in with a token you copied: `monarch login --paste`."
  );
}

/**
 * Run the program named in `codeCommand` and take the first 6-digit number it prints.
 * No shell is used, so the setting is a path to one program, with no arguments.
 */
export function runCodeCommand(program: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let child;
    try {
      child = spawn(program, [], { stdio: ["ignore", "pipe", "inherit"], timeout: timeoutMs });
    } catch (error) {
      reject(codeCommandError(program, error));
      return;
    }
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", (error) => reject(codeCommandError(program, error)));
    child.on("close", (exitCode, signal) => {
      const code = /\b(\d{6})\b/.exec(out)?.[1];
      if (code) return resolve(code);
      reject(
        new LoginError(
          signal
            ? `The code program stopped after ${Math.round(timeoutMs / 1000)}s without printing a code.`
            : `The code program finished (exit ${exitCode}) without printing a 6-digit code.`,
          `Program: ${program}. Run it yourself to see what it prints.`
        )
      );
    });
  });
}

function codeCommandError(program: string, error: unknown): ConfigError {
  const code = (error as NodeJS.ErrnoException)?.code;
  const reason =
    code === "ENOENT" ? "it does not exist" : code === "EACCES" ? "it is not executable" : String(code ?? error);
  return new ConfigError(
    `Cannot run the code program ${program}: ${reason}.`,
    "Fix the path with `monarch config set codeCommand <path>`, or remove it with `monarch config unset codeCommand`."
  );
}
