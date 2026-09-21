"""Tests for configure_site.py's headless modes (the desktop app's bridge).

Two things are being protected here:

1. The JSON line protocol the desktop app parses. Its other half lives in
   `desktop/src/lib/agentCli.ts`; a change on either side has to be made on
   both, and these assertions are what makes a one-sided change fail.
2. The interactive installer path, which must be untouched by any of it. The
   last test in this file is the regression check: with no mode flag,
   `_run_headless_mode` returns None and `main()` falls through to the flow the
   installer has always run.
"""

import argparse
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# No module-level skip guard, deliberately: a broken agent dependency must fail
# collection (pytest exit 2) rather than silently delete these tests behind a
# green run. Unguarded imports are the house norm (test_shared_utils.py:14,
# test_sync_state.py:10, test_command_router.py:8).
import shared_utils  # noqa: F401  (import side effects: path bootstrapping)
import configure_site


# helpers


def _args(**overrides):
    """An argparse.Namespace shaped like the real parser's output.

    `server` carries the environment token main() normalised it to, not the
    operator's raw 'dev'/'prod'.
    """
    defaults = {
        'url': None,
        'server': None,
        'add': None,
        'no_browser': False,
        'json_progress': False,
        'leave': False,
        'report_issue': None,
        'reboot_now': False,
        'dismiss_reboot': False,
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _events(capsys):
    """Every JSON line written to stdout, parsed, in order."""
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def _parser_args(argv):
    """Run argv through the real parser so the flag spellings are covered."""
    with patch.object(sys, 'argv', ['configure_site.py', *argv]), \
         patch.object(configure_site, '_run_headless_mode', return_value=0) as mode:
        configure_site.main()
    return mode.call_args.args[0]


# flag parsing


class TestFlagParsing:
    def test_each_mode_flag_is_accepted_and_lands_on_its_own_attribute(self):
        assert _parser_args(['--json-progress']).json_progress is True
        assert _parser_args(['--leave']).leave is True
        assert _parser_args(['--reboot-now']).reboot_now is True
        assert _parser_args(['--dismiss-reboot']).dismiss_reboot is True
        assert _parser_args(['--report-issue', 'C:\\tmp\\p.json']).report_issue == 'C:\\tmp\\p.json'

    def test_server_is_normalised_to_an_environment_token_exactly_once(self):
        # main() is the only normalisation point. A second pass would map the
        # already-normalised 'development' back to None, fall through to the
        # config's environment, and resolve a never-paired machine to production.
        assert _parser_args(['--server', 'dev']).server == 'development'
        assert _parser_args(['--server', 'prod']).server == 'production'
        assert _parser_args([]).server is None

    def test_an_unknown_server_is_refused_by_the_parser(self):
        with patch.object(sys, 'argv', ['configure_site.py', '--server', 'staging']), \
             patch.object(configure_site, '_run_headless_mode', return_value=0):
            with pytest.raises(SystemExit) as exit_info:
                configure_site.main()
        assert exit_info.value.code == 2

    def test_no_mode_flag_leaves_every_mode_off(self):
        args = _parser_args([])
        assert not any([
            args.json_progress, args.leave, args.reboot_now, args.dismiss_reboot,
        ])
        assert args.report_issue is None

    def test_main_returns_the_mode_exit_code_without_running_the_installer_flow(self):
        with patch.object(sys, 'argv', ['configure_site.py', '--leave']), \
             patch.object(configure_site, '_run_headless_mode', return_value=7), \
             patch.object(configure_site, 'run_pairing_flow') as pairing:
            assert configure_site.main() == 7
        pairing.assert_not_called()

    def test_two_modes_at_once_are_refused_rather_than_guessed(self, capsys):
        code = configure_site._run_headless_mode(_args(leave=True, reboot_now=True))
        assert code == 2
        events = _events(capsys)
        assert events[-1]['event'] == 'error'
        assert '--leave' in events[-1]['value'] and '--reboot-now' in events[-1]['value']

    def test_server_dev_reaches_json_progress_as_development(self):
        with patch.object(sys, 'argv', ['configure_site.py', '--json-progress', '--server', 'dev']), \
             patch.object(configure_site, 'run_json_progress', return_value=0) as progress:
            assert configure_site.main() == 0
        assert progress.call_args.kwargs == {'api_base': None, 'environment': 'development'}

    def test_server_prod_with_a_url_passes_both_through(self):
        with patch.object(configure_site, 'run_json_progress', return_value=0) as progress:
            code = configure_site._run_headless_mode(_args(
                json_progress=True, url='https://owlette.app/api', server='production',
            ))

        assert code == 0
        assert progress.call_args.kwargs == {
            'api_base': 'https://owlette.app/api', 'environment': 'production',
        }

    def test_a_url_without_a_server_is_refused_rather_than_guessed(self, capsys):
        # --url is a pure API-base override now; guessing the environment from it
        # is what wrote a production project_id for a dev URL.
        code = configure_site._run_headless_mode(_args(
            json_progress=True, url='https://dev.owlette.app/api',
        ))

        assert code == 2
        events = _events(capsys)
        assert events[-1]['event'] == 'error'
        assert '--server' in events[-1]['value']

    def test_an_unexpected_failure_becomes_one_error_event_and_a_non_zero_exit(self, capsys):
        with patch.object(configure_site, 'run_leave_site', side_effect=RuntimeError('boom')):
            code = configure_site._run_headless_mode(_args(leave=True))
        assert code == 1
        assert _events(capsys) == [{'event': 'error', 'value': 'boom'}]


# the line protocol


class TestEmit:
    def test_writes_one_json_object_per_line_and_flushes(self, capsys):
        configure_site._emit('status', 'stopping the service')
        configure_site._emit('done', {'ok': True})

        assert _events(capsys) == [
            {'event': 'status', 'value': 'stopping the service'},
            {'event': 'done', 'value': {'ok': True}},
        ]

    def test_non_ascii_is_escaped_so_a_cp1252_console_cannot_break_the_stream(self, capsys):
        configure_site._emit('error', 'could not reach owlette — check the network')
        raw = capsys.readouterr().out
        assert raw.endswith('\n')
        assert raw.isascii()
        assert json.loads(raw)['value'].endswith('check the network')


# --json-progress


class TestJsonProgress:
    def _run(self, capsys, *, success=True, message='Configuration successful', site='site-abc'):
        captured = {}

        def fake_flow(**kwargs):
            captured.update(kwargs)
            kwargs['on_phrase']({
                'pairPhrase': 'silver-compass-drift',
                'pairingUrl': 'https://dev.owlette.app/add?code=silver-compass-drift',
                'verificationUri': 'https://dev.owlette.app/add',
                'expiresIn': 600,
            })
            return (success, message, site if success else None)

        with patch.object(configure_site, 'run_pairing_flow', side_effect=fake_flow), \
             patch.object(configure_site, '_host_service', return_value=True) as host, \
             patch.object(configure_site.time, 'sleep'):
            code = configure_site.run_json_progress()

        return code, _events(capsys), captured, host

    def test_emits_phrase_then_status_then_authorized(self, capsys):
        code, events, _kwargs, _host = self._run(capsys)

        assert code == 0
        assert [event['event'] for event in events] == [
            'status', 'phrase', 'status', 'status', 'authorized',
        ]
        assert events[1]['value'] == {
            'pairPhrase': 'silver-compass-drift',
            'pairingUrl': 'https://dev.owlette.app/add?code=silver-compass-drift',
            'verificationUri': 'https://dev.owlette.app/add',
            'expiresIn': 600,
        }
        assert events[-1] == {
            'event': 'authorized',
            'value': {'siteId': 'site-abc', 'serviceRestarted': True},
        }

    def test_switches_off_every_console_and_clipboard_affordance(self, capsys):
        _code, _events_, kwargs, _host = self._run(capsys)

        # The desktop app renders the phrase and owns the clipboard; a helper
        # running in the background must not take either.
        assert kwargs['show_prompts'] is False
        assert kwargs['copy_clipboard'] is False

    def test_restarts_the_service_so_the_new_site_is_picked_up(self, capsys):
        _code, events, _kwargs, host = self._run(capsys)

        assert [call.args[0] for call in host.call_args_list] == ['stop', 'start']
        assert 'restarting the service' in [
            event['value'] for event in events if event['event'] == 'status'
        ]

    def test_reports_a_service_it_could_not_restart(self, capsys):
        # Stopping the service needs SERVICE_STOP, which a standard user lacks.
        # Pairing still succeeded, so it is reported rather than raised.
        def fake_flow(**kwargs):
            kwargs['on_phrase']({'pairPhrase': 'a-b-c'})
            return (True, 'Configuration successful', 'site-abc')

        with patch.object(configure_site, 'run_pairing_flow', side_effect=fake_flow),              patch.object(configure_site, '_host_service', return_value=False),              patch.object(configure_site.time, 'sleep'):
            code = configure_site.run_json_progress()

        assert code == 0
        assert _events(capsys)[-1]['value']['serviceRestarted'] is False

    def test_a_failure_is_one_error_event_and_no_service_restart(self, capsys):
        code, events, _kwargs, host = self._run(
            capsys, success=False, message='Pairing phrase expired.', site=None
        )

        assert code == 1
        assert events[-1] == {'event': 'error', 'value': 'Pairing phrase expired.'}
        host.assert_not_called()

    def test_the_environment_it_was_given_reaches_the_pairing_flow(self, capsys):
        captured = {}

        def fake_flow(**kwargs):
            captured.update(kwargs)
            kwargs['on_phrase']({'pairPhrase': 'a-b-c'})
            return (True, 'Configuration successful', 'site-abc')

        with patch.object(configure_site, 'run_pairing_flow', side_effect=fake_flow), \
             patch.object(configure_site, '_host_service', return_value=True), \
             patch.object(configure_site.time, 'sleep'):
            code = configure_site.run_json_progress(
                api_base='https://dev.owlette.app/api', environment='development'
            )

        capsys.readouterr()
        assert code == 0
        assert captured['api_base'] == 'https://dev.owlette.app/api'
        assert captured['environment'] == 'development'

    def test_the_cancel_hook_only_heartbeats_and_never_cancels(self, capsys):
        _code, _events_, kwargs, _host = self._run(capsys)
        capsys.readouterr()

        heartbeat = kwargs['should_cancel']
        # Polled every ~0.25s by poll_device_code — it must never abort the wait.
        assert heartbeat() is False
        assert heartbeat() is False
        assert _events(capsys) == []

        with patch.object(configure_site.time, 'monotonic', return_value=1e9):
            assert heartbeat() is False
        assert _events(capsys) == [{'event': 'status', 'value': 'waiting for authorization'}]


# --leave


class TestLeaveSite:
    CONFIG = {
        'firebase': {
            'enabled': True,
            'site_id': 'default_site',
            'project_id': 'owlette-dev-3838a',
            'api_base': 'https://dev.owlette.app/api',
        },
        'environment': 'development',
        'processes': [],
    }

    def _run(self, capsys, *, config=None, delete_raises=None, stopped=True, missing_cache=False):
        config = json.loads(json.dumps(config if config is not None else self.CONFIG))
        document = MagicMock()
        if delete_raises:
            document.delete.side_effect = delete_raises
        client = MagicMock()

        saved = {}

        with patch.object(configure_site.shared_utils, 'load_config', return_value=config), \
             patch.object(configure_site.shared_utils, 'save_config',
                          side_effect=lambda cfg: saved.update({'config': cfg})), \
             patch.object(configure_site.shared_utils, 'get_data_path',
                          return_value='C:\\ProgramData\\Owlette\\cache\\firebase_cache.json'), \
             patch.object(configure_site.os.path, 'exists', return_value=not missing_cache), \
             patch.object(configure_site.os, 'remove') as remove, \
             patch.object(configure_site, '_machine_document', return_value=(client, document)), \
             patch.object(configure_site, '_host_service', return_value=stopped) as host, \
             patch.object(configure_site.time, 'sleep'):
            code = configure_site.run_leave_site()

        return code, _events(capsys), saved.get('config'), document, host, remove, client

    def test_disables_cloud_sync_before_anything_else_touches_the_cloud(self, capsys):
        code, events, config, document, host, _remove, _client = self._run(capsys)

        assert code == 0
        assert config['firebase']['enabled'] is False
        assert config['firebase']['site_id'] == ''
        # Order is the whole point: config off, service stopped, then delete.
        assert [event['value'] for event in events if event['event'] == 'status'] == [
            'disabling cloud sync',
            'stopping the service',
            'deregistering this machine',
            'restarting the service',
        ]
        assert [call.args[0] for call in host.call_args_list] == ['stop', 'start']
        document.delete.assert_called_once()

    def test_addresses_the_site_captured_before_the_config_was_blanked(self, capsys):
        # owlette_gui.on_leave_site_click read site_id back out of the config it had
        # just cleared, so its delete addressed `sites//machines/{host}` and removed
        # nothing. The site is captured up front here.
        config = json.loads(json.dumps(self.CONFIG))
        with patch.object(configure_site.shared_utils, 'load_config', return_value=config), \
             patch.object(configure_site.shared_utils, 'save_config'), \
             patch.object(configure_site.shared_utils, 'get_data_path', return_value='cache.json'), \
             patch.object(configure_site.os.path, 'exists', return_value=False), \
             patch.object(configure_site, '_machine_document',
                          return_value=(MagicMock(), MagicMock())) as resolve, \
             patch.object(configure_site, '_host_service', return_value=True), \
             patch.object(configure_site.time, 'sleep'):
            configure_site.run_leave_site()

        capsys.readouterr()
        assert resolve.call_args.args == (
            'owlette-dev-3838a', 'https://dev.owlette.app/api', 'default_site',
        )

    def test_a_foreign_api_base_is_replaced_by_the_environment_base(self, capsys):
        # config.json is user-writable; the machine's credentials must stay on owlette.app
        config = json.loads(json.dumps(self.CONFIG))
        config['firebase']['api_base'] = 'https://attacker.example/api'
        with patch.object(configure_site.shared_utils, 'load_config', return_value=config), \
             patch.object(configure_site.shared_utils, 'save_config'), \
             patch.object(configure_site.shared_utils, 'get_data_path', return_value='cache.json'), \
             patch.object(configure_site.os.path, 'exists', return_value=False), \
             patch.object(configure_site, '_machine_document',
                          return_value=(MagicMock(), MagicMock())) as resolve, \
             patch.object(configure_site, '_host_service', return_value=True), \
             patch.object(configure_site.time, 'sleep'):
            configure_site.run_leave_site()

        capsys.readouterr()
        assert resolve.call_args.args[1] == 'https://dev.owlette.app/api'

    def test_deletes_the_cached_cloud_config(self, capsys):
        _code, _events_, _config, _document, _host, remove, _client = self._run(capsys)
        remove.assert_called_once()

    def test_reports_a_failed_deregistration_without_failing_the_leave(self, capsys):
        code, events, config, _document, host, _remove, client = self._run(
            capsys, delete_raises=RuntimeError('403 Forbidden')
        )

        # The machine is detached locally either way; the operator is told the
        # dashboard row survived so they can remove it there.
        assert code == 0
        assert config['firebase']['enabled'] is False
        assert events[-1] == {
            'event': 'done',
            'value': {'siteId': 'default_site', 'deregistered': False, 'serviceStopped': True},
        }
        assert [call.args[0] for call in host.call_args_list] == ['stop', 'start']
        client.close.assert_called_once()

    def test_records_a_service_that_could_not_be_stopped(self, capsys):
        _code, events, _config, _document, _host, _remove, _client = self._run(capsys, stopped=False)
        assert events[-1]['value']['serviceStopped'] is False

    def test_an_unpaired_machine_is_refused_before_the_config_is_written(self, capsys):
        config = {'firebase': {'enabled': False, 'site_id': ''}}
        with patch.object(configure_site.shared_utils, 'load_config', return_value=config), \
             patch.object(configure_site.shared_utils, 'save_config') as save, \
             patch.object(configure_site, '_host_service') as host:
            code = configure_site.run_leave_site()

        assert code == 1
        assert _events(capsys) == [
            {'event': 'error', 'value': 'this machine is not paired with a site'}
        ]
        save.assert_not_called()
        host.assert_not_called()


# --report-issue


class TestReportIssue:
    def _payload(self, tmp_path, **fields):
        path = tmp_path / 'feedback.json'
        path.write_text(json.dumps({'category': 'bug', 'description': 'it broke', **fields}))
        return str(path)

    def test_submits_the_payload_and_deletes_it(self, tmp_path, capsys):
        path = self._payload(tmp_path)

        with patch.object(configure_site, 'build_report_data',
                          return_value={'category': 'bug'}) as build, \
             patch.object(configure_site, 'submit_report') as submit:
            code = configure_site.run_report_issue(path)

        assert code == 0
        assert _events(capsys)[-1] == {'event': 'done', 'value': {'category': 'bug'}}
        build.assert_called_once_with('bug', 'it broke')
        submit.assert_called_once()
        # The operator's description must not be left lying on disk.
        assert not (tmp_path / 'feedback.json').exists()

    def test_an_empty_description_never_reaches_the_api(self, tmp_path, capsys):
        path = self._payload(tmp_path, description='   ')

        with patch.object(configure_site, 'submit_report') as submit:
            code = configure_site.run_report_issue(path)

        assert code == 1
        assert _events(capsys)[-1]['event'] == 'error'
        submit.assert_not_called()

    def test_an_unreadable_payload_is_an_error_not_a_crash(self, tmp_path, capsys):
        code = configure_site.run_report_issue(str(tmp_path / 'nope.json'))
        assert code == 1
        assert _events(capsys)[-1]['event'] == 'error'

    def test_a_rejected_submission_is_reported_verbatim(self, tmp_path, capsys):
        path = self._payload(tmp_path)

        with patch.object(configure_site, 'build_report_data', return_value={}), \
             patch.object(configure_site, 'submit_report',
                          side_effect=RuntimeError('the server rejected the report (401)')):
            code = configure_site.run_report_issue(path)

        assert code == 1
        assert '401' in _events(capsys)[-1]['value']

    @pytest.mark.parametrize('raw,expected', [
        ('bug', 'bug'),
        ('feature_request', 'feature_request'),
        ('feature request', 'feature_request'),   # legacy dialog's label
        ('compliment', 'compliment'),
        ('rant', 'rant'),
        ('other', 'other'),
        ('BUG', 'bug'),
        ('nonsense', 'other'),
        ('', 'other'),
        (None, 'other'),
    ])
    def test_categories_are_normalised_to_what_the_api_accepts(self, raw, expected):
        assert configure_site._normalize_report_category(raw) == expected


# --reboot-now / --dismiss-reboot


class TestRebootModes:
    def test_the_reboot_intent_is_recorded_before_the_shutdown_is_issued(self, capsys):
        calls = []
        session_state = MagicMock()
        session_state.set_intent.side_effect = lambda intent: calls.append(('intent', intent))

        with patch.dict(sys.modules, {'session_state': session_state}), \
             patch.object(configure_site.subprocess, 'run',
                          side_effect=lambda *a, **k: calls.append(('run', a[0]))) as run:
            code = configure_site.run_reboot_now()

        assert code == 0
        # Order matters: an intent written after a hung shutdown call is lost,
        # and the next boot is misclassified as unexpected.
        assert calls[0] == ('intent', 'owlette_reboot')
        assert run.call_args.args[0] == ['shutdown', '/r', '/t', '1']
        assert _events(capsys)[-1] == {'event': 'done', 'value': {'rebooting': True}}

    def test_a_missing_intent_never_blocks_the_reboot(self):
        session_state = MagicMock()
        session_state.set_intent.side_effect = OSError('tmp is read-only')

        with patch.dict(sys.modules, {'session_state': session_state}), \
             patch.object(configure_site.subprocess, 'run') as run:
            code = configure_site.run_reboot_now()

        assert code == 0
        run.assert_called_once()

    def test_a_failed_shutdown_is_reported(self, capsys):
        session_state = MagicMock()
        with patch.dict(sys.modules, {'session_state': session_state}), \
             patch.object(configure_site.subprocess, 'run', side_effect=OSError('Access is denied')):
            code = configure_site.run_reboot_now()

        assert code == 1
        assert 'Access is denied' in _events(capsys)[-1]['value']

    def test_dismiss_clears_the_same_shape_the_service_writes(self, capsys):
        document = MagicMock()
        client = MagicMock()
        config = {'firebase': {
            'site_id': 'default_site',
            'project_id': 'owlette-dev-3838a',
            'api_base': 'https://dev.owlette.app/api',
        }}

        with patch.object(configure_site.shared_utils, 'read_config', return_value=config), \
             patch.object(configure_site, '_machine_document', return_value=(client, document)):
            code = configure_site.run_dismiss_reboot()

        assert code == 0
        # firebase_client.clear_reboot_pending writes exactly this.
        document.set.assert_called_once_with({
            'rebootPending': {
                'active': False,
                'processName': None,
                'reason': None,
                'timestamp': None,
            }
        }, merge=True)
        assert _events(capsys)[-1] == {'event': 'done', 'value': {'cleared': True}}
        client.close.assert_called_once()

    def test_dismiss_on_an_unpaired_machine_succeeds_with_nothing_to_do(self, capsys):
        with patch.object(configure_site.shared_utils, 'read_config',
                          return_value={'firebase': {'site_id': ''}}), \
             patch.object(configure_site, '_machine_document') as resolve:
            code = configure_site.run_dismiss_reboot()

        assert code == 0
        resolve.assert_not_called()
        assert _events(capsys)[-1]['value']['cleared'] is False

    def test_dismiss_reports_a_cloud_failure(self, capsys):
        with patch.object(configure_site.shared_utils, 'read_config',
                          return_value={'firebase': {'site_id': 's', 'project_id': 'p'}}), \
             patch.object(configure_site, '_machine_document',
                          side_effect=RuntimeError('owlette is not authenticated with the cloud')):
            code = configure_site.run_dismiss_reboot()

        assert code == 1
        assert 'not authenticated' in _events(capsys)[-1]['value']


# the installer path is untouched


class TestInteractivePathUnchanged:
    def test_no_mode_flag_means_no_headless_dispatch(self, capsys):
        assert configure_site._run_headless_mode(_args()) is None
        assert _events(capsys) == []

    def test_the_installer_flags_do_not_trigger_a_headless_mode(self, capsys):
        for args in (
            _args(url='https://dev.owlette.app/api'),
            _args(add='silver-compass-drift'),
            _args(no_browser=True),
        ):
            assert configure_site._run_headless_mode(args) is None
        assert _events(capsys) == []

    def test_the_console_flow_still_copies_the_phrase_by_default(self):
        # copy_clipboard defaults to True so the installer keeps the affordance
        # the operator relies on; only the desktop app passes False.
        import inspect
        signature = inspect.signature(configure_site.run_pairing_flow)
        assert signature.parameters['copy_clipboard'].default is True

    def test_a_console_url_without_a_server_never_reaches_the_pairing_flow(self, capsys):
        with patch.object(sys, 'argv', ['configure_site.py', '--url', 'http://localhost:3000/api']), \
             patch.object(configure_site, 'run_pairing_flow') as pairing:
            assert configure_site.main() == 2

        pairing.assert_not_called()
        assert '--server' in capsys.readouterr().out

    def test_a_failed_console_run_never_waits_on_a_keypress(self, tmp_path, capsys):
        # The console can run with the installer wizard holding the foreground,
        # where a keypress may never reach it; a pause there hangs Setup on the
        # kiosk images that must never block. Both recovery routes are printed.
        with patch.object(sys, 'argv', ['configure_site.py']), \
             patch.object(configure_site.shared_utils, 'get_data_path',
                          side_effect=lambda relative: str(tmp_path / relative)), \
             patch.object(configure_site, 'run_pairing_flow',
                          return_value=(False, 'Authorization failed', None)), \
             patch('builtins.input', side_effect=AssertionError('the console must never block')):
            assert configure_site.main() == 1

        out = capsys.readouterr().out
        assert 'Press Enter to continue' not in out
        assert 'join a site' in out
        assert '--server <dev|prod>' in out


# service host helper


class TestServiceHostHelper:
    def test_a_missing_host_is_not_an_exception(self):
        with patch.object(configure_site.os.path, 'exists', return_value=False):
            assert configure_site._host_service('stop') is False

    def test_success_is_a_zero_return_code(self):
        completed = MagicMock()
        completed.returncode = 0
        with patch.object(configure_site.os.path, 'exists', return_value=True), \
             patch.object(configure_site.subprocess, 'run', return_value=completed):
            assert configure_site._host_service('start') is True

    def test_a_non_zero_return_code_is_reported_not_raised(self):
        completed = MagicMock()
        completed.returncode = 2
        with patch.object(configure_site.os.path, 'exists', return_value=True), \
             patch.object(configure_site.subprocess, 'run', return_value=completed):
            assert configure_site._host_service('stop') is False

    def test_a_hung_host_is_swallowed(self):
        with patch.object(configure_site.os.path, 'exists', return_value=True), \
             patch.object(configure_site.subprocess, 'run', side_effect=OSError('timeout')):
            assert configure_site._host_service('stop') is False

    def test_the_verb_goes_to_the_host_binary_in_the_install_tree(self):
        completed = MagicMock()
        completed.returncode = 0
        with patch.object(configure_site.os.path, 'exists', return_value=True), \
             patch.object(configure_site.subprocess, 'run', return_value=completed) as run:
            configure_site._host_service('stop')

        command = run.call_args.args[0]
        # The host knows which service it hosts, so — unlike nssm — the name is
        # not passed on the command line.
        assert command[0].endswith(os.path.join('tools', 'owlette-host.exe'))
        assert command[1:] == ['stop']
