"""Regression tests for reached_max_relaunch_attempts and `relaunch_attempts: 0`.

0 has always been documented — and coded for — as "relaunch forever, never
escalate to a machine restart": the escalation branch carries an explicit
`relaunches_to_attempt != 0` guard, and the desktop app's tooltip says
"0 is unlimited".

It never worked. The value was normalised with `if not relaunches_to_attempt:
relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS`, and `not 0` is True, so every
explicit 0 became 3 before the guard could see it — making the guard dead code
and rebooting machines that were configured never to reboot.

The real method is bound onto a SimpleNamespace via the descriptor protocol
(matching test_cortex_process_command.py) so the production body runs without
constructing the Windows service.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


PROC = {'id': 'proc-1', 'name': 'TouchDesigner'}


def _make_service(attempts_so_far):
    from owlette_service import OwletteService

    svc = SimpleNamespace(
        relaunch_attempts={PROC['name']: attempts_so_far},
        first_start=False,
        firebase_client=MagicMock(),
        launch_desktop_app_as_user=MagicMock(return_value=True),
        log_and_notify=MagicMock(),
        _is_restart_prompt_active=MagicMock(return_value=False),
        _restart_prompt_until=0.0,
    )
    svc.firebase_client.is_connected.return_value = True
    svc.reached_max_relaunch_attempts = (
        OwletteService.reached_max_relaunch_attempts.__get__(svc, OwletteService))
    return svc


def _run(svc, configured_value):
    """Invoke the method with read_config returning `configured_value`."""
    with patch('owlette_service.shared_utils') as su:
        su.fetch_process_id_by_name.return_value = PROC['id']
        su.read_config.side_effect = lambda *a, **kw: (
            configured_value if kw.get('keys') == ['relaunch_attempts'] else {})
        return svc.reached_max_relaunch_attempts(PROC)


@pytest.mark.parametrize('configured', ['0', 0])
def test_zero_never_escalates_to_a_machine_restart(configured):
    """The whole point of 0: keep relaunching, never reboot the machine."""
    svc = _make_service(attempts_so_far=99)  # far beyond any sane limit
    reached = _run(svc, configured)

    assert reached is False, '0 must never report the limit as reached'
    svc.launch_desktop_app_as_user.assert_not_called(), 'no reboot prompt for unlimited'
    svc.firebase_client.set_reboot_pending.assert_not_called()
    # and it keeps counting, so the operator still sees relaunch activity
    assert svc.relaunch_attempts[PROC['name']] == 100


def test_a_real_limit_still_escalates():
    """Guard against 'fixing' 0 by disabling escalation for everyone."""
    svc = _make_service(attempts_so_far=4)  # 4 > 3
    reached = _run(svc, '3')

    assert reached is True
    svc.launch_desktop_app_as_user.assert_called_once()
    svc.firebase_client.set_reboot_pending.assert_called_once()


@pytest.mark.parametrize('configured', [None, '', 'abc', -1])
def test_absent_or_invalid_falls_back_to_the_default(configured):
    """Missing/garbage means "use the default", which still escalates."""
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    svc = _make_service(attempts_so_far=MAX_RELAUNCH_ATTEMPTS + 1)
    reached = _run(svc, configured)

    assert reached is True, f'{configured!r} should fall back to the default limit'
    svc.launch_desktop_app_as_user.assert_called_once()


def test_under_the_limit_does_not_escalate():
    svc = _make_service(attempts_so_far=1)
    assert _run(svc, '3') is False
    svc.launch_desktop_app_as_user.assert_not_called()
