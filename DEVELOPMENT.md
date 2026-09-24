# Development

## Branch model

- `main`: tested public/stable release.
- `dev`: active development.
- Stable releases are tagged `vX.Y.Z`.
- Development versions use `X.Y.Z-dev`.

Never develop directly inside the active Hermes runtime plugin folder. Develop in the repository/worktree, run tests, then copy the reviewed release into the Desktop plugin root.

## Architecture

Mender is a single Hermes Desktop ESM plugin and uses only imports allowed by the Desktop Plugin SDK.

### Reconcile A — server to Desktop

For every installed gateway plugin that reports `has_desktop_half` and catalog provenance:

1. keep its enable/disable state unchanged;
2. verify whether the matching Desktop half exists;
3. use the server's `installed_sha` as the immutable source;
4. fetch and inspect the pinned Desktop files;
5. block on critical preflight findings;
6. call the native Desktop installer with `force: false`;
7. pin the materialized files to that exact SHA;
8. repair a generic `catalog` directory name when needed.

This applies to installed packages even when their status is `not enabled` or `disabled`.

### Uninstall intent

Hermes currently exposes no dedicated third-party Desktop-plugin event that says `plugins.manage remove` was invoked. Mender therefore persists the last complete half-state. When a previously complete unified package suddenly loses its Agent half while the Desktop half remains, automatic reconciliation treats that transition as uninstall intent instead of re-installing the Agent half. The tombstone is short-lived and a manual **Repair now** deliberately overrides it.

### Reconcile B — Desktop to server

For a local Desktop plugin with no matching gateway package:

1. match it unambiguously to a catalog entry by plugin ID/folder;
2. call `probePluginRepo`;
3. continue only when Hermes confirms both Agent and Desktop halves exist;
4. inspect bounded runtime-capable files from the exact catalog SHA;
5. block on critical findings;
6. install the missing Agent/server half through `plugins.manage`.

Mender does not use SSH for this. It uses the same active gateway transport as Hermes Desktop.

## Polling and events

A native Desktop directory watcher handles local plugin-directory changes quickly.

A periodic 20-second reconciliation remains as a fallback for remote gateway changes because a remote package install may not create a local filesystem event. It runs inside the existing Hermes Desktop renderer; it is not a separate background process or service.

## Tests

```
node --check plugin.js
node tests/contract.test.mjs
node tests/runtime.test.mjs
```

Before promotion to `main`, also run live integration tests:

- missing Desktop half with an installed-but-not-enabled server package;
- missing Agent/server half with an unambiguous unified catalog package;
- generic `desktop-plugins/catalog` folder repair;
- exact SHA/hash match after restoration;
- UI load with no runtime-loader error;
- no unexpected enable/disable changes.

## Retirement

The project should be removed rather than expanded indefinitely after Hermes upstream reliably reconciles both halves and uses collision-free Desktop directory naming.