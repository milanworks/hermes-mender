# Security

Hermes Desktop plugins are not sandboxed. They run with the Desktop application's authority, so Mender treats automatic repair as a supply-chain operation.

## Trust model

Automatic repair requires:

- a Hermes catalog entry;
- an immutable 40-character commit SHA;
- an unambiguous plugin/package match;
- for Desktop-to-server repair, `probePluginRepo` confirmation that the package has both halves.

Existing plugin destinations are never force-overwritten.

## Static preflight

Mender inspects bounded source before automatic repair.

Current rule groups cover:

- dynamic code execution;
- embedded private-key material;
- gateway shell/CLI execution;
- process-execution libraries;
- Desktop file/plugin mutation capabilities;
- outbound network surfaces;
- environment/secret access;
- clipboard and external-URL access.

Security policy is user-selectable and persisted with Hermes plugin storage:

- **Smart**: critical findings block; high/medium findings are review signals.
- **Strict**: critical and high findings block.
- **Off**: Mender's supplemental scan is skipped.

Off never changes Hermes Core's `plugins.scan_on_install` setting. Server-side plugin installation remains subject to the host-owned Hermes scanner.

This scanner deliberately does **not** say that a plugin is safe. Static inspection can miss obfuscated, indirect, dependency-driven, or runtime behavior.

## Relationship to Hermes Plugin Guard

The unrelated community project named **Hermes Plugin Guard** is a broader static scanner for Hermes Agent/Python plugins. Mender does not install it, replace it, or depend on it. Mender's scanner is scoped to the sources involved in Mender's own automatic reconciliation so the two projects do not compete for installation control.

## Data

Mender contains no user-specific names, machine IDs, hostnames, addresses, tokens, server IPs, or account identifiers.

Diagnostics are written locally to the Hermes cache and normal Desktop log only.

## Activation policy

Repair and activation are separate decisions.

By default, a reconstructed Agent/server half is installed with `enable: false`. The Mender row then exposes an explicit **Enable** action using Hermes' canonical plugin key. Users can opt into automatic enablement with the persisted UI switch, but the Hermes install scan still runs first.

## Update policy

**Update all** never auto-accepts a capability-widening catalog update. Hermes returns `consent_required`; Mender reports that as review-required and leaves the installed tree unchanged.

Desktop-only updates are Mender-scanned before any file is changed. Packages with unsupported non-text Desktop payloads are skipped for review rather than guessed at.

## Core-integrity policy

Mender keeps Core-integrity checks separate from general malware/capability findings.

- **Smart** pauses on detected Core tampering and requires a decision.
- **Strict** blocks detected Core tampering and offers no per-version bypass.
- **Off** allows Core tampering at the Mender layer.

A deliberate exception can be created only in Smart, for an exact plugin identity + 40-character commit SHA. That approval is stored separately, shown in the UI, can be revoked, and is not inherited by another commit. Strict ignores stored Smart approvals. The exception affects Core protection only; it cannot override a general Security-mode block or Hermes' own host scanner.

Direct imports of Hermes internals are review signals rather than automatic malware verdicts. Declared, supported Hermes capabilities such as `tools.override` and `llm.model_override` are not considered Core tampering on their own.

This is defense-in-depth, not a sandbox. In-process plugins inherit the permissions of the Hermes process. A read-only/immutable Hermes application tree remains the strongest technical boundary against runtime Core modification.

## Uninstall fallback safety

The compatibility fallback is used only when the connected gateway rejects the current remove RPC with the specific legacy-contract error. Mender validates the canonical plugin name against a strict allowlist before composing the official `hermes plugins remove <name>` command. Arbitrary shell text is never accepted from the UI.

## Arbitrary GitHub Desktop install limitation

For Agent/server halves, Mender passes the resolved full commit SHA as `ref` to Hermes, so the host installs the exact source that Mender inspected.

The current Hermes Desktop `installDesktopPlugin` bridge does not expose a Git ref/SHA parameter. For a non-catalog GitHub Desktop plugin, Hermes therefore performs its normal Git clone first; Mender then immediately reconciles the materialized Desktop files to the already-inspected SHA.

That closes final-state drift but is **not an atomic pre-execution sandbox**: a moving branch could theoretically change between Mender's inspection and Hermes' Desktop clone. Users who require a fully immutable Desktop supply-chain path should prefer curated catalog pins or wait for an upstream Desktop installer that accepts an immutable ref.

An exact-version Core approval applies to the SHA Mender inspected; it does not convert this Desktop bridge limitation into a sandbox guarantee.