# bastion/api

Generated TypeScript client for the bastion's control API. **Do not edit**;
every file here is regenerated from the bastion's `openapi.yaml`, and a
regeneration is one commit of its own (`chore(api): Regenerate bastion client`).

## Provenance

| Input | Value |
| -- | -- |
| Generator | `tsplugingen` from `unikraft-cloud/plugin-sdk` (`js/tools/tsplugingen`) at commit `9ed197542ce3cd0783b70236bec81459eb6ab734` |
| `openapi-gen` | `unikraft.com/x/tools/openapi-gen` v0.0.0-20260917145027-18995f09076a |
| Contract version | v0.1.0 |
| `specHash` | `4d6229cfadfbe97eb81b7368f26f2f5592a322832ddccbd98d2d9377e5a5dc3c` |
| `templatesHash` | `2cd15f41edf4803148ad4aea46301ee6ffd2988ddcbdbc8ea627d84f2662ab57` |
| `configHash` | `a64e689ca21026746bb3f00eb02b47af7557e38ab5d0d6c619041c267d05eb08` |

The hashes are the ones the generator writes into its `package.json`, which
is not vendored.

## Regenerating

Requires GNU make 4 (`gmake` on macOS).

```sh
git clone -b prod-staging https://github.com/unikraft-cloud/plugin-sdk "$SCRATCH/plugin-sdk"
mkdir -p "$SCRATCH/specs/bb-bastion"
cp path/to/bastion/openapi.yaml "$SCRATCH/specs/bb-bastion/"
gmake -C "$SCRATCH/plugin-sdk/js/tools/tsplugingen" generate \
  PLUGIN=bb-bastion SPEC_ROOT="$SCRATCH/specs"
rm -rf bastion/api
cp -R "$SCRATCH/plugin-sdk/js/tools/tsplugingen/.build/bb-bastion/src" bastion/api
```

Then update the table above and restore this README. A CI job will own this
step later.
