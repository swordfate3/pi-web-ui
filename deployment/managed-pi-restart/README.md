# Host-source integration artifact

`host-source.patch` preserves the reviewed companion Pi launcher/supervisor and
Gate source changes alongside this package's feature commit. It is an
`apply_patch`-format source artifact, **not** an image, a running service update,
or an automatically executed package-install script.

Its relative roots map to the existing administrator-managed source trees:

- `pi-docker/` → the existing `docker_files/pi-docker/` source directory.
- `gate/` → the existing `docker_files/pi-deploy-gate/` source directory.

The package never applies it automatically. An administrator must compare the
matching before-hashes and reviewed after-hashes in
`docs/validation/managed-restart-source-install-manifest.json`, verify canonical
paths and permissions, back up changed originals, and apply only the reviewed
files to the corresponding source directories. Host-specific configuration,
tokens, policies, state, volumes and existing services are not part of this
artifact. Do not apply it to a different source baseline by forcing a match.

Source synchronization does not activate the capability. Building/rolling out
Hub and Gate, explicitly recreating an eligible Pi container once, configuring a
separate authenticated administration origin, and enabling an exact-image
lifecycle policy are separate administrator-controlled steps. See
`docs/managed-pi-restart.md` for restrictions and the rollout checklist.
