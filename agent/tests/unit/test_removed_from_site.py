"""
Unit tests for the service's side of a dashboard removal (#326).

The cloud client notices the removal (its config doc vanished; see
TestRemovedFromSite in test_firebase_client.py) and calls the service back.
These pin that the callback is wired at both cloud-client construction sites,
that it leaves the site through the same `unpair` a revoke uses, and that it
then waits for hoot to exit, so the client's final delete of the machine row
is the last write. owlette_service is imported inside the tests, as elsewhere
in this suite, so collection order cannot double-initialise the cryptography
bindings.
"""

import inspect
import logging
from types import SimpleNamespace
from unittest.mock import patch

import psutil


def _service_double(hoot_pid=None):
    """OwletteService._on_removed_from_site, bound to the slice it touches."""
    from owlette_service import OwletteService

    calls = []
    double = SimpleNamespace(
        unpair=lambda reason: calls.append(('unpair', reason)),
        _is_cortex_alive=lambda: hoot_pid is not None,
        cortex_pid=hoot_pid,
        REMOVED_HOOT_EXIT_TIMEOUT_SECONDS=OwletteService.REMOVED_HOOT_EXIT_TIMEOUT_SECONDS,
    )
    double._on_removed_from_site = OwletteService._on_removed_from_site.__get__(double)
    return double, calls


def test_both_cloud_client_construction_sites_register_the_removal_callback():
    # the runner's boot path and the in-place restart build the client
    # separately; a removal on the one that forgot would write the row back
    from owlette_service import OwletteService

    source = inspect.getsource(OwletteService)
    assert source.count('register_removed_callback(self._on_removed_from_site)') == 2


def test_a_removal_leaves_the_site_then_waits_for_hoot_to_exit():
    double, calls = _service_double(hoot_pid=4242)

    with patch('owlette_service.psutil.Process') as process:
        process.return_value.wait.side_effect = lambda timeout: calls.append(('wait', timeout))
        double._on_removed_from_site('this machine was removed from the site on the dashboard')

    process.assert_called_once_with(4242)
    # off Windows hoot answers SIGTERM with an `offline` write of its own,
    # which must land before the client deletes the row again
    assert calls == [
        ('unpair', 'this machine was removed from the site on the dashboard'),
        ('wait', 5.0),
    ]


def test_a_removal_without_hoot_just_leaves():
    double, calls = _service_double()

    with patch('owlette_service.psutil.Process') as process:
        double._on_removed_from_site('removed')

    process.assert_not_called()
    assert calls == [('unpair', 'removed')]


def test_a_hoot_that_will_not_exit_is_logged_and_the_removal_goes_on(caplog):
    double, calls = _service_double(hoot_pid=4242)

    with patch('owlette_service.psutil.Process') as process, \
         caplog.at_level(logging.WARNING):
        process.return_value.wait.side_effect = psutil.TimeoutExpired(5.0)
        double._on_removed_from_site('removed')

    assert calls == [('unpair', 'removed')]
    assert 'Hoot did not exit in time' in caplog.text
