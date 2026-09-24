"""Inert Hermes Mender Core-protection E2E fixture.

This plugin intentionally performs no runtime mutation. The unreachable helper
below exists only so Mender can exercise exact-SHA Core review before install.
"""

def never_execute_core_patch_fixture() -> None:
    from hermes_cli import plugins_cmd
    mock.patch.object(plugins_cmd, "_mender_fixture", None)


def register(ctx) -> None:
    del ctx
