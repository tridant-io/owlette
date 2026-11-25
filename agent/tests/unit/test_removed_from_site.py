"""
Unit tests for the service's side of a dashboard removal (#326), and the one
way the service ends hoot.

The cloud client notices the removal (its config doc vanished; see
TestRemovedFromSite in test_firebase_client.py) and calls the service back.
These pin that the callback is wired at both cloud-client construction sites,
that it leaves the site through the same `unpair` a revoke uses, and that it
then waits for hoot to exit, so the client's final delete of the machine row
is the last write. `end_hoot` is what unpair and a site move both end hoot
with: it holds off the main loop's relaunch, so a hoot cannot come back on the
site being left. owlette_service is imported inside the tests, as elsewhere in
this suite, so collection order cannot double-initialise the cryptography
bindings.
"""

import inspect
import logging
import time
from types import SimpleNamespace
from unittest.mock import patch

import psutil


def _service_double():
    """OwletteService._on_removed_from_site, bound to the slice it touches."""
    from owlette_service import OwletteService

    calls = []
    double = SimpleNamespace(
        unpair=lambda reason, wait_for_hoot=False: calls.append(('unpair', reason, wait_for_hoot)),
    )
    double._on_removed_from_site = OwletteService._on_removed_from_site.__get__(double)
    return double, calls


def test_both_cloud_client_construction_sites_register_the_removal_callback():
    # the runner's boot path and the in-place restart build the client
    # separately; a removal on the one that forgot would write the row back
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService)
    assert source.count('register_removed_callback(self._on_removed_from_site)') == 2


def test_a_removal_leaves_the_site_and_waits_for_hoot_to_exit():
    # off Windows hoot answers SIGTERM with an `offline` write of its own,
    # which must land before the client deletes the row again
    double, calls = _service_double()

    double._on_removed_from_site('this machine was removed from the site on the dashboard')

    assert calls == [('unpair', 'this machine was removed from the site on the dashboard', True)]


# OwletteService.end_hoot

class FakeHoot:
    """psutil.Process for a live hoot: ending it is what makes it not alive."""

    def __init__(self, svc, calls):
        self.svc = svc
        self.calls = calls
        self.alive = True
        self.hangs = False

    def __call__(self, pid):
        self.calls.append(('process', pid))
        return self

    def terminate(self):
        # the relaunch is held off before hoot is gone, not after
        self.calls.append(('terminate', time.time() - self.svc._cortex_last_launch_time < 5))
        self.alive = False

    def wait(self, timeout=None):
        self.calls.append(('wait', timeout))
        if self.hangs:
            raise psutil.TimeoutExpired(timeout)


def _hoot_service(alive=True):
    """OwletteService.end_hoot and _try_launch_cortex, bound to the slice
    they touch, with hoot enabled on a paired machine."""
    from owlette_service import OwletteService

    calls = []
    svc = SimpleNamespace(
        cortex_pid=4242 if alive else None,
        _cortex_last_launch_time=0.0,
        _cortex_launch_cooldown=30,
        _publish_cortex_token=lambda wanted: None,
        launch_python_script_as_user=lambda name: calls.append(('launch', name)) or True,
    )
    hoot = FakeHoot(svc, calls)
    hoot.alive = alive
    svc._is_cortex_alive = lambda: hoot.alive
    svc.end_hoot = OwletteService.end_hoot.__get__(svc)
    svc._try_launch_cortex = OwletteService._try_launch_cortex.__get__(svc)
    return svc, hoot, calls


def test_ending_hoot_and_waiting_returns_once_it_has_exited():
    from owlette_service import HOOT_EXIT_TIMEOUT_SECONDS

    svc, hoot, calls = _hoot_service()

    with patch('owlette_service.psutil.Process', hoot):
        svc.end_hoot('this machine is moving to another site', wait=True)

    assert calls == [('process', 4242), ('terminate', True), ('wait', HOOT_EXIT_TIMEOUT_SECONDS)]
    assert HOOT_EXIT_TIMEOUT_SECONDS == 5.0


def test_ending_hoot_without_waiting_only_ends_it():
    svc, hoot, calls = _hoot_service()

    with patch('owlette_service.psutil.Process', hoot):
        svc.end_hoot('this machine left its site')

    assert calls == [('process', 4242), ('terminate', True)]


def test_ending_hoot_holds_off_its_relaunch():
    # the main loop's next tick must not start a hoot that reads the site
    # being left: a move names the new site in config.json only after this
    svc, hoot, calls = _hoot_service()
    config = {'cortex': {'enabled': True}, 'firebase': {'enabled': True, 'site_id': 'test-site'}}

    with patch('owlette_service.psutil.Process', hoot), \
         patch('owlette_service.shared_utils.read_config', return_value=config):
        svc.end_hoot('this machine is moving to another site', wait=True)
        assert svc._try_launch_cortex() is False

    assert ('launch', 'owlette_cortex.py') not in calls


def test_ending_hoot_holds_off_a_launch_even_when_none_is_running():
    # a hoot started between the switch's credential write and its config
    # write would read the old site just the same
    svc, hoot, calls = _hoot_service(alive=False)
    config = {'cortex': {'enabled': True}, 'firebase': {'enabled': True, 'site_id': 'test-site'}}

    with patch('owlette_service.psutil.Process', hoot), \
         patch('owlette_service.shared_utils.read_config', return_value=config):
        svc.end_hoot('this machine is moving to another site', wait=True)
        assert svc._try_launch_cortex() is False

    assert calls == []


def test_a_hoot_that_will_not_exit_is_logged_and_the_caller_goes_on(caplog):
    svc, hoot, calls = _hoot_service()
    hoot.hangs = True

    with patch('owlette_service.psutil.Process', hoot), caplog.at_level(logging.WARNING):
        svc.end_hoot('removed', wait=True)

    assert 'Hoot did not exit in time' in caplog.text
