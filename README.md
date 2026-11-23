# monarch-cli

[![CI](https://github.com/KirkPX/monarch-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/KirkPX/monarch-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Monarch Money from the terminal: download everything, change transactions safely, and
reach the parts of Monarch the app keeps behind clicks (bank refresh, balance history,
budgets, splits, receipts).

> **Unofficial.** Monarch has no public API. This tool talks to the same private GraphQL
> API Monarch's web app uses. It is not made, endorsed or supported by Monarch, and
> Monarch can change that API at any time.

> [!WARNING]
> **Windows is untested.** It is built for Windows, and the automated tests run on Windows on
> every change, but nobody has yet installed it and used it on a real Windows machine.
> macOS is where it is used every day. If you try it on Windows, please open an issue with
> what worked and what did not.

Runs on macOS and Linux, and is built for Windows. Output is readable at a terminal and JSON in a pipe,
every write can be previewed or blocked, and your token stays in the OS keychain.

**Writes are checked.** Monarch often answers "Something went wrong" whether or not a change
worked. So every change this tool makes reads the record back, and reports success only when
Monarch shows the new value. A change can also say what it expects Monarch to hold first
(`--expect`), and is refused if someone changed it in the app since.

## Install

You need **Node.js 22.18, 24.11 or newer** and Git.

```bash
cd ~
git clone https://github.com/KirkPX/monarch-cli.git
cd monarch-cli
npm run setup
monarch login
```

`cd ~` puts the tool in your home folder. A PowerShell window can open in a system folder,
where the clone would fail or be hard to find. To update later:

```bash
cd ~/monarch-cli
git pull
npm run setup
```

`npm run setup` installs, builds, links, and then tells you where you stand. If the
`monarch` command is not reachable yet, it says so and prints the fix.

On Windows, install Node and Git with `winget install OpenJS.NodeJS.LTS Git.Git`, then use
a **new** PowerShell window, because an open window keeps the old PATH. You need no compiler.

## Sign in

```bash
monarch login            # email, password, then the 6-digit code Monarch emails you
monarch login --paste    # store a token you already have instead
monarch logout
```

Sign-in works the way Monarch's own app does. Monarch emails a code the first time it sees
this computer, or asks for your authenticator code if you use one. The CLI keeps a random
device id in its settings file, so Monarch usually skips the code after that.

Running `monarch` with no arguments signs you in if you never have, and shows help
otherwise.

### With nobody at the keyboard

```bash
# The password on standard input, and the code typed in a second call:
printf '%s' "$PASSWORD" | monarch login --email you@example.com --password-stdin
monarch login --email you@example.com --password-stdin --code 123456 < password.txt

# Or name a program that finds the emailed code and prints it:
monarch config set codeCommand /path/to/print-monarch-code
printf '%s' "$PASSWORD" | monarch login --email you@example.com --password-stdin
```

The code program runs with no shell and no arguments. The first 6-digit number it prints is
used. This is how a scheduled job can sign in again on its own, for example with a program
that reads the code from your mailbox.

A code program must:

- **wait** for the email, because the CLI starts it as soon as Monarch says it sent the code
  (the CLI gives it up to 5 minutes);
- **take only a fresh code**, from a message that arrived after it started, so an old code is
  never reused;
- **print the code on stdout**, and anything else on stderr;
- **exit non-zero** when no code came, so the sign-in stops with a clear message.

A sketch in Python, reading the inbox over IMAP with an app password (the names in capitals
are yours to fill in):

```python
#!/usr/bin/env python3
import email, imaplib, re, sys, time
from email.utils import parsedate_to_datetime
started = time.time() - 60                       # allow for clock differences
with imaplib.IMAP4_SSL(IMAP_HOST) as box:
    box.login(MAIL_USER, APP_PASSWORD)
    for _ in range(30):                          # about 3 minutes
        box.select("INBOX")
        _, ids = box.search(None, '(UNSEEN FROM "monarch.com")')
        for i in reversed(ids[0].split()):
            _, data = box.fetch(i, "(RFC822.HEADER)")
            msg = email.message_from_bytes(data[0][1])
            code = re.search(r"\b(\d{6})\b", msg.get("Subject", ""))
            if code and parsedate_to_datetime(msg["Date"]).timestamp() >= started:
                print(code.group(1)); sys.exit(0)
        time.sleep(6)
sys.exit("No Monarch code arrived.")
```

For CI and agents, where no keychain exists, set the token in the environment:

```bash
export MONARCH_API_KEY=<your-token>
```

```powershell
$env:MONARCH_API_KEY = "<your-token>"
```

## Configure

Highest wins:

1. Command flags (for example `--base-url`)
2. Environment variables (`MONARCH_API_KEY`, `MONARCH_BASE_URL`, `MONARCH_ACCOUNT`, `MONARCH_EMAIL`)
3. The settings file, and the keychain for the key
4. Built-in defaults (base URL `https://api.monarch.com`)

```bash
monarch config path    # where the settings file lives
monarch config show    # check the file and print it
monarch config set readOnly true    # change one setting
monarch config unset readOnly       # remove it
```

See [docs/configuration.md](docs/configuration.md) and [examples/config.json](examples/config.json).

## First command

```bash
monarch accounts list                 # human-readable in a terminal
monarch accounts list --json          # machine-readable
monarch accounts list > accounts.json # JSON when sent to a file or another program, with no flag
```

## Commands

`monarch <group> --help` lists each group's options.

| Group | Commands | What for |
|---|---|---|
| `transactions` | `list`, `get`, `summary`, `update`, `batch-update`, `create`, `delete` | Read every field; change category, merchant, date, amount, notes, tags, review state and hide-from-reports, each one checked by reading it back |
| `export` | | One JSON file with accounts, categories and every field of every transaction in a date range, for keeping a local copy |
| `accounts` | `list`, `get`, `types`, `history`, `balances`, `snapshots`, `net-worth`, `refresh`, `refresh-status`, `create`, `update`, `delete` | Balances and their history, net worth over time, asking banks to refresh, and which bank connections need you to sign in again |
| `institutions` | `list` | Each bank connection and its state |
| `holdings` | `list` | Investment holdings |
| `categories` | `list`, `groups`, `create`, `delete` | `delete --move-to` moves its transactions first |
| `tags` | `list`, `create`, `delete` | |
| `budgets` | `list`, `set` | Planned against actual, by month |
| `cashflow` | `summary`, `detail` | Income and spending by category, group and merchant |
| `recurring` | `list`, `streams` | Upcoming bills and subscriptions |
| `splits` | `show`, `set`, `clear` | Split one transaction across categories |
| `attachments` | `list`, `add` | Attach a receipt to a transaction |
| `whoami`, `doctor` | | Who the token belongs to; is the install working |

### Changing transactions safely

```bash
# Preview, then change, refusing if the category is no longer what you saw:
monarch transactions update <id> --category "Medical" --expect category="Shopping" --dry-run
monarch transactions update <id> --category "Medical" --expect category="Shopping"

# Many at once, from a file (or - for standard input). Stops at the first conflict or failure:
monarch transactions batch-update changes.json --dry-run
monarch transactions batch-update changes.json
```

`changes.json` is a list: `[{"id": "…", "set": {"category": "Medical", "notes": "…"}, "expect": {"category": "Shopping"}}]`.
Fields: `category`, `merchant`, `date`, `amount`, `notes`, `tags` (the full set, joined by `; `),
`hideFromReports`, `needsReview`, `reviewed`. Each result is `verified`, `unchanged`,
`conflict`, `failed` or, on a dry run, `would-change`. The command exits 1 when any item is a
conflict or a failure.

## Output

Every command prints **human-readable** output in a terminal and **JSON** when the output
is piped or redirected, or when you pass `--json`. A command that fails leaves stdout
empty and prints the reason on stderr.

## Safety

Commands that change data:

- refuse to run in read-only mode (`--read-only`, `MONARCH_READ_ONLY=1`, or `"readOnly": true` in the settings file)
- ask for confirmation, or take `--yes` to skip the question
- never ask in `--json` or non-interactive mode: pass `--yes`
- support `--dry-run` to preview without changing anything

## Troubleshooting

```bash
monarch doctor            # install, settings file, credential store, and whether Monarch accepts the token
npm run doctor                 # the same check, when the command itself is not found
```

- **"Not signed in"**: run `monarch login`, or set `MONARCH_API_KEY`.
- **"Monarch refused the sign-in"**: check the email and password. If you signed up with Google or Apple, set a Monarch password in the app first, or use `monarch login --paste`.
- **"Monarch wants the 6-digit code"** in a script: pass `--code`, or set `codeCommand`.
- **A change reports `failed` with "reads back"**: Monarch accepted the request but did not apply it. Nothing else was sent after it. Check the transaction in the app.
- **"Invalid settings"**: the settings file has a typo or an unknown key. The message names it.
- **`monarch on PATH: shadowed`**: another program of the same name comes first on your PATH.
- **"running scripts is disabled on this system"** (PowerShell): the execution policy blocks npm's `.ps1` launcher. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Uninstall

```bash
monarch logout            # removes the stored token; run this first
npm uninstall -g monarch-cli
```

The settings file stays. `monarch config path` shows where it is, before you uninstall.

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

The GraphQL operations for accounts, budgets, cash flow, recurring items, splits and
attachments follow the ones mapped by the MIT-licensed
[monarchmoneycommunity](https://pypi.org/project/monarchmoneycommunity/) Python library.

## License

MIT. See [LICENSE](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
