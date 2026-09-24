# Security

Hermes Desktop plugins are not sandboxed. They run with the Desktop application's authority, so Hermes Mender treats repair, installation, and update as supply-chain operations.

## Trust model

Mender-controlled mutations require the strongest identity information available for that path:

- a Hermes catalog entry where applicable;
- an immutable 40-character Git commit SHA for checked Git sources;
- an unambiguous plugin/package match;
- package-shape confirmation before reconstructing a missing half;
- a fresh review when Core-sensitive source changes.

Existing plugin destinations are not blindly force-overwritten.

## Static preflight

Mender performs bounded source inspection before Mender-controlled install, repair, and update.

Current rule groups include:

- dynamic execution and Function/eval-style behavior;
- embedded private-key material and secret-like literals;
- gateway shell/CLI execution;
- process-execution libraries;
- Desktop file/plugin mutation capabilities;
- outbound network and environment access;
- clipboard and external-URL access;
- computed dynamic module loading;
- decode-then-execute / obfuscation chains;
- mutable remote dependency sources;
- immutable remote dependency pins;
- install lifecycle scripts that execute external commands;
- Hermes Core path/runtime/package-manager mutation patterns.

Security policy is user-selectable and persisted:

- **Smart** — critical findings block; high/medium findings are review signals.
- **Strict** — critical and high findings block.
- **Off** — Mender's supplemental Security scan is skipped.

Off never changes Hermes Core's host-owned plugin scanning.

Mender's scanner deliberately does **not** claim that a plugin is safe. Static inspection can miss indirect, runtime, dependency-driven, or intentionally disguised behavior.

## Relationship to the Hermes host scanner

Hermes itself runs a host-owned Plugin Guard during plugin install/re-pin when `plugins.scan_on_install` is enabled. Mender does not replace or disable it.

The two layers have different purposes:

- Mender preflight lets the Desktop show source/security/Core context before a Mender-controlled action;
- Hermes Plugin Guard is the host-side enforcement backstop before a server/catalog install is accepted.

A Hermes `dangerous` verdict remains blocked even if Mender's own policy would otherwise allow the operation.

The current Hermes dashboard update contract is not identical to the install contract: a catalog re-pin blocked by Plugin Guard can arrive as `ok:false` with an error beginning `Security scan blocked plugin install...` without `scan_blocked:true`. Mender recognizes both the structured flag and that host error so the UI classifies the result as a Hermes scanner block rather than a generic update failure.

This behavior has a retained isolated backend regression test under `tests/e2e/`.

## Data

Mender contains no user-specific hostnames, addresses, tokens, server IPs, machine IDs, or account identifiers.

Diagnostics are written only to local Hermes state/log surfaces used by Mender.

## Repair and activation policy

Repair and activation are separate decisions.

By default, a reconstructed Agent/server half is installed disabled. The Mender row exposes **Enable** or **Disable** according to the actual gateway status. Users can separately opt into automatic enablement of repaired Agent halves; Hermes security checks still run first.

Manual GitHub install actions are explicit:

- **Install** guarantees the Agent half is left disabled;
- **Install & enable** explicitly enables it.

The persisted **Enable after install** preference is only the default for the repository field's Enter action; it does not alter the meaning of those buttons.

## Update policy

### Discovery is not installation

Automatic update checking may be enabled, scheduled, or turned off. Discovery never applies an update.

All normal plugin updates, Desktop-only updates, Update-all batches, and Mender self-updates use one deduplicated update plan and require explicit confirmation in **Review updates** before application.

### Capability widening

Mender never auto-accepts a capability-widening catalog re-pin.

Hermes returns `consent_required` plus a surface delta; Mender holds that item for review and does not send `accept_capabilities: true` automatically.

### Hermes scanner blocks

Hermes Plugin Guard remains authoritative for host-side install/re-pin blocking. Scanner-blocked candidates are never treated as successful updates.

### Multi-candidate batches

A confirmed batch isolates candidates. One candidate that fails, needs capability review, or is blocked by the Hermes scanner does not silently convert unrelated candidates into failures and does not auto-approve the blocked item.

### Desktop-only updates

Desktop-only catalog updates are inspected before writing.

Only supported text payloads are updated in place. The write path is transactional: Mender records previous contents before writing and restores already-written files if a later write fails. Unsupported payload shapes are held for review rather than guessed at.

### Mender self-update

Mender self-update is part of the same update plan.

The self-update path:

1. resolves the canonical channel to an exact GitHub SHA;
2. validates Mender `VERSION`, plugin ID, and source;
3. runs Mender Security/Core preflight against that SHA;
4. shows the normal review UI;
5. after explicit confirmation, re-resolves the SHA and re-runs preflight;
6. replaces only the local Mender runtime file;
7. restores the previous file if the write fails.

No Mender self-update is installed automatically.

When the running Mender is **Unsupported**, self-update recovery is offered only if the minimal local Desktop root/read/write APIs required for safe replacement still work. Mender does not bypass a missing local write path by patching Hermes Core.

## Core-integrity policy

Core-integrity checks are separate from general Security findings.

- **Smart** — detected Core tampering pauses and requires a decision.
- **Strict** — detected Core tampering is blocked and has no per-version bypass.
- **Off** — Mender allows Core tampering at its layer.

A deliberate exception exists only in Smart and is bound to exact plugin identity + full 40-character commit SHA. The approval is persisted separately, visible in the UI, revocable, and not inherited by another commit. Strict ignores stored Smart approvals.

A Core exception cannot override a general Security block or Hermes Plugin Guard.

Direct imports of Hermes internals are review signals rather than automatic malware verdicts. Supported extension declarations such as `tools.override` and `llm.model_override` are not Core tampering by themselves.

This is defense-in-depth, not a sandbox. In-process plugins inherit Hermes Desktop/process permissions.

## Uninstall fallback safety

Uninstall uses Hermes' normal package-removal path and a Hermes SDK confirmation dialog.

The legacy compatibility fallback is used only when the connected gateway rejects the current remove RPC with the specific old-contract error. Mender validates the canonical plugin name against a strict allowlist before composing the official `hermes plugins remove <name>` command.

Arbitrary shell text is never accepted from the Mender UI.

## Public GitHub install safety

For Agent/server halves, Mender resolves and inspects a full commit SHA and passes that SHA as `ref` to Hermes.

For unified packages, Mender first asks Hermes to materialize the Desktop half from the already installed Agent package, avoiding a second clone where possible.

### Standalone Desktop Git limitation

Hermes' current standalone `installDesktopPlugin` bridge does not expose a Git ref/SHA parameter. If a separate Desktop clone is required, Hermes performs its normal clone first and Mender then reconciles the final files to the inspected SHA.

That gives an exact final state but is **not an atomic pre-execution sandbox**. A moving branch could theoretically change between inspection and clone/reconcile. Users who require a fully immutable Desktop installation path should prefer catalog/unified materialization or an upstream Desktop installer that accepts an immutable ref.

An exact-version Core approval does not remove this bridge limitation.
