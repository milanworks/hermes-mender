# Integration evidence

This file records the acceptance checks used before the first public Mender release. Environment-specific identifiers are intentionally omitted.

## Server -> Desktop

Scenario:

- unified catalog package installed on the connected gateway;
- package status is `not enabled`;
- Desktop half is absent locally.

Expected:

- Mender does not change the gateway enable/disable state;
- Mender materializes the Desktop half;
- local Desktop file matches the server package's pinned Desktop file.

Result: **PASS**

The restored Desktop entry point had the same SHA-256 as the Desktop entry point shipped by the server-installed package.

## Desktop -> server

Scenario:

- exact pinned Desktop half present locally;
- matching unified catalog package absent from the connected gateway.

Expected:

- package is matched unambiguously by catalog identity;
- Hermes' Desktop probe confirms both halves;
- pinned runtime-capable source is statically inspected;
- gateway half is installed through `plugins.manage`;
- catalog provenance records the expected immutable SHA.

Result: **PASS**

The temporary test package was removed from both sides after verification.

## Installed but not enabled

Result: **PASS**

Installed packages with `not enabled` status are still reconciled. Mender treats installation presence and enablement as separate states.

## Catalog folder collision

Result: **PASS**

A synthetic Desktop plugin materialized under the generic `catalog` directory was renamed to its actual plugin ID by the native directory watcher.

## Update compatibility

Result: **PASS**

The host Hermes Desktop was updated through the official Windows installer/update chain, rebuilt successfully, relaunched, and Mender loaded under the updated Desktop SDK.

## Static tests

- JavaScript syntax check: PASS
- Contract assertions: PASS
- Executable helper/scanner tests: PASS