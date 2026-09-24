# Changelog

## 0.7.0-dev

- Add live Hermes compatibility status: Compatible / Degraded / Unsupported.
- Pause normal Mender mutations when a required Desktop/gateway contract is missing.
- Re-check compatibility on active connection changes; keep compatibility checking separate from update discovery.
- Make Core protection semantics explicit: Smart can approve one exact SHA, Strict has no bypass, Off allows at the Mender layer.
- Ignore stored Smart SHA approvals while Strict is selected.
- Add live-tested exact-version Core flow: allow same SHA, reject changed SHA, revoke, and verify Strict ignores Smart approval.
- Expand Core-tamper fixtures for direct Core writes, explicit runtime monkeypatching, package-manager runtime mutation, legitimate internal imports, supported Hermes overrides, and false-positive guards.
- Expand Security preflight for computed dynamic loading, decode/execute obfuscation chains, mutable remote dependencies, immutable dependency pins, and risky install lifecycle scripts.
- Fix Desktop inventory identity so findings no longer show undefined plugin names and Mender does not scan itself.
- Replace the native OS uninstall confirmation with Hermes SDK Dialog UI.
- Add state-aware per-package Enable / Disable actions.
- Add user-configurable Automatic repair modes: Auto / Interval / Off.
- Keep background reconciliation from making Repair now visibly enter a busy state.
- Replace the old fixed short polling loop with native events plus a conservative Auto fallback or user-selected interval.
- Keep Install and Install & enable as explicit one-shot GitHub actions while retaining the persisted Enable after install default for Enter.
- Guarantee the plain Install action leaves the Agent plugin disabled through Hermes' canonical toggle path.
- Live-verify GitHub install at an exact SHA, native Hermes success notifications, and cleanup.
- Fix unified GitHub-install Desktop materialization to prefer Hermes' normal package reconcile before a second clone, eliminating the observed duplicate-ID race.
- Add one deduplicated update plan shared by the banner, per-plugin Update, Update all, review dialog, and Mender self-update.
- Add Automatic update checks: Auto / Interval / Off, persisted separately from Automatic repair.
- Add manual Check updates in every update-check mode.
- Make update discovery read-only: no update is installed merely because a newer target exists.
- Change Update all into Review all updates; applying requires explicit confirmation in the shared Review updates dialog.
- Add per-plugin Update actions that open the same shared review UI.
- Keep capability widening fail-closed and never send accept_capabilities automatically.
- Classify Hermes host scanner blocks separately from generic update failures, including the current dashboard re-pin error-only contract.
- Continue mixed Update-all batches after independent failures/review holds.
- Add transactional Desktop-only updates with rollback of earlier writes when a later file fails.
- Add Mender self-update discovery through the same shared plan, exact-SHA/version verification, Security/Core preflight, stale-review protection, explicit confirmation, and file rollback.
- Allow Mender self-update recovery while general compatibility is Unsupported only when the minimal local read/write/root bridge is still available.
- Add an in-page update banner; live-verify automatic Mender update discovery without applying the update.
- Add retained backend E2E coverage for real catalog capability widening and Hermes Plugin Guard scanner-block behavior.
- Add a four-candidate confirmed Update-all regression covering success, generic failure, capability review, and Hermes scanner block in one batch.
- Add live per-plugin Update review/cancel verification with byte-identical local state restoration.
- Add bounded scroll regions for package, finding, and recent-action lists.
- Use an explicit runtime grid style for the wide two-column Mender layout because runtime plugins cannot rely on arbitrary prebuilt utility classes.
- Keep Plugin halves on the left and Security/Core/Recent actions on the right.
- Add private version-based development state under ignored `.private/DEV-STATE-0.7.0-dev.md`.
- Correct public README title and update public development/security documentation for Mender's expanded control-center scope.

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
