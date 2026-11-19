# Security policy

Kleos holds live database sessions and reads passwords from the macOS Keychain, so
security reports are taken seriously.

## Reporting a vulnerability

Please **do not open an issue** for a vulnerability. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/ArnaudFeelbat/kleos/security/advisories/new)
(Security tab › Report a vulnerability), with the version, steps to reproduce, and the impact
you expect.

You can expect an acknowledgement within a few days and a fix or mitigation plan once the
issue is confirmed.

## Supported versions

Only the latest release receives fixes.

## Scope

In scope, for example:

- the local API (`127.0.0.1`, per-launch token, Host check) being reachable or usable by
  another app or web page;
- a way to write through a **read-only** favorite;
- SQL built from user input outside the raw `WHERE` box and the query editor;
- passwords leaking outside the Keychain (logs, `app.db`, crash output);
- the update check sending anything beyond its single request to GitHub, or calling out
  before the user allowed it.

Out of scope: anything that requires an already compromised Mac or database account.
