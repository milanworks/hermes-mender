# Hermes backend update E2E

This directory contains opt-in integration tests for Hermes Mender's update safety assumptions.

`hermes_update_backend_e2e.py` uses the installed Hermes Agent Python modules but redirects Hermes Home to isolated disposable directories. It covers:

- real catalog capability widening: an older `hermes-auto-titler` pin must require consent before changing the installed tree;
- Hermes scanner block during a catalog re-pin: a local two-commit fixture moves from a safe revision to a critical scanner signature and must remain on the old tree/revision;
- the current dashboard update contract for scanner blocks, including the fact that catalog re-pin blocks may arrive as `ok:false + error` without `scan_blocked:true`.

The test keeps its source in the repository, cleans only disposable homes/local Git fixtures, and never points Hermes at the user's production home. Cleanup is Windows-safe and the test is expected to be repeatable.

Run it with the Python interpreter from the installed Hermes Agent environment. Set `HERMES_AGENT_ROOT` if the test cannot discover that installation automatically.
