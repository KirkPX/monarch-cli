import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodeCommand, signIn } from "../src/login/monarch.js";

const BASE = "http://127.0.0.1:9";
const base = { baseUrl: BASE, deviceId: "0b6f2a7e-3f52-4a39-9f0e-6f3e2a1b9c11", email: "a@example.com", password: "pw" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signIn", () => {
  it("sends the flags Monarch requires, the device id and no token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ token: "t1", tokenExpiration: null }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await signIn(base);
    expect(result).toEqual({ status: "ok", token: "t1", tokenExpiration: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/auth/login/`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ username: "a@example.com", supports_mfa: true, supports_email_otp: true, supports_recaptcha: true });
    expect(init.headers["Device-UUID"]).toBe(base.deviceId);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("reports that Monarch emailed a code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error_code: "EMAIL_OTP_REQUIRED" }, 403)));
    expect(await signIn(base)).toEqual({ status: "code-needed", kind: "email" });
  });

  it("reports an authenticator code request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error_code: "MFA_REQUIRED" }, 403)));
    expect(await signIn(base)).toEqual({ status: "code-needed", kind: "totp" });
  });

  it("sends an emailed code as email_otp and an authenticator code as totp", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ token: "t" }));
    vi.stubGlobal("fetch", fetchMock);
    await signIn({ ...base, code: { kind: "email", value: "123456" } });
    await signIn({ ...base, code: { kind: "totp", value: "654321" } });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).email_otp).toBe("123456");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).totp).toBe("654321");
  });

  it("names the next step when the password is refused, and never shows it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Invalid credentials" }, 401)));
    const error = (await signIn(base).catch((e: unknown) => e)) as Error & { hint?: string };
    expect(error.message).toContain("a@example.com");
    expect(error.message).toContain("Invalid credentials");
    expect(error.message).not.toContain("pw");
    expect((error as { hint?: string }).hint).toContain("login --paste");
  });
});

describe("runCodeCommand", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monarch code ü "));

  function program(name: string, body: string): string {
    const file = path.join(dir, `${name}.mjs`);
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it.skipIf(process.platform === "win32")("takes the first 6-digit number the program prints", async () => {
    expect(await runCodeCommand(program("ok", 'console.log("Your code is 482913")'))).toBe("482913");
  });

  it.skipIf(process.platform === "win32")("fails with a plain message when no code is printed", async () => {
    await expect(runCodeCommand(program("none", 'console.log("nothing yet")'))).rejects.toThrow("without printing a 6-digit code");
  });

  it("names a missing program", async () => {
    await expect(runCodeCommand(path.join(dir, "missing"))).rejects.toThrow("it does not exist");
  });
});
