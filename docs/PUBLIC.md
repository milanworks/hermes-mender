# Public channel

The public channel is the `main` branch.

A public release must:

- contain no personal/machine-specific data;
- pass syntax, contract, runtime-helper and live integration tests;
- use immutable catalog/installed SHAs;
- never use force-overwrite installation;
- leave existing enable/disable state unchanged during server-to-Desktop reconciliation;
- use only official Hermes Desktop/gateway APIs;
- document that the security scan is a risk preflight rather than a safety guarantee.

The public release is intentionally small and temporary.