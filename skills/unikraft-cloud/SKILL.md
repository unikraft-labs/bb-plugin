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
| `bb unikraft-cloud sandboxes` | List every sandbox with its state, size and the URL of every port it publishes. |
| `bb unikraft-cloud sandbox <thread-id>` | Show the state, size and published URLs of the sandbox serving one thread, and its console link. bb's machine line under the input names the same sandbox and its state sits in the thread header. |
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
- `org` is the organisation console links point at, read from the Unikraft
  Cloud token unless the Organisation setting names one.
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

## Per-thread sandbox options

The cog beside the **Unikraft Cloud** row in the new-thread environment picker
sets the sandbox options of that thread alone; an empty field keeps the
configured default. They are persisted with the thread's machine selection, as
JSON:

```json
{ "vcpus": 2, "memoryMb": 8192, "image": "ubuntu:24.04", "ports": [8080] }
```

- `image` — another image cannot be cloned from the warm template, so the
  thread starts slower than one on the configured image.
- `ports` — each port is published to the Internet on the public port of the
  same number, which gives the sandbox a public hostname. Port 80 is served
  over HTTP and everything else over HTTPS, so port 8080 is reached at
  `https://<generated>.<metro>.unikraft.app:8080`. Unikraft Cloud generates
  that hostname and it does not follow from the sandbox's name, so read the
  URLs from `sandbox <thread-id>` once the sandbox exists.

There is no flag for these: a thread is created with them in the picker, and
they cannot be changed afterwards without a new thread.

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
