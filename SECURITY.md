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

Critical findings block automatic repair. High/medium findings are reported in the Mender UI/state and require human interpretation.

This scanner deliberately does **not** say that a plugin is safe. Static inspection can miss obfuscated, indirect, dependency-driven, or runtime behavior.

## Relationship to Hermes Plugin Guard

The unrelated community project named **Hermes Plugin Guard** is a broader static scanner for Hermes Agent/Python plugins. Mender does not install it, replace it, or depend on it. Mender's scanner is scoped to the sources involved in Mender's own automatic reconciliation so the two projects do not compete for installation control.

## Data

Mender contains no user-specific names, machine IDs, hostnames, addresses, tokens, server IPs, or account identifiers.

Diagnostics are written locally to the Hermes cache and normal Desktop log only.