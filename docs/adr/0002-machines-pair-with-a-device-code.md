# Machines pair with a device code, never a browser login on the machine

The 2.1 token flow needed a browser sign-in on every target machine, one at a time, with no way to pair a silent bulk install, and the machines owlette serves usually have nobody at the screen. Since 2.4.1 the installer shows a three-word pairing phrase and any signed-in user authorizes it from the dashboard, a phone or `/ADD=<phrase> /SILENT`. The machine then holds its own refresh token, encrypted in `.tokens.enc` under a machine-bound key.

## Consequences

- Nothing on a target machine opens a browser by itself (3.1.0 removed `/OPENBROWSER=`). The pairing window offers a button and nothing more.
- A phrase belongs to the server that minted it. Every pairing surface names its server, and silent installs need `/SERVER=dev` for dev.
- The refresh token never expires. Revoking it is the only way to cut a machine off.
- The service is installed whether or not pairing succeeds (3.1.0), so a mistyped phrase never leaves a machine unsupervised.
