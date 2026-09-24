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

## User-controlled repair policy

Mender keeps behavior preferences in Hermes plugin storage rather than hardcoding them per machine:

- `repair.respectUninstallIntent` defaults to `true`.
- `repair.autoEnableAgents` defaults to `false`.
- `security.mode` defaults to `smart`.

The UI is the source of truth for these switches. The same atoms are consumed by reconcile/install code so there is no separate hidden policy path.

### Core protection

`coreProtection.mode` is persisted independently from `security.mode` and defaults to `smart`. Smart pauses and asks on detected Core tampering; Strict blocks; Off allows at the Mender layer. Exact-version exceptions live in `coreProtection.approvals` and are keyed by plugin identity + full commit SHA. All Mender-controlled install/update paths call the same `runPreflight()` / `preflightDecision()` path so Core-protection policy is not duplicated.

### Enable action

Installed-but-disabled Agent halves use the canonical `plugins.manage toggle` action addressed by the gateway-provided plugin key. Mender does not fall back to a collision-prone bare-name toggle.

### Update all

One controller handles batch updates:

1. Catalog Agent/unified packages with `update_available` use `plugins.manage update`.
2. Capability widening stops at `consent_required`; Mender does not send `accept_capabilities: true` automatically.
3. The Hermes catalog re-pin path performs the normal host install scan before swapping the new tree.
4. Supported Desktop-only catalog packages are compared with their current immutable catalog pin, Mender security-scanned, then updated in place with rollback of overwritten text files on failure.
5. One reconcile refreshes both halves afterward.

No second copy of a plugin is created for updates.

### GitHub installer

The public-GitHub installer is intentionally separate from private-repository credential handling.

1. Parse a `https://github.com/owner/repo` URL or `owner/repo` identifier; an optional package subdirectory is supported.
2. Resolve the requested/default ref to a full 40-character Git commit SHA.
3. Ask Hermes `probePluginRepo` which halves exist and reject a shape mismatch between the live probe and the pinned commit.
4. Run the shared Mender security/Core preflight against the pinned source.
5. Agent install: `plugins.manage install` with `ref: sha`, `force: false`, and the user-selected enable flag.
6. Desktop install: use the Hermes Desktop installer with `force: false`, then reconcile the materialized files to the same checked SHA and canonical plugin ID.
7. Reconcile the final half-state.

The installer never auto-accepts a general Security-mode block. A Core-protection exception can be granted only for the exact identity + SHA. Private GitHub repositories remain the responsibility of Hermes' own Git credential/installer flow.

### Exact-version Core approvals

`coreApprovalKey(identity, sha)` is the only approval key constructor. Approvals are persisted in plugin storage and are not inherited across commits. Revocation deletes that key. The UI exposes approval only on Core-protection decisions; normal Security findings do not get the override action.