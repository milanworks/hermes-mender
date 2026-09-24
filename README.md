# Hermes Mender

**by [@milanworks](https://github.com/milanworks)**

Hermes Mender is a Hermes Desktop companion for repairing and controlling plugin installations across the Desktop and the active Hermes gateway.

It began as a repair for incomplete **unified plugin** installations, but now keeps the same safety model around checked GitHub installs, enable/disable state, uninstall, update review, compatibility checks, and Mender's own update path.

The original repair cases are still central:

1. catalog packages whose repository subdirectory is named `catalog` can collide in `desktop-plugins/catalog`;
2. one half of a unified package can exist while the other is missing.

Mender reconciles both directions:

```
Agent/server half -> missing Desktop half -> restore Desktop half
Desktop half -> missing Agent/server half -> install through plugins.manage
```

It does not patch Hermes Core, edit the database, install a Windows service, require SSH, or run a separate shell watcher.

## What it uses

Mender stays inside Hermes-supported surfaces wherever they exist:

- `host.request('plugins.manage', ...)` for gateway plugin state, install, update, enable/disable, and removal;
- `window.hermesDesktop.probePluginRepo()` to inspect package shape;
- the Desktop plugin root, file bridge, and native directory watcher;
- the Desktop installer with `force: false`;
- `reconcileDesktopPlugins()` for unified Desktop materialization;
- Hermes' immutable catalog pins and exact Git commit SHAs;
- Hermes Plugin SDK UI primitives for dialogs, buttons, routes, and notifications.

## Compatibility check

Mender does not trust a hardcoded Hermes version string. At runtime it checks the Desktop bridge and active gateway contract it actually depends on.

The UI reports:

- **Compatible** — all required Mender surfaces are available.
- **Degraded** — required repair/status paths work, but one or more optional features need a fallback or are unavailable.
- **Unsupported** — a required API/contract is missing. Mender pauses normal plugin mutations instead of guessing.

**Check compatibility** checks only the currently running Hermes API contract. It is not an update check.

Hermes Desktop itself error-isolates runtime plugins. Mender's compatibility check runs after the module successfully loads and protects against later SDK/gateway contract drift.

## UI

Click the **Mender** status-bar chip to open `/mender`.

The page shows:

- Agent/server half and Desktop half status;
- installed/pinned SHA;
- missing halves;
- per-package **Enable / Disable / Update / Uninstall** actions where applicable;
- Security-preflight and Core-protection findings;
- recent Mender actions;
- update availability and review;
- compatibility state;
- manual **Repair now** and **Check updates** actions.

Long package/finding/action collections use bounded scroll regions so the page does not grow indefinitely.

The small line at the bottom:

```
Last check: <timestamp> · <reason>
```

is diagnostic only. The reason is the trigger for the most recent reconcile, for example `startup`, `directory-change`, `auto-fallback`, `manual`, or `update-confirmed`.

## Repair behavior

Repair scheduling and update checking are separate policies.

### Automatic repair

- **Auto** — native Desktop changes reconcile promptly; a conservative 5-minute fallback catches remote changes.
- **Interval** — use the selected periodic repair interval.
- **Off** — no automatic repair timer/event mutation; **Repair now** still works.

Other persisted repair controls:

- **Respect uninstall actions** — default **On**. If a previously complete unified package loses its Agent half, Mender treats that as intentional removal instead of immediately restoring it. **Repair now** explicitly overrides the short-lived tombstone.
- **Auto-enable repaired Agent halves** — default **Off**. Successfully reconstructed Agent halves remain disabled unless the user opts into automatic activation.
- Installed Agent halves expose the inverse state action: **Enable** when disabled, **Disable** when enabled.

Background reconciliation does not make the **Repair now** button visibly enter a busy state.

## Update model

Mender has one deduplicated update plan for normal plugins, Desktop-only catalog packages, and Hermes Mender itself. Banner state, per-plugin **Update**, **Update all**, the review dialog, and update action history all consume that same plan.

### Update checking

Automatic update discovery is configurable independently of repair:

- **Auto** — check on startup/connection availability and on a conservative background cadence.
- **Interval** — check on a user-selected cadence.
- **Off** — do not check automatically.

**Check updates** always remains available.

Discovery never installs an update.

### Applying updates

No update is installed merely because a newer target exists.

The flow is:

1. discover candidates and resolve immutable target SHAs/versions;
2. deduplicate them into one update plan;
3. show the banner and per-plugin **Update** actions;
4. open **Review updates**;
5. show target SHA/version and security/Core review state;
6. require an explicit user confirmation;
7. apply only the selected, currently applicable items.

**Update all** therefore means "review all available updates", not "silently install everything".

Capability widening is fail-closed: Hermes may return `consent_required`; Mender shows the delta and does not auto-send `accept_capabilities: true`.

Hermes scanner blocks are kept separate from generic update failures. Current Hermes catalog re-pin updates can return a scanner block only as `ok:false + error`; Mender recognizes the documented scanner-block error in addition to a structured `scan_blocked` response.

A multi-candidate batch continues processing unrelated candidates after one candidate fails or is held for review.

Desktop-only text-file updates are transactional: if a later write fails, previously overwritten files are restored.

## Mender self-update

Mender itself is an item in the same update plan; it does not have a second, independent update subsystem.

For the current channel (`dev` for development builds, `main` for stable builds), Mender:

1. resolves the canonical GitHub source to an exact commit SHA;
2. reads `VERSION` and `plugin.js`;
3. verifies the Mender plugin ID and version;
4. runs the same Mender Security/Core preflight against that exact SHA;
5. shows the normal update banner/review UI;
6. re-resolves the SHA and re-runs preflight immediately before a confirmed write;
7. replaces only the local Mender runtime file and restores the old file if the write fails.

Self-update is never applied automatically.

If the running Mender is **Unsupported**, self-update discovery can still offer recovery when the minimal local Desktop root/read/write bridge needed to replace Mender is available. If that minimal local write path is itself missing, Mender reports self-recovery unavailable rather than attempting an unsafe workaround.

## Uninstall

Mender exposes **Uninstall** on managed package rows and uses a Hermes SDK confirmation dialog.

It first uses the current `plugins.manage remove` RPC. If an older gateway specifically rejects that action as unknown, Mender can use the official `hermes plugins remove <name>` compatibility path through Hermes' gateway shell surface. The fallback accepts only a strict canonical plugin-name character set.

This is a compatibility path, not a second package manager.

## Core protection

Core protection is separate from the general Security preflight:

- **Smart** (default) — detected Core tampering pauses the Mender-controlled operation and asks for a decision.
- **Strict** — detected Core tampering is blocked. Strict has no per-version bypass.
- **Off** — Mender allows Core tampering at its layer. Hermes' native scanner and capability consent remain separate.

Only Smart exposes **Allow this exact version**. The exception is bound to plugin identity + full 40-character commit SHA, is visible/revocable, and does not carry to another commit. Strict ignores stored Smart approvals.

A Core exception never bypasses a general Security block or Hermes' host scanner.

Supported Hermes extension capabilities such as `tools.override` and `llm.model_override` are not Core tampering by themselves.

## Install from GitHub

Mender includes a checked installer for **public GitHub repositories**. Paste a GitHub URL or `owner/repo`, optionally with a package subdirectory.

The explicit actions are:

- **Install** — install and leave the Agent half disabled.
- **Install & enable** — install and enable the Agent half after checks.

The separate persisted **Enable after install** switch remains as the default for pressing Enter in the repository field; it never changes the meaning of the two explicit buttons.

The flow:

1. resolve the public repository/ref to a full Git commit SHA;
2. inspect the exact-SHA source and package shape;
3. run Mender Security + Core protection;
4. install the Agent half through `plugins.manage install` with `ref: <full SHA>` and `force: false`;
5. use Hermes' normal unified-half reconcile first for the Desktop half;
6. only if necessary, use the Desktop installer and reconcile the final files to the checked SHA;
7. report success/failure through Hermes' native notification UI.

Private repositories should use Hermes' normal installer so credential handling remains inside Hermes.

### Desktop Git limitation

Hermes' current standalone Desktop installer does not expose a Git `ref` parameter. A custom Desktop clone therefore cannot be atomically created at Mender's inspected SHA. Mender reconciles the final materialized files to the inspected SHA, but a theoretical clone-to-reconcile TOCTOU window remains. See [SECURITY.md](SECURITY.md).

## Security preflight

Before Mender-controlled install, repair, or update, Mender performs bounded static inspection of relevant source.

Persisted Security modes:

- **Smart** — critical findings block; high/medium findings stay visible for review.
- **Strict** — critical and high findings block.
- **Off** — disables only Mender's supplemental preflight.

Current signals include dynamic execution, process/shell capabilities, network/environment access, computed dynamic loading, decode/execute obfuscation chains, remote dependency sources, immutable dependency pins, and risky install lifecycle scripts.

Mender never turns off Hermes' host-owned plugin scanner.

This is a **risk preflight, not a proof of safety**. The strongest trust property remains reproducibility from immutable SHAs plus Hermes' own host scan.

See [SECURITY.md](SECURITY.md).

## Install

Development/manual disk install:

```
$HERMES_HOME/desktop-plugins/hermes-mender/plugin.js
```

Default Windows Desktop home:

```
%LOCALAPPDATA%\hermes\desktop-plugins\hermes-mender\plugin.js
```

Hermes Desktop hot-reloads disk plugins.

## Tests

Core local tests:

```
node --check plugin.js
node tests/contract.test.mjs
node tests/runtime.test.mjs
```

Hermes backend E2E coverage lives under `tests/e2e/` and uses isolated Hermes homes; see `tests/e2e/README.md`.

Reusable inert fixtures live under `tests/fixtures/`. Runtime copies created during live tests are disposable; fixture source is kept for regression coverage.

## Branches

- `main` — public/stable release
- `dev` — next development version

See [DEVELOPMENT.md](DEVELOPMENT.md).

## Project lifecycle

Mender can be retired if Hermes eventually provides all of its repair, checked-install, update-review, and control behavior natively. Until then it remains a standalone companion rather than patching Hermes Core.

## License

MIT.
