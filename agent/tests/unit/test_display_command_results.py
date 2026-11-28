"""the display panel shows the self-test's result as the agent writes it, so its copy
is lowercase like the rest of the dashboard. the real handler runs on a stand-in
service (the descriptor binding test_cortex_process_command.py uses)."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.windows(reason='patches display_manager, which is windows-only')


def _service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        COMMAND_RATE_LIMIT_SECONDS=OwletteService.COMMAND_RATE_LIMIT_SECONDS,
        _command_rate_limits={},
        _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
        firebase_client=MagicMock(),
    )
    svc.handle_firebase_command = OwletteService.handle_firebase_command.__get__(svc, OwletteService)
    return svc


def test_the_self_test_result_is_lowercase(monkeypatch):
    import display_manager
    monkeypatch.setattr(
        display_manager, '_self_test_via_user_session',
        lambda: {'ok': True, 'monitors_seen': 2, 'query_ms': 0, 'validate_ms': 6},
    )

    result = _service().handle_firebase_command('c1', {'type': 'test_display_apply'})

    assert result == 'self-test ok — 2 monitors, query 0ms, validate 6ms'
