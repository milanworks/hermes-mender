# Development

## Branch model

- `main`: tested public/stable release.
- `dev`: active development.
- Stable releases are tagged `vX.Y.Z`.
- Development versions use `X.Y.Z-dev`.

Never develop directly inside the active Hermes runtime plugin folder. Develop in the repository/worktree, run tests, then copy the reviewed build into the Desktop plugin root for live verification.

Private development state belongs under ignored `.private/` and must not be published. The current state file uses the development version in its name, for example `.private/DEV-STATE-0.7.0-dev.md`.

## Architecture

Mender is a single Hermes Desktop ESM plugin and uses imports exposed by the Desktop Plugin SDK.

The implementation has three separate control planes that must remain separate:

1. **repair/reconcile policy**;
2. **Security/Core protection policy**;
3. **update discovery/review/apply policy**.

Do not couple their timers or settings.

## Reconcile A — server to Desktop

For every installed gateway plugin that reports a Desktop half and trustworthy provenance:

1. keep its enable/disable state unchanged;
2. verify whether the matching Desktop half exists;
3. use the server's installed/pinned SHA as the immutable source;
4. fetch and inspect the pinned Desktop files;
5. apply Mender Security/Core policy;
6. prefer Hermes `reconcileDesktopPlugins()` for unified materialization;
7. use the standalone Desktop installer only when materialization did not produce the Desktop half;
8. reconcile the final Desktop files to the exact checked SHA;
9. repair a generic `catalog` directory name when needed.

Installed-but-disabled Agent packages remain valid repair sources.

## Reconcile B — Desktop to server

For a local Desktop plugin with no matching gateway package:

1. match it unambiguously to a catalog entry;
2. call `probePluginRepo`;
3. continue only when Hermes confirms the required package shape;
4. inspect runtime-capable files from the exact catalog SHA;
5. apply Mender Security/Core policy;
6. install the Agent/server half through `plugins.manage`;
7. leave it disabled by default unless the user explicitly opted into automatic enablement.

Mender does not use SSH for normal repair. It uses the same active gateway transport as Hermes Desktop.

## Uninstall intent

Hermes does not expose a dedicated third-party event saying that `plugins.manage remove` was invoked.

Mender therefore persists the last complete half-state. When a previously complete unified package suddenly loses its Agent half while the Desktop half remains, automatic reconciliation treats that transition as uninstall intent rather than immediately reinstalling the Agent half.

The tombstone is short-lived. Manual **Repair now** deliberately overrides it.

## Repair scheduling

Repair scheduling is persisted in plugin storage:

- `repair.scheduleMode = auto | interval | off`;
- `repair.intervalSeconds`;
- `repair.respectUninstallIntent`;
- `repair.autoEnableAgents`.

### Auto

Native Desktop directory changes trigger reconciliation promptly. A 5-minute fallback timer catches remote gateway changes that do not produce a local filesystem event.

### Interval

Only the configured periodic repair interval drives the fallback mutation cycle.

### Off

Automatic repair mutation is disabled. Manual **Repair now** remains available when compatibility allows it.

Background reconcile runs do not make the manual button visibly enter a busy state.

## Enable/disable actions

Installed Agent halves use the gateway-provided canonical key with `plugins.manage toggle`.

The row always exposes the inverse action:

- enabled -> **Disable**;
- disabled/not enabled -> **Enable**.

Manual GitHub **Install** also performs an explicit post-install `toggle enable:false` because Hermes' install `enable:false` means "do not actively enable" and does not by itself guarantee final disabled state for every plugin.

## Compatibility contract

Mender uses feature detection instead of a hardcoded Hermes version range.

Required checks include:

- Desktop bridge exists;
- `desktopPluginsRoot()`;
- `readDir()`;
- `readFileText()` or `readPluginSource()`;
- active gateway answers `plugins.manage list` with the row contract Mender needs.

Optional checks include repo probing, Desktop install/write/trash/rename, native watching, Desktop reconcile, standalone Desktop removal, and canonical plugin keys.

A required failure produces `unsupported` and pauses normal plugin mutations. Optional failures produce `degraded`.

Manual **Check compatibility** is only this contract check. It is not an update check.

A Mender self-update may still be recoverable while the general state is Unsupported when the minimal local root/read/write bridge needed to replace Mender remains available.

## Security and Core protection

`security.mode` and `coreProtection.mode` are independent persisted policies.

Security:

- Smart: critical blocks;
- Strict: critical/high block;
- Off: Mender Security scan disabled.

Core:

- Smart: high-confidence Core mutation pauses for exact-version approval;
- Strict: Core mutation blocks with no bypass;
- Off: Core mutation allowed at Mender layer.

Exact-version Core approvals live in `coreProtection.approvals` and are keyed by plugin identity + full 40-character commit SHA.

Every Mender-controlled install/update path should call the same `runPreflight()` / `preflightDecision()` policy rather than recreate Security/Core logic.

Hermes Plugin Guard remains a separate host-side enforcement layer.

## GitHub installer

The public-GitHub installer:

1. parses `https://github.com/owner/repo` or `owner/repo`, with optional subdirectory/ref;
2. resolves the source to a full 40-character commit SHA;
3. fetches the exact-SHA source and establishes package shape;
4. runs shared Security/Core preflight;
5. installs Agent through `plugins.manage install` with `ref: sha`, `force:false`;
6. guarantees **Install** ends disabled by explicitly toggling the canonical plugin key off;
7. **Install & enable** uses the explicit enabled path;
8. prefers `reconcileDesktopPlugins()` for the unified Desktop half;
9. only uses standalone Desktop cloning when required;
10. reports success/failure through Hermes notifications.

