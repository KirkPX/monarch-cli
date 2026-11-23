// A fake Monarch on 127.0.0.1, for tests that drive the built CLI. It answers
// /auth/login/ and /graphql from the handlers a test gives it, and records every
// call so a test can check what was sent. Tests never reach the real service.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type StubCall = {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  operationName?: string;
  variables?: Record<string, unknown>;
};

export type StubReply = { status?: number; body: unknown };

export type Stub = { url: string; calls: StubCall[]; close(): Promise<void> };

export async function startStub(
  handle: (call: StubCall) => StubReply | Promise<StubReply>
): Promise<Stub> {
  const calls: StubCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const call: StubCall = {
        path: req.url ?? "",
        headers: req.headers,
        body,
        operationName: typeof body.operationName === "string" ? body.operationName : undefined,
        variables: (body.variables as Record<string, unknown>) ?? undefined,
      };
      calls.push(call);
      const reply = await handle(call);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Answer a GraphQL operation by name; anything else gets a GraphQL error. */
export function byOperation(
  answers: Record<string, unknown | ((call: StubCall) => unknown)>
): (call: StubCall) => StubReply {
  return (call) => {
    const answer = call.operationName ? answers[call.operationName] : undefined;
    if (answer === undefined) {
      return { body: { errors: [{ message: `stub has no answer for ${call.operationName ?? call.path}` }] } };
    }
    const data = typeof answer === "function" ? (answer as (c: StubCall) => unknown)(call) : answer;
    return { body: { data } };
  };
}
