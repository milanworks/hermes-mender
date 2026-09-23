# Hermes Mender

Hermes Mender is a temporary Hermes Desktop plugin that repairs incomplete **unified plugin** installations when Hermes Desktop is connected to a local or remote Hermes gateway.

It targets two Hermes Desktop edge cases:

1. catalog packages whose repository subdirectory is named `catalog` can collide in `desktop-plugins/catalog`;
2. one half of a unified package can exist while the other is missing.

Mender reconciles both directions:

```
Agent/server half -> missing Desktop half -> restore Desktop half
Desktop half -> missing Agent/server half -> install through plugins.manage
```

It does not patch Hermes Core, edit the database, install a Windows service, require SSH, or run a separate shell watcher.

## What it uses

Mender stays inside documented Hermes surfaces:

- `host.request('plugins.manage', ...)` for gateway plugin state and installs;
- `window.hermesDesktop.probePluginRepo()` to confirm that a package really has both halves;
- the Desktop plugin root and native directory watcher;
- the Desktop installer with `force: false`;
- the catalog's immutable pinned commit SHA.

## UI

Click the **Mender** status-bar chip to open `/mender`.

The page shows:

- Agent/server half and Desktop half status;
- installed/pinned SHA;
- missing halves;
- security-preflight findings;
- the most recent repair actions;
- a manual **Repair now** action.

Raw plugin logs are intentionally not duplicated. Hermes already records Desktop/plugin console output in its normal Desktop log.

## Security preflight

Before Mender automatically materializes a missing half, it performs bounded static inspection of the source it is about to use.

Critical findings block automatic repair. High and medium findings are surfaced for review.

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