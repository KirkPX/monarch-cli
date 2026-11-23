# Changelog

## 0.1.0

First release. Used daily on macOS. **Not yet tested by a person on real Windows**; the
automated tests run on Windows in CI.

- `monarch login` signs in with email and password, then the code Monarch emails or your
  authenticator shows. It also takes the password on standard input and the code from a
  program (`codeCommand`), so a scheduled job can sign in again on its own.
- `monarch transactions` reads every field Monarch offers and changes transactions safely:
  an optional check that nobody changed the record first (`--expect`), a dry run, and a
  read-back before reporting success. `batch-update` applies a file of changes.
- `monarch export` writes accounts, categories and every field of every transaction in a
  date range to one JSON file.
- Accounts (balances, history, net worth, bank refresh and connection state), institutions,
  holdings, categories, tags, budgets, cash flow, recurring items, splits and attachments.
- `monarch doctor` checks the install, the settings file, the credential store, and whether
  Monarch accepts the saved token.
