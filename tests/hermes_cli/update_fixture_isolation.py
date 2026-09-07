"""Isolation helpers for tests that drive the in-process updater.

The updater deliberately purges cached Hermes modules after a simulated pull.
Tests must therefore preserve the exact mocked boundary-module objects that
were installed before the purge; otherwise later imports can reach the host's
real process inventory and supervisors.
"""

from __future__ import annotations

import shutil
import sys
from types import ModuleType, SimpleNamespace


class UpdateFixtureIsolation:
    """Observable proof that updater runtime boundaries stayed mocked."""

    def __init__(self, modules: dict[str, ModuleType]):
        self.modules = modules
        self.calls: list[str] = []

    def record(self, name: str) -> None:
        self.calls.append(name)

    def assert_mocked_runtime_boundaries_used(self) -> None:
        required = {
            "purge",
            "collect_runtime_inventory",
            "supports_systemd_services",
            "find_gateway_pids",
            "find_profile_gateway_processes",
            "collect_fleet_versions",
            "finish_dashboard_update_cleanup",
        }
        missing = required.difference(self.calls)
        assert not missing, (
            "updater did not use every isolated runtime boundary; "
            f"missing={sorted(missing)}, calls={self.calls}"
        )
        replaced = [
            name for name, module in self.modules.items()
            if sys.modules.get(name) is not module
        ]
        assert not replaced, (
            "updater re-entered freshly imported runtime modules instead of "
            f"the isolated fixture boundaries: {replaced}"
        )


def isolate_update_runtime_boundaries(monkeypatch) -> UpdateFixtureIsolation:
    """Keep mocked inventory/supervisor modules stable across updater purge."""
    import hermes_cli
    from hermes_cli import config
    from hermes_cli import gateway
    from hermes_cli import main as hermes_main
    from hermes_cli import managed_uv
    from hermes_cli import update_cmd
    from hermes_cli import update_contract
    from hermes_cli import update_inventory
    from hermes_cli import update_receipt

    modules = {
        "hermes_cli.config": config,
        "hermes_cli.gateway": gateway,
        "hermes_cli.managed_uv": managed_uv,
        "hermes_cli.update_contract": update_contract,
        "hermes_cli.update_inventory": update_inventory,
        "hermes_cli.update_receipt": update_receipt,
    }
    isolation = UpdateFixtureIsolation(modules)

    def _empty_runtime_inventory():
        isolation.record("collect_runtime_inventory")
        return SimpleNamespace(runtimes=[], to_dict=lambda: {})

    def _find_gateway_pids(*args, **kwargs):
        isolation.record("find_gateway_pids")
        return []

    def _supports_systemd_services(*args, **kwargs):
        isolation.record("supports_systemd_services")
        return False

    def _find_profile_gateway_processes(*args, **kwargs):
        isolation.record("find_profile_gateway_processes")
        return []

    def _get_service_pids(*args, **kwargs):
        isolation.record("get_service_pids")
        return set()

    def _collect_fleet_versions(*args, **kwargs):
        isolation.record("collect_fleet_versions")
        return []

    def _finish_dashboard_update_cleanup(*args, **kwargs):
        isolation.record("finish_dashboard_update_cleanup")

    def _evaluate_update_admission(*args, **kwargs):
        isolation.record("evaluate_update_admission")
        return None

    def _update_node_dependencies(*args, **kwargs):
        isolation.record("update_node_dependencies")
        return []

    monkeypatch.setattr(
        update_inventory, "collect_runtime_inventory", _empty_runtime_inventory
    )
    monkeypatch.setattr(config, "_is_container", lambda: True)
    monkeypatch.setattr(gateway, "find_gateway_pids", _find_gateway_pids)
    monkeypatch.setattr(
        gateway, "supports_systemd_services", _supports_systemd_services
    )
    monkeypatch.setattr(gateway, "is_macos", lambda: False)
    monkeypatch.setattr(
        gateway, "find_profile_gateway_processes", _find_profile_gateway_processes
    )
    monkeypatch.setattr(gateway, "_get_service_pids", _get_service_pids)
    monkeypatch.setattr(gateway, "has_legacy_hermes_units", lambda: False)
    monkeypatch.setattr(
        update_receipt, "collect_fleet_versions", _collect_fleet_versions
    )
    monkeypatch.setattr(
        hermes_main,
        "_finish_dashboard_update_cleanup",
        _finish_dashboard_update_cleanup,
    )
    monkeypatch.setattr(
        update_cmd,
        "_finish_dashboard_update_cleanup",
        _finish_dashboard_update_cleanup,
    )
    monkeypatch.setattr(hermes_main, "_is_windows", lambda: False)
    monkeypatch.setattr(
        update_contract,
        "evaluate_update_admission",
        _evaluate_update_admission,
    )
    monkeypatch.setattr(
        update_cmd, "_update_node_dependencies", _update_node_dependencies
    )

    real_which = shutil.which

    def _without_live_cua_driver(name, *args, **kwargs):
        if name == "cua-driver":
            return None
        return real_which(name, *args, **kwargs)

    monkeypatch.setattr(shutil, "which", _without_live_cua_driver)

    original_purge = hermes_main._purge_stale_hermes_modules

    def _purge_then_restore_mocked_boundaries():
        isolation.record("purge")
        original_purge()
        for name, module in modules.items():
            sys.modules[name] = module
            setattr(hermes_cli, name.rsplit(".", 1)[1], module)

    monkeypatch.setattr(
        hermes_main,
        "_purge_stale_hermes_modules",
        _purge_then_restore_mocked_boundaries,
    )
    return isolation