The persisted `install.enableAfterDefault` is only the default for pressing Enter in the repository input.

Private GitHub credentials remain outside Mender.

## Shared update architecture

There is exactly one update-plan pipeline. Do not create separate update state for per-plugin Update, Update-all, or Mender self-update.

### Discovery

`checkForUpdates()` builds `updatePlanState`.

Sources:

- gateway rows with catalog `update_available`;
- Desktop-only catalog packages whose local files differ from the current immutable pin;
- Mender's canonical GitHub channel.

Candidates are deduplicated by stable kind + package identity + target SHA/version.

### Update-check scheduling

Persisted settings:

- `updates.checkMode = auto | interval | off`;
- `updates.intervalSeconds`.

Auto checks on startup/connection changes plus a conservative 6-hour fallback. Interval uses the chosen cadence. Off disables automatic discovery only.

Manual **Check updates** is always available.

Discovery must never install updates.

### Review

The shared plan drives:

- top update banner;
- per-package **Update** buttons;
- **Update all**;
- **Review updates** dialog;
- Mender self-update;
- update action history.

`Update all` only refreshes/opens the shared review. It must never directly mutate.

Blocked or additional-review items may appear in the dialog but are not normal applicable selections.

### Apply

Only the explicit **Apply N updates** confirmation calls `applyConfirmedUpdates()`.

Batch behavior:

- continue after an independent candidate failure;
- keep capability widening held as review-required;
- classify Hermes scanner blocks separately;
- never send `accept_capabilities:true` automatically;
- reconcile once after applicable updates unless a test deliberately disables the refresh/reconcile step.

## Agent/catalog update details

Normal catalog Agent/unified updates use `plugins.manage update`.

Capability widening:

- Hermes returns `consent_required`;
- Mender retains the delta;
- no automatic consent.

Hermes scanner-block contract:

- install may provide structured `scan_blocked`;
- current catalog re-pin update can collapse `PluginScanBlocked` into `ok:false + error`;
- Mender's `isHermesScannerBlockedResult()` handles both forms.

## Desktop-only updates

Discovery fetches the current catalog-pinned Desktop files and compares them with the local package.

Only supported text payloads are writable automatically.

The actual write path uses `writeDesktopFilesTransactional()`:

1. record old contents/existence for every target file;
2. write non-`plugin.js` files first and `plugin.js` last;
3. on any failure, restore previous files in reverse order;
4. report rollback in the result.

No duplicate Desktop installation is created for an update.

## Mender self-update

Self-update is a normal shared-plan item.

Discovery:

1. choose `dev` for `-dev` builds, otherwise `main`;
2. resolve exact GitHub commit SHA;
3. read `VERSION` and `plugin.js`;
4. require a newer version;
5. verify plugin ID;
6. run shared Security/Core preflight at that SHA;
7. ensure minimal local recovery APIs are available.

Apply:

1. requires the normal Review-updates confirmation;
2. re-resolves the channel SHA and rejects stale review if it changed;
3. re-fetches VERSION/source;
4. re-runs preflight;
5. writes only the Mender runtime `plugin.js`;
6. restores the old runtime file if the write fails.

No self-update is automatic.

## UI rules

Use Hermes SDK components when available. Confirmation flows use Hermes `Dialog`, not `window.confirm()`.

Wide Mender layout:

- Plugin halves on the left;
- Security/Core/Recent actions on the right;
- bounded scroll regions prevent unbounded page growth.

Runtime plugins cannot rely on arbitrary Tailwind utility classes existing in Hermes' prebuilt CSS. Layout-critical runtime styles may need explicit React style values, as with the two-column grid.

## Tests

Core local suite:

```
node --check plugin.js
node tests/contract.test.mjs
node tests/runtime.test.mjs
```

Backend E2E:

```
<hermes-python> tests/e2e/hermes_update_backend_e2e.py
```

See `tests/e2e/README.md`.

Reusable inert fixture source belongs under `tests/fixtures/` and stays in the repository. Installed/live fixture copies and isolated Hermes homes are disposable.

Current important regressions include:

- exact-SHA Core approval / changed SHA / revocation / Strict semantics;
- scanner false-positive guards;
- dependency/dynamic-load signals;
- install disabled vs Install & enable;
- shared update-plan deduplication;
- one four-candidate Update-all batch: success, generic failure, capability review, Hermes scanner block;
- Desktop-only transactional rollback;
- Hermes backend capability-widening fail-closed;
- Hermes backend scanner-block contract;
- Compatibility Compatible / Degraded / Unsupported.

Before stable promotion, also run the live Desktop UI flows relevant to changed code and verify runtime source hash matches the reviewed dev source.

## Release documentation

Before promoting `dev` to `main`:

1. update `VERSION`;
2. update `CHANGELOG.md`;
3. check README/SECURITY/DEVELOPMENT against actual behavior;
4. run all local tests and backend E2E;
5. run the required live Desktop checks;
6. verify no `.private/` state is tracked;
7. promote the tested commit;
8. tag stable `vX.Y.Z`.

## Project lifecycle

Mender should remain a companion rather than a Hermes Core fork. Features may be retired when Hermes provides equivalent native behavior, but current update/security/control functionality means retirement is no longer tied only to the original two repair bugs.
