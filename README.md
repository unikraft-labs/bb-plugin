# bb-plugin-unikraft-cloud

Run bb threads in Unikraft Cloud sandboxes that scale to zero.

The plugin adds one row, **Unikraft Cloud**, to bb's new-thread environment
picker. Every thread started there gets its own Unikraft Cloud microVM — a
*sandbox* — with the project checked out on it. Between turns the sandbox
freezes and costs nothing; the next message wakes it.

The plugin never talks to a sandbox directly. It talks to the **bastion**, a
service on Unikraft Cloud that owns sandbox lifecycle and sits between each
sandbox's bb host daemon and this bb server. The plugin can create that bastion
itself (**managed** mode) or be pointed at one you run (**external** mode). One
outbound WebSocket from the plugin to the bastion — the tunnel — is what lets a
bastion on the public internet reach a bb server on a laptop.

Licensed BSD-3-Clause.

## Install

```sh
bb plugin install <path-or-git-url>
```

From a clone:

```sh
npm install
bb plugin install .
```

## Settings

Settings → Plugins → Unikraft Cloud, or `bb plugin config unikraft-cloud`.

| Setting | Default | Notes |
| --- | --- | --- |
| Mode | `managed` | `managed` creates the bastion; `external` uses yours. |
| Unikraft Cloud token | — | Required in managed mode. Stored as a secret. |
| Metro | — | The metro the bastion and its sandboxes run in, e.g. `fra`. |
| Organisation | from the token | The organisation console links point at. Managed mode reads it from the Unikraft Cloud token; set it by hand in external mode, or when the token names another organisation. |
| Bastion URL | — | Filled in by managed mode; required in external mode. |
| Bastion token | generated | Bearer token for the bastion's control API. Secret. |
| Bastion image | `index.unikraft.io/unikraft/bb-bastion:latest` | |
| Bastion vCPUs / memory | 1 / 1024 MiB | |
| Sandbox base image | `debian:latest` | Any image with a glibc dynamic loader and `/bin/sh`; `git`, `curl`, TLS roots and the Claude Code CLI come from the plugin ROM when the image lacks them, and the image's own copies win when present. |
| Sandbox ROM | derived | Empty selects the ROM published for this bb version. |
| Sandbox vCPUs / memory | 1 / 4096 MiB | Overridable per thread. |
| Sandbox environment | `{}` | A JSON object added to every sandbox. |
| Sandbox prepare commands | empty | Shell commands, one per line, run once in every new sandbox before its first turn. The base image already ships the Claude Code CLI. |
| Sandbox prepare timeout | `5m` | A Go duration bounding those commands. |
| Scale-to-zero cooldown | 5000 ms | How long a sandbox idles before freezing. |
| Sandbox lifetime | `168h` | A stopped sandbox is deleted after this. |
| Warm a sandbox template | on | Builds a template so the first thread starts fast. |
| Sandbox listen port | 7443 | The loopback port a sandbox's daemon dials. |

Secret fields are write-only: they show whether a value is stored, take a new
one, and have a Clear button. A setting change reloads the plugin.

## Choose Unikraft Cloud as the default machine access

Go to **Settings → Machines** and set the default machine access to **Unikraft
Cloud**. This is what tells each enrolled sandbox the server URL to dial —
`http://127.0.0.1:<listen port>` inside the sandbox, which the bastion relays
back here through the tunnel. Without it a sandbox enrols against an address it
cannot reach and the thread never comes online.

## Start the bastion

From the settings section press **Start bastion**, or:

```sh
bb unikraft-cloud start
bb unikraft-cloud status
```

`status` must show the bastion `ready` and the tunnel `connected`. The same
information is on the settings section, with the list of sandboxes.

## First thread

Start a new thread and pick **Unikraft Cloud** in the environment picker. The
cog next to the row opens the sandbox options, which apply to that thread
only; every field left empty keeps the configured default.

| Option | Effect |
| --- | --- |
| Image | The image the sandbox boots from. Another image cannot be cloned from the warm template, so the thread starts slower. |
| vCPU, Memory | The size of the sandbox. |
| Exposed ports | Each port added with **+** is published to the Internet on the public port of the same number. |

An exposed port gives the sandbox a Unikraft Cloud service group and, with it,
a public hostname. Unikraft Cloud generates that hostname and it does not
follow from the sandbox's name, so read it from the settings section or from
`bb unikraft-cloud sandbox <thread-id>`, which print one URL per port once the
sandbox exists. Port 80 is served over HTTP and every other port over HTTPS,
as the platform requires, on the public port of the same number:
`https://<generated>.<metro>.unikraft.app:8080`.

A sandbox that publishes a port carries a menu beside its state pill in the
thread header, listing every published port as `<hostname>:<port>`. Each one
opens over HTTPS.

The thread's machine is named after its sandbox instance, so bb's machine line
under the input reads `Unikraft Cloud (bbx-…)`, with the name linked to the
instance in the Unikraft Cloud console once the organisation is known. The
thread header carries a pill with the sandbox's state. `bb unikraft-cloud
sandbox <thread-id>` prints the same state and link on the command line.

bb owns the sandbox from there: archiving or deleting the thread deletes its
sandbox. Stopping the bastion leaves sandboxes in standby; **Delete all
sandboxes** removes them and their filesystems.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| The picker row says setup is required | A setting is missing; the message names it. |
| The row says the bastion is not ready | The bastion is not started, or its health check fails. Run `bb unikraft-cloud status`. |
| The row says there is no tunnel | The plugin cannot reach the bastion's `/v1/tunnel`. Check the bastion URL and token. |
| A thread starts but never comes online | The default machine access is not Unikraft Cloud, so the sandbox dials an address it cannot reach. |
| A thread fails with a git error | The sandbox base image has no `git`. |
| A thread has no agent CLI | The ROM's fallback CLI should cover it; check `bb plugin logs unikraft-cloud` and the sandbox ROM setting. |
| `status` reports a ROM is missing | No ROM is published for this bb version. Set the Sandbox ROM setting to one that exists. |

Plugin logs: `bb plugin logs unikraft-cloud`.

## Development

```sh
npm install
npm run typecheck
npx vitest run
bb plugin build
```

`bastion/api/` is generated from the bastion's OpenAPI specification and is
never edited by hand; `bastion/api/README.md` records the regeneration recipe.
