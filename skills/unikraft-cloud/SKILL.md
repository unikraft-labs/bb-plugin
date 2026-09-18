---
name: unikraft-cloud
description: Inspect and control the Unikraft Cloud bastion and the per-thread sandboxes it manages with the `bb unikraft-cloud` CLI. Use when asked about the Unikraft Cloud plugin's state, when a thread on Unikraft Cloud will not start, or when someone wants to start, stop, or clean up the bastion and its sandboxes.
---

# Unikraft Cloud

Threads started on the **Unikraft Cloud** environment row each run in their own
Unikraft Cloud microVM — a *sandbox* — that scales to zero between turns. A
service called the *bastion* owns those sandboxes and relays their traffic to
this bb server. The `bb unikraft-cloud` command is the same surface as the
plugin's settings section: everything below can be done from either.

## Commands

| Command | Effect |
| --- | --- |
| `bb unikraft-cloud status` | Configuration, bastion health, tunnel state, sandbox counts. |
| `bb unikraft-cloud start` | Create the bastion (managed mode) or wait for it (external mode), then warm the sandbox template. |
| `bb unikraft-cloud stop` | Delete the bastion. Sandboxes stay in standby. |
| `bb unikraft-cloud sandboxes` | List every sandbox with its state and size. |
| `bb unikraft-cloud sandbox <thread-id>` | Show the state and size of the sandbox serving one thread. |
| `bb unikraft-cloud delete-sandboxes` | Delete every sandbox and its filesystem. |
| `bb unikraft-cloud warm [--force]` | Build the sandbox template ahead of the first thread. |

Every command accepts `--json` and prints one JSON value on stdout, which is
what to use when the output is going to be parsed.

## Reading the status

```
bb unikraft-cloud status
```

- `configured` lists the settings that are still missing. Settings live in
  Settings → Plugins → Unikraft Cloud, or `bb plugin config unikraft-cloud`.
- `bastion` is empty until the bastion has been started.
- `ready` is the bastion's own health check.
- `tunnel` must be `connected` before a thread can start: it is the connection
  the bastion uses to reach this bb server.

A thread refuses to start while any of those is unmet, and the environment
picker shows the same reason.

## Preparing a sandbox

**Sandbox prepare commands** are shell commands, one per line, run once inside
every new sandbox before its first turn, and **Sandbox prepare timeout** (a Go
duration, `5m` by default) bounds each of them. The base image already carries
the Claude Code CLI; use prepare for extra tools a project needs. A sandbox's
writable layer does not survive a stop, so the commands run per sandbox rather
than once in the template.

## Order of operations

1. Set the Unikraft Cloud token and metro (managed mode), or the bastion URL
   and token (external mode).
2. In Settings → Machines, choose **Unikraft Cloud** as the default machine
   access so enrolled sandboxes are told how to reach this server.
3. `bb unikraft-cloud start`.
4. Start a thread on the **Unikraft Cloud** row.

## Cautions

- `stop` deletes the bastion instance only. Threads whose sandboxes are in
  standby cannot run until it is started again.
- `delete-sandboxes` is destructive and irreversible: it deletes the
  filesystem of every sandbox, including ones with live threads. Ask before
  running it.
- Deleting a single sandbox is bb's job, not this command's: archive or delete
  the thread and bb removes its machine.
