# Changelog

## 0.7.0-dev

- Add live Hermes compatibility status: Compatible / Degraded / Unsupported.
- Pause automatic mutations when a required Desktop/gateway API contract is missing.
- Re-check compatibility on active connection changes.
- Make Core protection semantics explicit: Smart can approve one exact SHA, Strict has no bypass, Off allows at the Mender layer.
- Ignore stored Smart SHA approvals while Strict is selected.
- Expand Smart/Core review cards with exact findings, file, line and SHA context.
- Show Hermes capability-widening update details instead of a generic Review required line.
- Keep general Security blocks non-overridable by Core-version approvals.


## 0.6.0-dev

- Change Core protection semantics to Smart = ask, Strict = block, Off = allow at the Mender layer.
- Add revocable Core-protection exceptions bound to exact plugin identity + full commit SHA.
- Keep Core-protection exceptions separate from the normal Security mode; they cannot override a general Security block.
- Add checked public-GitHub installation from URL or owner/repo, including optional subdirectory.
- Add separate **Enable after install** control; default remains Off.
- Resolve GitHub installs to immutable SHAs, run Hermes repo probing plus Mender preflight, and use `force: false`.
- Keep GitHub private-repository credentials outside Mender; private repos use Hermes' normal installer.
- Live-verify remote uninstall intent with `hermes-rss`: both halves removed, no automatic reinstall, Missing stayed 0; then restore the original RSS state.
- Keep Plugin halves on the left and Security/Recent actions on the right on wide layouts.


## 0.5.0-dev

- Add independent Core protection modes: Smart / Strict / Off.
- Smart blocks high-confidence Hermes install-tree/runtime tamper while showing weaker internal coupling for review.
- Strict also blocks high-risk internal mutation/patch signals.
- Apply Core protection to repairs and checked Desktop-only updates without treating supported Hermes override APIs as tampering.
- Split the desktop layout: Plugin halves on the left; Security preflight and recent actions on the right.
- Keep Hermes native install scanning/capability consent active regardless of Mender Core-protection mode.
- Add compatibility Uninstall: new remove RPC first, official CLI fallback only for older gateways that reject that exact action.
- Run Mender security/Core preflight before Agent/unified Update all re-pins as well as before Desktop-only updates.


## 0.4.0-dev

- Add UI toggle for intentional-uninstall protection.
- Add UI toggle for automatic enablement of repaired Agent halves.
- Add per-plugin Enable action for installed-but-disabled Agent halves.
- Add unified Update all controller with Hermes capability-consent handling and Mender security preflight.
- Add checked in-place updates for supported Desktop-only catalog plugins without duplicate installs.
- Change summary cards to Missing / Blocked now / Critical signals / Advisory signals.
- Add visible `by @milanworks` project attribution.


## 0.3.1-dev

- Do not count true Desktop-only packages as missing Agent halves.
- Preserve intentional uninstall actions instead of immediately re-installing the removed Agent half.
- `Repair now` explicitly overrides the uninstall tombstone for recovery.
- Surface Hermes Core install-scan blocks in Mender findings.
- Clarify security findings as blocking signals vs risky capabilities.


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