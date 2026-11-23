# Security policy

Report a vulnerability privately through
[GitHub's security advisory form](https://github.com/KirkPX/monarch-cli/security/advisories/new).
Do not open a public issue. Only the latest release is supported.

## How the CLI handles your token and password

- `monarch login` sends your password only to Monarch's sign-in address, over HTTPS,
  and never stores it. It saves the token Monarch returns to the OS keychain.
- The password is read without echo at the terminal, from standard input with
  `--password-stdin`, or from `MONARCH_PASSWORD`. Prefer standard input in scripts:
  other programs on the same machine may be able to read a process's environment.
- Where the keychain is closed, such as over SSH on macOS, the key goes to a
  credentials file in the settings folder. On macOS and Linux only you can read
  that file (mode 600, in a folder with mode 700). On Windows it relies on your
  profile folder's permissions.
- `MONARCH_API_KEY` takes the token from the environment and stores nothing.
- Error messages and logs redact the token.
- The token is sent only to the Monarch address the CLI is set to. A receipt upload goes
  to the image host Monarch uses (api.cloudinary.com) with the one-time upload signature
  Monarch issues for it, never with the token or any Monarch header.
- `codeCommand` runs one program you name, with no shell and no arguments.

The settings file never holds a token or a password. It holds your email, a random device
id, and the path of your code program, none of which is secret.
