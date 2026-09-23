# Changelog

## 0.3.0-dev

- Add persistent Smart / Strict / Off security modes.
- Smart remains the default: critical findings block; high/medium remain visible.
- Strict blocks critical and high findings.
- Off disables only Mender's supplemental preflight; Hermes Core scan-on-install is never changed.

## 0.2.0-dev

- Rename project/plugin to **Hermes Mender**.
- Reconcile unified packages in both directions.
- Repair Desktop halves for installed packages regardless of enabled/not-enabled status.
- Add immutable-SHA runtime source inspection before automatic server-half installation.
- Add Desktop source preflight before automatic Desktop-half materialization.
- Add native Mender status page and status-bar chip.
- Add local diagnostic state under the Hermes cache.
- Keep the existing native directory watcher plus periodic remote reconciliation fallback.
- Add contract and executable helper tests.

## 0.1.0

- Initial Desktop-half repair.
- Repair `desktop-plugins/catalog` collisions.
- Restore missing Desktop halves from the server-installed pinned SHA.