# Agent instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/cross-platform.md](docs/cross-platform.md).

Project shape:

- `src/index.ts`: CLI entry point, with lazy command imports and the top-level error handler.
- `src/client.ts`: Monarch transport (GraphQL at `/graphql`, REST for `/auth/login/`), with timeout, limited retries and redacted errors. A GraphQL mutation is never retried after a 5xx.
- `src/client-upload.ts`: the receipt upload to Monarch's file host. It never carries the Monarch token.
- `src/monarch/`: one file per area of Monarch (transactions, accounts, categories, …) holding its GraphQL documents and typed calls. `payload.ts` turns the `errors` field Monarch puts inside a mutation's reply into an `ApiError`.
- `src/paths.ts`: the settings folder. `src/settings.ts`: the settings file. `src/config.ts`: the precedence chain.
- `src/auth.ts`: credential stores.
- `src/errors.ts`: typed errors, with secret redaction.
- `src/cli/output.ts`, `src/cli/guardrails.ts`: output format, dry runs, confirmation, read-only.
- `src/cli/ask.ts`: every prompt. `src/cli/parse.ts`: number options. `src/cli/read-file.ts`: files and JSON bodies. `src/cli/client-helpers.ts`: `createClient()`.
- `src/cli/registry/`: one file per command group, registered from `index.ts`. Handlers in `src/cli/commands/` are imported lazily.
- `src/login/`: Monarch's email, password and code sign-in, the code-program runner, and the no-echo prompt.

## Rules that matter most

- **ESM and `tsup`**, Node 22.18, 24.11 or newer. Do not switch to CommonJS or build with plain `tsc`. It leaves old files in `dist/`.
- **Dependencies are fixed:** `commander`, `zod`, `@napi-rs/keyring`, `picocolors`. Do not add `axios`, `chalk`, `inquirer`, `ora` or `jest`. Use `fetch`, `picocolors`, readline and `vitest`.
- **Build without `--dts`.** TypeScript 7 has no compiler API for `tsup --dts`. A CLI needs no type files.
- **`private: true` stays.** Releases are GitHub-only, and this prevents an accidental npm publish.
- **Secrets** go through `src/auth.ts`, or `MONARCH_API_KEY`. Never print a full token. Use `redact()`.
- **Settings** go through `src/settings.ts` and `src/config.ts`. One precedence chain: flags, env, settings file or keychain, default.

## Adding a command

- **Read command:** follow `transactions list` in `src/cli/commands/transactions.ts`. Register it in its group's file in `src/cli/registry/` with a lazy `import()`.
- **Command that changes data:** call `assertWritable(opts)`, then `confirmDestructive(msg, opts)` for destructive actions, and report through `printDryRun()`, so output separates changed, would change and nothing changed.
- **Read back every write.** Monarch often answers "Something went wrong" whether or not a change worked, and sometimes accepts a change it does not apply. A write is reported as done only after a fresh read shows it.
- **Prove each new query against the real service, read-only**, before relying on a field name or a filter. Monarch ignores filters it does not understand.
- Number options use `src/cli/parse.ts`. Options that take JSON use `readJsonBody()` in `src/cli/read-file.ts`.
- Update `README.md` and add a test in the same change. Add every new environment variable to `.env.example`.

## Verify before committing

```bash
npm run typecheck && npm test && npm run build && npm run smoke
```

## Tests

Tests drive the built CLI against a fake Monarch on `127.0.0.1` (`tests/stub.ts`). No test reaches the real service.
