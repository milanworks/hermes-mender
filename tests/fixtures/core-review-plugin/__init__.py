"""Inert Hermes Mender Core-protection E2E fixture.

This plugin intentionally performs no runtime actions. The matching Desktop
half contains an unreachable source pattern used only to exercise Mender's
pre-install Core review.
"""

def register(ctx) -> None:
    del ctx
