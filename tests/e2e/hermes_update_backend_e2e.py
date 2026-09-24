"""Hermes backend update E2E tests for Mender.

Opt-in because they exercise the installed Hermes plugin backend, create local
Git repositories, and (for capability widening) read the live Hermes catalog.

They never use the user's production Hermes home. Everything runs inside an
isolated temporary Hermes home and is removed afterwards.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path


OLD_AUTO_TITLER_SHA = "edf67556f925328d114c48d7a6a1ce56dd313b64"


def hermes_agent_root() -> Path:
    explicit = os.environ.get("HERMES_AGENT_ROOT")
    if explicit:
        return Path(explicit).resolve()

    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "hermes" / "hermes-agent"
        if candidate.is_dir():
            return candidate.resolve()

    candidate = Path("/usr/local/lib/hermes-agent")
    if candidate.is_dir():
        return candidate.resolve()

    raise RuntimeError("Set HERMES_AGENT_ROOT to the installed Hermes Agent source tree.")


ROOT = hermes_agent_root()
sys.path.insert(0, str(ROOT))

from hermes_constants import reset_hermes_home_override, set_hermes_home_override  # noqa: E402
from hermes_cli import plugins_cmd, plugins_cmd_catalog as catalog  # noqa: E402


def _rmtree_onerror(func, path, _exc_info) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def remove_tree(path: Path) -> None:
    for attempt in range(4):
        try:
            shutil.rmtree(path, onerror=_rmtree_onerror)
        except FileNotFoundError:
            return
        except OSError:
            if attempt == 3:
                raise
            time.sleep(0.25 * (attempt + 1))
            continue
        if not path.exists():
            return
        time.sleep(0.25 * (attempt + 1))
    if path.exists():
        raise RuntimeError(f"Could not clean E2E directory: {path}")


def isolated_home(name: str) -> Path:
    # An explicit long path avoids the Windows 8.3-vs-long-name provenance
    # comparison edge seen with tempfile.mkdtemp().
    home = Path.home() / "Documents" / f".mender-e2e-{name}"
    remove_tree(home)
    home.mkdir(parents=True, exist_ok=True)
    return home


def run(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        list(args),
        cwd=str(cwd),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def git_commit(repo: Path, message: str) -> str:
    run("git", "add", ".", cwd=repo)
    run("git", "commit", "-m", message, cwd=repo)
    return run("git", "rev-parse", "HEAD", cwd=repo)


def test_capability_widening_requires_consent() -> dict:
    home = isolated_home("capability-widening")
    token = set_hermes_home_override(home)
    out: dict = {"test": "capability_widening"}

    try:
        current = catalog.get_live_catalog_entry("hermes-auto-titler")
        assert current is not None, "hermes-auto-titler missing from live catalog"
        historical = dataclasses.replace(current, sha=OLD_AUTO_TITLER_SHA)

        target, _manifest, installed_name = catalog.install_catalog_entry(
            historical,
            force=False,
            python_deps=False,
            scan_decision_cb=lambda _result: True,
        )
        sidecar = catalog.read_catalog_sidecar(target)
        assert sidecar, "historical catalog provenance was not retained"

        before_manifest = (target / "plugin.yaml").read_text(encoding="utf-8")
        metadata_path = home / "plugins" / ".install-metadata.json"
        before_metadata = metadata_path.read_text(encoding="utf-8")

        try:
            catalog.repin_catalog_plugin(target, sidecar, consent_cb=None)
        except catalog.RepinConsentRequired as exc:
            delta_lines = catalog.surface_delta_lines(exc.delta)
            assert any("pre_llm_call" in line for line in delta_lines), delta_lines
            out.update(
                {
                    "consent_required": True,
                    "installed_name": installed_name,
                    "old_sha": OLD_AUTO_TITLER_SHA,
                    "target_sha": exc.sha,
                    "delta_lines": delta_lines,
                }
            )
        else:
            raise AssertionError("capability-widening re-pin unexpectedly succeeded without consent")

        assert (target / "plugin.yaml").read_text(encoding="utf-8") == before_manifest
        assert metadata_path.read_text(encoding="utf-8") == before_metadata
        out["tree_unchanged"] = True
        out["metadata_unchanged"] = True
        return out
    finally:
        reset_hermes_home_override(token)
        remove_tree(home)


def test_scanner_blocks_repin_before_swap() -> dict:
    home = isolated_home("scanner-block")
    repo = Path.home() / "Documents" / ".mender-e2e-scanner-repo"
    remove_tree(repo)
    repo.mkdir(parents=True, exist_ok=True)

    run("git", "init", cwd=repo)
    run("git", "config", "user.email", "mender-e2e@example.invalid", cwd=repo)
    run("git", "config", "user.name", "Hermes Mender E2E", cwd=repo)

    (repo / "plugin.yaml").write_text(
        "name: mender-scanner-update-fixture\n"
        "version: 0.0.1\n"
        "manifest_version: 1\n"
        "api_version: 1\n"
        "description: Inert Mender scanner update fixture.\n",
        encoding="utf-8",
    )
    safe_source = (
        '"""Inert safe revision used by Hermes Mender scanner E2E."""\n'
        "def register(ctx):\n"
        "    del ctx\n"
    )
    (repo / "__init__.py").write_text(safe_source, encoding="utf-8")
    safe_sha = git_commit(repo, "safe fixture revision")

    # Critical Hermes scanner signature kept as data in an unreachable helper.
    # It is never executed; the test is specifically about scan-before-swap.
    blocked_source = (
        '"""Inert blocked revision used by Hermes Mender scanner E2E."""\n'
        "from pathlib import Path\n\n"
        "def never_execute():\n"
        "    return Path(\"~/.hermes/.env\").read_text()\n\n"
        "def register(ctx):\n"
        "    del ctx\n"
    )
    (repo / "__init__.py").write_text(blocked_source, encoding="utf-8")
    blocked_sha = git_commit(repo, "scanner-blocked fixture revision")

    token = set_hermes_home_override(home)
    original_catalog_lookup = catalog.get_live_catalog_entry
    out: dict = {"test": "scanner_block"}

    try:
        template = original_catalog_lookup("hermes-auto-titler")
        assert template is not None, "catalog template unavailable"

        repo_url = repo.as_uri()
        old_entry = dataclasses.replace(
            template,
            name="mender-scanner-update-fixture",
            repo=repo_url,
            sha=safe_sha,
            subdir=None,
        )
        new_entry = dataclasses.replace(old_entry, sha=blocked_sha)

        target, _manifest, installed_name = catalog.install_catalog_entry(
            old_entry,
            force=False,
            python_deps=False,
            scan_decision_cb=lambda _result: True,
        )
        sidecar = catalog.read_catalog_sidecar(target)
        assert sidecar, "fixture catalog provenance missing"

        before_source = (target / "__init__.py").read_text(encoding="utf-8")
        metadata_path = home / "plugins" / ".install-metadata.json"
        before_metadata = metadata_path.read_text(encoding="utf-8")

        catalog.get_live_catalog_entry = (
            lambda name: new_entry if name == "mender-scanner-update-fixture" else original_catalog_lookup(name)
        )

        result = plugins_cmd.dashboard_update_user_plugin(installed_name)
        error = str(result.get("error") or "")
        assert result.get("ok") is False, result
        assert "Security scan blocked plugin install" in error, result

        out.update(
            {
                "blocked": True,
                "installed_name": installed_name,
                "safe_sha": safe_sha,
                "blocked_sha": blocked_sha,
                "dashboard_result": result,
                "structured_scan_blocked": result.get("scan_blocked") is True,
                "mender_fallback_needed": result.get("scan_blocked") is not True,
            }
        )

        assert (target / "__init__.py").read_text(encoding="utf-8") == before_source == safe_source
        assert metadata_path.read_text(encoding="utf-8") == before_metadata
        out["tree_unchanged"] = True
        out["metadata_unchanged"] = True
        return out
    finally:
        catalog.get_live_catalog_entry = original_catalog_lookup
        reset_hermes_home_override(token)
        remove_tree(home)
        remove_tree(repo)


def main() -> None:
    results = [
        test_capability_widening_requires_consent(),
        test_scanner_blocks_repin_before_swap(),
    ]
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
