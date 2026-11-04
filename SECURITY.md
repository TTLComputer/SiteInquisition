# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[security advisories](https://github.com/TTLComputer/SiteInquisition/security/advisories/new)
rather than a public issue. Include the version (`siq --version`), what you did
and what happened. We aim to reply within a week.

## What SiteInquisition protects, and what it does not

SiteInquisition is a testing tool that you run on your own computer. It
records traffic you point at it, and it can send requests and run code you
give it. The protections below are meant to stop mistakes and other people's
content from doing damage; they are not a security boundary against someone
who already controls your user account.

### Captured data

- Project folders are created `0700` and the database `0600`, so other users on
  the computer cannot read them. The database is not encrypted: anyone with
  your user account, or a copy of the disk, can read captured cookies, tokens
  and passwords. Use full-disk encryption; Settings, Storage tells you whether
  the project folder is on an encrypted disk.
- With an OS keyring (Secret Service via `secret-tool`), the CA private key and
  saved identities are encrypted with a master key held in the keyring. A copy
  of the project or data folder alone does not reveal them. Without a keyring
  they are plain files readable only by you.
- Use `siq clear`, `siq delete <query>` and retention limits (`siq prune
  --keep`, or Settings, Storage) so a project does not keep traffic longer than
  you need it.

### The root CA

- Every device that trusts the CA will accept certificates it signs for any
  site. Install it only on test devices and remove it afterwards; see
  [docs/ca-trust.md](docs/ca-trust.md). New CAs are valid for two years.
- TLS is decrypted only for hosts in scope. Other TLS is passed through untouched.

### Network listeners

- The proxy, HTTP/3 and MQTT listeners bind to 127.0.0.1 unless you start with
  `--lan`. With `--lan`, connections from other machines are refused until you
  allow the device or range. Anyone on an allowed address can use the proxy.
- The core API listens on 127.0.0.1 only and requires a random token, which is
  written to `core.json` in the project folder (`0600`) while the core runs.
  Any process running as you can read that token and control the core,
  including the MCP endpoint at `/mcp`. Browser pages cannot: requests with a
  foreign `Origin` are rejected.

### Scripts

- Scripts run in a separate Node process. A script that loops forever or
  blocks is killed (hooks have a time budget per message, scripts 60 s), and
  the proxy keeps working.
- By default that process runs under Node's permission model: no file reads
  outside SiteInquisition's own code, no file writes, no child processes, no
  worker threads, no native addons. Escaping the `vm` context does not change
  that.
- **The sandbox does not restrict the network.** A sandboxed script can open
  connections, as `siq.send()` does on purpose. It also sees everything you give
  it through the SDK, including captured traffic, cookies and variables. Treat a
  script you did not write like any code from the internet.
- Turning a script's sandbox off gives it your rights. That choice is stored as
  a hash of the code on this computer only, so a project shared with you, or a
  script edited elsewhere, asks again before it runs unsandboxed.

### Agents (MCP)

- In "ask" mode every action that sends traffic, runs code or changes the
  project waits for your approval in the app. Reading captured traffic does not.
  "Approve for 10 minutes" is never offered for running scripts, and scripts an
  agent runs are always sandboxed.
- Approvals are a guardrail for an agent you chose to connect, not protection
  from a malicious local process, which can use the API token directly.
  Remember that what an agent reads from traffic can include instructions
  written by the site you are testing.
