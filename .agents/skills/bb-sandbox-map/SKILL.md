---
name: bb-sandbox-map
description: Maps this repository and `bb-sandbox-bastion`, and says which one owns each decision. Use when you edit `bastion/api/`, `tunnel/`, or the bastion config that `bastion/lifecycle.ts` writes. Also use when bb moves to a new version, or when a sandbox does not start, sleep, or wake correctly.
---

# bb-sandbox map

Two repositories make the Unikraft Cloud (UKC) environment for bb: this one,
and `bb-sandbox-bastion`, which is at `../bb-sandbox-bastion` locally. Find
the owner of a decision here, then read the documentation of that owner. The
design of the bastion is in its `AGENTS.md` and `docs/ARCHITECTURE.md`. This
skill carries the couplings between the two repositories, which no file in
either one describes in full.

## Three programs

Each frame between bb and the agent of a thread goes through three programs.
Two of them have "plugin" in their name.

| Program | Runs | Does |
| --- | --- | --- |
| **bb plugin**: this repository | In the bb server, often on a laptop behind NAT | Adds the Unikraft Cloud row to the environment picker, asks the bastion for one sandbox per thread, and opens the tunnel. In managed mode, it also starts the bastion. |
| **bastion**: `cmd/bb-bastion` and `internal/` in `bb-sandbox-bastion` | On its own UKC instance, always awake | Creates, wakes, and deletes sandboxes. Relays the traffic of each sandbox to bb through the tunnel, and answers bb for a sandbox that sleeps. |
| **sandbox plugin**: `plugin/` in `bb-sandbox-bastion` | In every sandbox, as the `bb-sandbox` ROM | Enrols the bb host daemon, sends its traffic to the bastion, and keeps the sandbox awake for the length of a turn. |

The bastion exists because a sandbox sleeps and bb does not know. A sandbox
freezes seconds after each turn, but bb expects a heartbeat from each
host every 5 seconds. The bastion answers for the frozen sandbox, keeps
new work, and wakes the sandbox when work arrives, so bb sees the host online.
The Modal plugin in bb has no bastion, because bb pauses a Modal machine
itself and knows that it sleeps. The tunnel exists for a second reason: a
sandbox cannot dial a bb server behind NAT, so the bb plugin dials out to the
bastion.

## Who owns what

| Repository | Owns |
| --- | --- |
| `unikraft-labs/bb-plugin` | **This repository.** The bb plugin. |
| `unikraft-labs/bb-sandbox-bastion` | The bastion and the sandbox plugin. Also both API contracts, the tunnel specification, and the workflows that publish the bastion image and the ROM. |
| `unikraft-cloud/plugin-sdk` | The Go SDK of the sandbox plugin, `sdkgen` for the client of the sandbox plugin in the bastion, and `tsplugingen`, which generates `bastion/api/` here. |
| `unikraft-cloud/x` | `openapi-gen`, which generates the server stubs of the bastion and is the engine under `tsplugingen`, and the reusable CI workflows of the bastion. |
| bb | The host-daemon protocol that the bastion relays, and `@get-bb/plugin-sdk`, which the bb plugin builds on. |

`unikraft-cloud/plugin-sdk` makes UKC platform plugins, such as the sandbox
plugin. It has no relation to `@get-bb/plugin-sdk`. The `AGENTS.md` of the
bastion calls the sandbox plugin the UKC plugin.

## Couplings

Each coupling below is a copy or a hand-written mirror of a file in the other
repository. No CI job compares the two sides, so each coupling has its own
check. A change that crosses a coupling is done when both repositories have
their commit and the check passes.

### The control API

The bastion's `api.tsp` is the source. This repository vendors what
`tsplugingen` generates from the bastion's `openapi.yaml`, in `bastion/api/`.
`bastion/api/README.md` has the recipe and the `specHash` of the input. The
client is current when `sha256sum ../bb-sandbox-bastion/openapi.yaml` prints
that hash. The `contract-drift` workflow of the bastion checks only the code
that the bastion generates for itself.

### The tunnel

The bastion's `docs/TUNNEL.md` is the specification, and `tunnel/mux.ts` is
the client half. `tunnel/testdata/vectors.json` is a copy of the bastion's
`docs/tunnel-vectors.json`, and the tests of each repository read only their
own copy. The copy is current when
`diff tunnel/testdata/vectors.json ../bb-sandbox-bastion/docs/tunnel-vectors.json`
prints nothing.

### The bastion config file

In managed mode, `renderBastionConfig` (`bastion/lifecycle.ts`) writes the
YAML config of the bastion by hand, and no contract covers it. The bastion's
`internal/config` refuses an unknown key and validates each value. Thus:

- A new key needs a bastion release first. Managed mode runs the image in the
  Bastion image setting, `bb-bastion:latest` by default. The `bastion-image`
  workflow publishes that tag on a `v*` tag of the bastion.
- `PROXY_WAKE_TIMEOUT` here must stay at or above the bastion's default
  `sandbox.readiness.timeout`. If it does not, the bastion does not start.

The secrets go to the bastion as environment variables (`UKC_TOKEN`,
`BASTION_TOKEN`), outside the config.

### The bb version

A ROM carries one bb version, and that version is its tag. It must match the
version of the bb server. `defaultSandboxRom` (`configuration.ts`) derives the
ROM from the version of the bb server that runs it. If no ROM exists for that
version, `bb unikraft-cloud status` reports the ROM as missing. The
`plugin-rom` workflow of the bastion publishes `bb-sandbox:<version>`, on a
`plugin/v*` tag or on a manual dispatch with `bb_versions`.

A move to a new bb version is one branch with the same name,
`chore/bb-<version>`, in each repository:

1. Here, pin `@get-bb/plugin-sdk` to the SDK version that the bb release
   ships.
2. In the bastion, move the default bb version and publish the ROM.
3. In the bastion's `docs/ARCHITECTURE.md`, verify each item of "Protocol
   coupling points" again.

## Where a behaviour lives

The bb plugin talks only to the bastion, so the bastion repository owns most
of what a sandbox does:

| Behaviour | Owner in `bb-sandbox-bastion` |
| --- | --- |
| Create, clone from the template, prepare, delete | `internal/sandbox` |
| Sleep, wake, heartbeats, answers for a sandbox that sleeps | `internal/proxy`, `plugin/bbproto` |
| The holds that keep a sandbox awake for a turn | `plugin/` |
| The tools in a sandbox: `git`, `curl`, the Claude Code CLI | the ROM: `plugin/Dockerfile`, `plugin/rom/` |
| The server half of the tunnel | `internal/tunnel` |

This repository owns the settings that it sends to the bastion, the sandbox
state that it shows, and the client half of the tunnel.
