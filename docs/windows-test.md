# Real Windows test

A person runs this before the first release, and again after a change to sign-in, install or storage. CI cannot show what a new user sees at the password and code prompts.

Steps: install from the README in a normal PowerShell window; open a new window and run `monarch --version` and `monarch doctor`; sign in with `monarch login` and with `--paste`; confirm the key is in Credential Manager; run one list command at the terminal and piped to a file; read a file from a path with a space and a non-English character; try `--dry-run` and `--read-only`; press Ctrl-C at a prompt; uninstall and remove the saved key.

| Date | Version | Windows | Node | Result | Problems |
|---|---|---|---|---|---|
