
**by [@milanworks](https://github.com/milanworks)**

Hermes Mender is a temporary Hermes Desktop plugin that repairs incomplete **unified plugin** installations when Hermes Desktop is connected to a local or remote Hermes gateway.

It targets two Hermes Desktop edge cases:

1. catalog packages whose repository subdirectory is named `catalog` can collide in `desktop-plugins/catalog`;
2. one half of a unified package can exist while the other is missing.

Mender reconciles both directions:

```
Agent/server half -> missing Desktop half -> restore Desktop half
Desktop half -> missing Agent/server half -> install through plugins.manage (disabled by default)
```

It does not patch Hermes Core, edit the database, install a Windows service, require SSH, or run a separate shell watcher.

## What it uses

Mender stays inside documented Hermes surfaces:

- `host.request('plugins.manage', ...)` for gateway plugin state and installs;
- `window.hermesDesktop.probePluginRepo()` to confirm that a package really has both halves;
- the Desktop plugin root and native directory watcher;
- the Desktop installer with `force: false`;
- the catalog's immutable pinned commit SHA.

## Compatibility check

Mender does not trust a hardcoded Hermes version string. At runtime it checks the Desktop bridge and active gateway contract it actually depends on.

The UI reports:

- **Compatible** — all required and optional Mender surfaces are available.
- **Degraded** — required repair/status paths work, but one or more optional features need a fallback or are unavailable.
- **Unsupported** — a required API/contract is missing. Mender pauses automatic mutations instead of guessing.

Hermes Desktop itself error-isolates runtime plugins: a load/register failure is rolled back and the plugin row is published with an error state rather than taking down the app. Mender's compatibility check runs after the module successfully loads and protects against later SDK/gateway contract drift.

## UI

Click the **Mender** status-bar chip to open `/mender`.

The page shows:

- Agent/server half and Desktop half status;
- installed/pinned SHA;
- missing halves;
- security-preflight findings;
- the most recent repair actions;
- a manual **Repair now** action.

`Repair now` performs an immediate full reconcile and also clears short-lived uninstall tombstones. That makes it the explicit recovery action when a half was removed by mistake and should be restored.

Raw plugin logs are intentionally not duplicated. Hermes already records Desktop/plugin console output in its normal Desktop log.

## Repair behavior

Mender keeps repair controls in one place:

- **Respect uninstall actions** — default **On**. If a previously complete unified package loses its Agent half, Mender treats that as intentional removal instead of immediately restoring it. **Repair now** explicitly overrides that short-lived protection.
- **Auto-enable repaired Agent halves** — default **Off**. A repaired Agent half is installed disabled. Turn this on only if you want successful repairs to activate immediately after the security checks.
- Installed-but-disabled Agent halves show an **Enable** action directly in the Mender row.
- **Update all** updates every supported catalog-installed package through one controller. Agent/unified packages use `plugins.manage update`; capability-widening updates stop at **Review required** instead of auto-consenting. Desktop-only catalog packages are compared against the pinned catalog files, scanned, then updated in place without creating a duplicate installation.

## Remote uninstall compatibility

Mender exposes **Uninstall** on each managed package row. It first uses the current `plugins.manage remove` RPC. If an older remote gateway responds specifically with `unknown plugins action: remove`, Mender falls back to the official `hermes plugins remove <name>` CLI through Hermes' own gateway shell RPC. The fallback accepts only a strict canonical plugin-name character set and then removes the local Desktop half as part of the same operation.

This compatibility path exists for Desktop/gateway contract skew; it is not a second package manager.

## Core protection

Core protection is separate from the general security preflight and has intentionally different mode semantics:

- **Smart** (default): detected Core tampering pauses the Mender-controlled install/repair/update and asks for a decision.
- **Strict**: detected Core tampering is blocked. Strict has no per-version bypass.
- **Off**: Mender allows Core tampering. Hermes' native malware scan and capability consent remain separate and active.

Only Smart exposes **Allow this exact version**. The exception is bound to the plugin identity plus the full 40-character commit SHA, is visible/revocable in the UI, and does not carry to a future update. Switching to Strict ignores stored Smart approvals until the user returns to Smart.

A Core exception never bypasses the normal Security mode. A general malware/secret security block has no Core-override button.

Supported Hermes extension capabilities such as `tools.override` and `llm.model_override` are not treated as Core tampering by themselves.

## Install from GitHub

Mender includes a checked installer for **public GitHub repositories**. Paste a GitHub URL or `owner/repo` (optionally a package subdirectory), then choose whether the Agent half should be enabled after installation.

The flow:

1. resolve the public repository/ref to a full Git commit SHA;
2. ask Hermes' own `probePluginRepo` which plugin halves exist;
3. inspect the pinned source with Mender Security + Core protection;
4. install the Agent half through `plugins.manage install` with `ref: <full SHA>` and `force: false`;
5. install the Desktop half through the Hermes Desktop bridge, then reconcile its files to the same checked SHA;
6. never create a second copy merely to update/repair an existing destination.

**Enable after install** defaults to Off. Private repositories should use Hermes' normal installer because Hermes deliberately keeps its Git credential handling out of third-party Desktop plugins.

**Desktop bridge limitation:** Agent halves are installed at the exact resolved SHA. Hermess current Desktop installer has no `ref` parameter, so custom GitHub Desktop installs are reconciled to the checked SHA immediately after Hermess normal clone rather than being atomically cloned at that SHA. See [SECURITY.md](SECURITY.md).

## Security preflight

Before Mender automatically materializes a missing half, it performs bounded static inspection of the source it is about to use.

Mender has three persisted modes:

- **Smart** (default): critical findings block automatic repair; high/medium findings stay visible.
- **Strict**: critical and high findings block automatic repair.
- **Off**: disables only Mender's supplemental preflight.

Mender never turns off Hermes' own host-owned `plugins.scan_on_install` control. Agent/server installs still pass through Hermes Core's install scanner.

This is a **risk preflight, not a proof of safety**. The strongest trust property is reproducibility: Mender repairs from the exact catalog/installed 40-character commit SHA, not a moving branch head.

See [SECURITY.md](SECURITY.md).

## Install

Development/manual disk install:

```
$HERMES_HOME/desktop-plugins/hermes-mender/plugin.js
```

On the default Windows Desktop home this is normally:

```
%LOCALAPPDATA%\hermes\desktop-plugins\hermes-mender\plugin.js
```

Hermes Desktop hot-reloads disk plugins. A restart or **Reload desktop plugins** can also be used.

## Branches

- `main` — public/stable release
- `dev` — next development version

See [DEVELOPMENT.md](DEVELOPMENT.md).

## Removal

Mender is intentionally temporary. Once Hermes upstream fixes both half-reconciliation paths, disable/remove the Desktop plugin and use Hermes' native installer only.

## License

MIT.