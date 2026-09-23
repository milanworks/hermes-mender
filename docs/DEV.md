# Development channel

The `dev` branch is where compatibility changes, security rules and UI improvements land before promotion.

Development builds may add diagnostics, but they must not:

- patch Hermes Core;
- mutate Hermes databases;
- add a Windows service or shell watcher;
- require SSH for gateway reconciliation;
- silently replace an existing plugin destination;
- contain personal environment details.

Promotion is done only after the live remote-gateway tests pass.