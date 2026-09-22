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
import logging
import os
import stat
import sys
import threading
import time
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
        'no_service_restart': False,
        'leave': False,
        'report_issue': None,
        'reboot_now': False,
        'dismiss_reboot': False,
        'preseed': False,
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _events(capsys):
    """Every JSON line written to stdout, parsed, in order."""
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.strip()]


posix_only = pytest.mark.skipif(
    sys.platform == 'win32', reason='the POSIX privileged-request seam')


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
        assert _parser_args(['--preseed']).preseed is True
        assert _parser_args(['--report-issue', 'C:\\tmp\\p.json']).report_issue == 'C:\\tmp\\p.json'

    def test_the_service_restart_can_be_switched_off_for_the_daemons_own_child(self):
        # The pairing the daemon spawns into the `ipc/` seam runs inside the
        # unit that restart would stop.
        assert _parser_args(['--json-progress']).no_service_restart is False
        assert _parser_args(
            ['--json-progress', '--no-service-restart']).no_service_restart is True

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
            args.preseed,
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
        assert progress.call_args.kwargs == {
            'api_base': None, 'environment': 'development', 'restart_service': True,
        }

    def test_server_prod_with_a_url_passes_both_through(self):
        with patch.object(configure_site, 'run_json_progress', return_value=0) as progress:
            code = configure_site._run_headless_mode(_args(
                json_progress=True, url='https://owlette.app/api', server='production',
            ))

        assert code == 0
        assert progress.call_args.kwargs == {
            'api_base': 'https://owlette.app/api', 'environment': 'production',
            'restart_service': True,
        }

    def test_no_service_restart_reaches_the_pairing_run(self):
        with patch.object(configure_site, 'run_json_progress', return_value=0) as progress:
            code = configure_site._run_headless_mode(_args(
                json_progress=True, no_service_restart=True,
            ))

        assert code == 0
        assert progress.call_args.kwargs['restart_service'] is False

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
             patch.object(configure_site, '_service_control', return_value=True) as host, \
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

    def test_the_daemons_own_child_leaves_the_service_it_runs_inside_alone(
            self, capsys):
        # The seam spawns this run from inside the unit, whose stop takes the
        # whole control group down with it on a default systemd install. The
        # restart was only ever a latency optimisation: the daemon re-reads the
        # firebase config every two loop iterations.
        def fake_flow(**kwargs):
            kwargs['on_phrase']({'pairPhrase': 'a-b-c'})
            return (True, 'Configuration successful', 'site-abc')

        with patch.object(configure_site, 'run_pairing_flow', side_effect=fake_flow), \
             patch.object(configure_site, '_service_control') as host, \
             patch.object(configure_site.time, 'sleep'):
            code = configure_site.run_json_progress(restart_service=False)

        assert code == 0
        host.assert_not_called()
        events = _events(capsys)
        assert 'restarting the service' not in [
            event['value'] for event in events if event['event'] == 'status'
        ]
        assert events[-1] == {
            'event': 'authorized',
            'value': {'siteId': 'site-abc', 'serviceRestarted': False},
        }

    def test_reports_a_service_it_could_not_restart(self, capsys):
        # Stopping the service needs SERVICE_STOP, which a standard user lacks.
        # Pairing still succeeded, so it is reported rather than raised.
        def fake_flow(**kwargs):
            kwargs['on_phrase']({'pairPhrase': 'a-b-c'})
            return (True, 'Configuration successful', 'site-abc')

        with patch.object(configure_site, 'run_pairing_flow', side_effect=fake_flow),              patch.object(configure_site, '_service_control', return_value=False),              patch.object(configure_site.time, 'sleep'):
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
             patch.object(configure_site, '_service_control', return_value=True), \
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
             patch.object(configure_site, '_service_control', return_value=stopped) as host, \
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
             patch.object(configure_site, '_service_control', return_value=True), \
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
             patch.object(configure_site, '_service_control', return_value=True), \
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
             patch.object(configure_site, '_service_control') as host:
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

        with patch.object(configure_site.osadapter, 'reboot',
                          side_effect=lambda delay, message=None:
                              calls.append(('reboot', delay, message))) as reboot, \
             patch.dict(sys.modules, {'session_state': session_state}):
            code = configure_site.run_reboot_now()

        assert code == 0
        # Order matters: an intent written after a hung shutdown call is lost,
        # and the next boot is misclassified as unexpected.
        assert calls[0] == ('intent', 'owlette_reboot')
        # The reboot subsystem is the adapter's; this module names neither
        # `shutdown /r` nor `shutdown -r` any more.
        reboot.assert_called_once_with(1, configure_site._REBOOT_MESSAGE)
        assert _events(capsys)[-1] == {'event': 'done', 'value': {'rebooting': True}}

    def test_a_missing_intent_never_blocks_the_reboot(self):
        session_state = MagicMock()
        session_state.set_intent.side_effect = OSError('tmp is read-only')

        with patch.object(configure_site.osadapter, 'reboot') as reboot, \
             patch.dict(sys.modules, {'session_state': session_state}):
            code = configure_site.run_reboot_now()

        assert code == 0
        reboot.assert_called_once()

    def test_a_failed_shutdown_is_reported(self, capsys):
        session_state = MagicMock()
        with patch.object(configure_site.osadapter, 'reboot',
                          side_effect=OSError('Access is denied')), \
             patch.dict(sys.modules, {'session_state': session_state}):
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


# service control


class TestServiceControl:
    def test_the_verb_and_the_agent_service_go_to_the_adapter(self):
        # `owlette-host.exe` was the Windows spelling of this; the unit name on
        # Linux and the launchctl label on macOS are the adapter's to know.
        with patch.object(configure_site.osadapter, 'service_control',
                          return_value=True) as control:
            assert configure_site._service_control('stop') is True

        control.assert_called_once_with('stop', shared_utils.SERVICE_NAME)

    def test_a_control_that_did_not_reach_the_state_is_reported(self):
        with patch.object(configure_site.osadapter, 'service_control',
                          return_value=False):
            assert configure_site._service_control('start') is False

    def test_an_adapter_that_raises_never_breaks_a_leave(self):
        # A standard user is not granted SERVICE_STOP and off Windows the unit
        # is the init system's; leaving a site must complete either way, with
        # the caller told which half happened.
        with patch.object(configure_site.osadapter, 'service_control',
                          side_effect=OSError('access is denied')):
            assert configure_site._service_control('stop') is False

    def test_a_platform_with_no_adapter_is_a_refusal_not_a_crash(self):
        with patch.object(configure_site.osadapter, 'service_control',
                          side_effect=NotImplementedError('no osadapter for aix')):
            assert configure_site._service_control('stop') is False


# --preseed


class TestPreseed:
    """The POSIX analogue of `/ADD=<phrase> /SILENT`.

    `postinst` / `postinstall` writes the preseed and runs `--preseed`; the
    decision order is `owlette_installer.iss`'s ShouldConfigureSite, and the
    file is spent the moment a pairing succeeds.
    """

    @pytest.fixture
    def data_root(self, tmp_path, monkeypatch):
        monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
        monkeypatch.setattr(configure_site, 'CONFIG_PATH',
                            tmp_path / 'config' / 'config.json')
        # The packaged case: an image built before anyone has logged in.
        monkeypatch.setattr(configure_site.osadapter, 'console_user', lambda: None)
        (tmp_path / 'config').mkdir()
        return tmp_path

    def _seed(self, data_root, **fields):
        path = data_root / 'config' / 'pairing.json'
        path.write_text(json.dumps(fields))
        return path

    def _paired(self, data_root, site_id='site-abc'):
        (data_root / 'config' / 'config.json').write_text(json.dumps({
            'firebase': {'enabled': True, 'site_id': site_id},
        }))

    def test_the_preseed_phrase_pairs_and_is_spent(self, data_root, capsys):
        seed = self._seed(data_root, phrase='silver-compass-drift', kiosk_user='kiosk')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'Configuration successful', 'site-abc')) as flow:
            assert configure_site.run_preseed() == 0

        assert flow.call_args.kwargs['add_phrase'] == 'silver-compass-drift'
        assert not seed.exists()
        assert (data_root / 'config' / 'pairing.json.used').exists()
        assert _events(capsys)[-1] == {'event': 'done', 'value': {
            'paired': True, 'siteId': 'site-abc', 'kioskUser': 'kiosk',
        }}

    def test_a_spent_preseed_never_pairs_again(self, data_root, capsys):
        # Device codes are single-use server-side: re-running the maintainer
        # script must not spend a phrase the server has already consumed.
        self._seed(data_root, phrase='silver-compass-drift')
        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')):
            configure_site.run_preseed()
        capsys.readouterr()

        with patch.object(configure_site, 'run_pairing_flow') as flow:
            assert configure_site.run_preseed() == 0

        flow.assert_not_called()
        assert _events(capsys)[-1]['value']['reason'] == 'no pairing preseed'

    def test_a_machine_that_already_carries_a_site_is_skipped(self, data_root, capsys):
        seed = self._seed(data_root, phrase='silver-compass-drift')
        self._paired(data_root)

        with patch.object(configure_site, 'run_pairing_flow') as flow:
            assert configure_site.run_preseed() == 0

        flow.assert_not_called()
        assert _events(capsys)[-1]['value']['reason'] == 'already paired'
        # An upgrade leaves the preseed alone — nothing was spent.
        assert seed.exists()

    def test_a_half_written_config_is_not_a_paired_machine(self, data_root, capsys):
        # `"site_id": ""` with the flag already flipped is the case
        # ShouldConfigureSite guards against: pairing must still run.
        self._seed(data_root, phrase='silver-compass-drift')
        (data_root / 'config' / 'config.json').write_text(json.dumps({
            'firebase': {'enabled': True, 'site_id': ''},
        }))

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')) as flow:
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        flow.assert_called_once()

    def test_a_config_that_is_not_an_object_never_breaks_the_install(
            self, data_root, capsys):
        # A maintainer script must survive whatever is on disk: anything but a
        # config carrying a site reads as unpaired and pairing runs.
        self._seed(data_root, phrase='silver-compass-drift')
        (data_root / 'config' / 'config.json').write_text('[]')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')) as flow:
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        flow.assert_called_once()

    def test_owlette_add_re_pairs_a_machine_that_already_carries_a_site(
            self, data_root, monkeypatch, capsys):
        self._paired(data_root)
        monkeypatch.setenv('OWLETTE_ADD', 'silver-compass-drift')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-xyz')) as flow:
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        assert flow.call_args.kwargs['add_phrase'] == 'silver-compass-drift'

    def test_the_environment_variable_wins_over_the_file(
            self, data_root, monkeypatch, capsys):
        self._seed(data_root, phrase='from-the-file')
        monkeypatch.setenv('OWLETTE_ADD', 'from-the-environment')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')) as flow:
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        assert flow.call_args.kwargs['add_phrase'] == 'from-the-environment'

    def test_a_failed_pairing_leaves_the_preseed_for_a_retry(self, data_root, capsys):
        seed = self._seed(data_root, phrase='silver-compass-drift')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(False, 'Pairing phrase expired.', None)):
            assert configure_site.run_preseed() == 1

        assert seed.exists()
        assert _events(capsys)[-1] == {
            'event': 'error', 'value': 'Pairing phrase expired.'}

    @pytest.mark.parametrize('token,expected', [
        ('dev', 'development'),
        ('prod', 'production'),
        ('PROD', 'production'),
        ('', None),
        ('staging', None),
    ])
    def test_the_server_token_chooses_the_environment(
            self, data_root, capsys, token, expected):
        self._seed(data_root, phrase='silver-compass-drift', server=token)

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')) as flow:
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        assert flow.call_args.kwargs['environment'] == expected

    def test_a_server_token_that_is_neither_is_named_in_the_log(
            self, data_root, capsys, caplog):
        # An unrecognised token resolves a never-paired machine to production,
        # so a dev phrase written `"server": "development"` would be spent
        # against owlette.app. The log has to say which environment was used.
        self._seed(data_root, phrase='silver-compass-drift', server='development')

        with caplog.at_level(logging.WARNING), \
             patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')):
            assert configure_site.run_preseed() == 0

        capsys.readouterr()
        assert "'development'" in caplog.text
        assert 'production' in caplog.text

    def test_the_kiosk_user_falls_back_to_the_graphical_session(
            self, data_root, monkeypatch, capsys):
        monkeypatch.setattr(configure_site.osadapter, 'console_user', lambda: 'kiosk')
        self._seed(data_root, phrase='silver-compass-drift')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')):
            assert configure_site.run_preseed() == 0

        assert _events(capsys)[-1]['value']['kioskUser'] == 'kiosk'

    def test_a_corrupt_preseed_never_fails_the_install(self, data_root, capsys):
        (data_root / 'config' / 'pairing.json').write_text('{not json')

        with patch.object(configure_site, 'run_pairing_flow') as flow:
            assert configure_site.run_preseed() == 0

        flow.assert_not_called()
        assert _events(capsys)[-1]['value']['reason'] == 'no pairing preseed'

    @posix_only
    def test_a_preseed_swapped_for_a_link_is_not_read_through(
            self, data_root, capsys):
        """`config/` is group-writable, so the file `postinst` hands to
        `--preseed` as root is one the session can replace — with a link at a
        root-only JSON file whose fields would reach the log and the postinst's
        stdout, or with a fifo that stalls the maintainer script."""
        secret = data_root / 'secret.json'
        secret.write_text(json.dumps({'kiosk_user': 'root-only-secret'}),
                          encoding='utf-8')
        (data_root / 'config' / 'pairing.json').symlink_to(secret)

        with patch.object(configure_site, 'run_pairing_flow') as flow:
            assert configure_site.run_preseed() == 0

        flow.assert_not_called()
        assert 'root-only-secret' not in capsys.readouterr().out

    @posix_only
    def test_an_unresolvable_kiosk_user_prints_the_group_step(self, data_root, capsys):
        # Never guessed: the operator is told which account to add to the group
        # the seam runs through, because without it the app cannot reach the
        # daemon at all. The command is this OS's own — macOS has no usermod.
        from osadapter import posix

        self._seed(data_root, phrase='silver-compass-drift')

        with patch.object(configure_site, 'run_pairing_flow',
                          return_value=(True, 'ok', 'site-abc')):
            assert configure_site.run_preseed() == 0

        events = _events(capsys)
        assert any(posix.GROUP_ADD in event['value']
                   for event in events if event['event'] == 'status')
        assert posix.GROUP_ADD.startswith(
            'dseditgroup' if sys.platform == 'darwin' else 'usermod')
        assert events[-1]['value']['kioskUser'] is None

    @posix_only
    def test_a_pairing_leaves_config_json_writable_by_the_desktop_app(self, data_root):
        # config.json is 0660 root:<group> in the mode table so the app can
        # write it too, and `_save_config` is a temp file plus os.replace: a
        # replacement written at the daemon's umask is 0644 root:root, and the
        # mode table is only re-applied at the next service start — which a
        # preseed, and the seam's `pair`, deliberately never trigger.
        config = data_root / 'config' / 'config.json'
        config.write_text(json.dumps({'firebase': {}}))
        os.chmod(config, 0o660)
        before = config.stat()

        configure_site._save_config('site-abc', 'development', 'https://x/api', 'proj')

        after = config.stat()
        assert stat.S_IMODE(after.st_mode) == 0o660
        assert after.st_gid == before.st_gid


# the privileged-request seam


def _other_account():
    """A local account that is not the one running the suite."""
    import pwd

    mine = os.getuid()
    for entry in pwd.getpwall():
        if entry.pw_uid != mine:
            return entry.pw_name
    return None


@posix_only
class TestRequestSeam:
    """`ipc/requests/` is a privilege boundary, not a queue.

    The directory is group-writable so the desktop app — the console user — can
    ask the daemon for the three things only root can do. Every other writer,
    and every request the app did not write just now, has to be refused.
    """

    @pytest.fixture
    def seam(self, tmp_path, monkeypatch):
        import pwd

        monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
        (tmp_path / 'ipc' / 'requests').mkdir(parents=True)
        (tmp_path / 'logs').mkdir()
        monkeypatch.setattr(configure_site.osadapter, 'console_user',
                            lambda: pwd.getpwuid(os.getuid()).pw_name)
        # The in-flight pairing is module state that outlives one test.
        monkeypatch.setattr(configure_site, '_pairing_child', None)
        return tmp_path

    def _request(self, seam, verb, nonce, *, name='req', mode=0o600):
        path = seam / 'ipc' / 'requests' / f'{name}.json'
        path.write_text(json.dumps({'verb': verb, 'nonce': nonce}))
        os.chmod(path, mode)
        return path

    def _reply(self, seam, name='req'):
        return seam / 'ipc' / 'requests' / f'{name}.result'

    def _audit(self, seam):
        path = seam / 'logs' / 'privileged_requests.log'
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def _backdate_executed(self, seam, seconds):
        path = seam / 'logs' / 'privileged_requests.log'
        rows = self._audit(seam)
        for row in rows:
            if row['outcome'] == 'executed':
                row['at'] -= seconds
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))

    # the gate the service loop calls

    def test_the_gate_publishes_a_nonce_so_a_first_request_is_possible(self, seam):
        # The app has to quote a nonce the daemon already issued, so the daemon
        # issues one as soon as there is a seam to issue it into.
        assert configure_site.poll_request_seam() is False

        nonce_path = seam / 'ipc' / 'request_nonce'
        assert nonce_path.read_text().strip()
        assert stat.S_IMODE(nonce_path.stat().st_mode) == 0o640

    def test_the_gate_reports_a_waiting_request(self, seam):
        self._request(seam, 'restart', configure_site._request_nonce())
        assert configure_site.poll_request_seam() is True

    def test_an_answer_file_is_not_mistaken_for_a_request(self, seam):
        (seam / 'ipc' / 'requests' / 'req.result').write_text('{}\n')
        assert configure_site.poll_request_seam() is False

    # what is honoured

    def test_a_well_formed_restart_is_executed_and_audited(self, seam, monkeypatch):
        controls = []
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: controls.append(verb) or True)
        request = self._request(seam, 'restart', configure_site._request_nonce())

        rows = configure_site.drain_privileged_requests()

        assert controls == ['restart']
        assert [(row['verb'], row['outcome']) for row in rows] == [('restart', 'executed')]
        assert self._audit(seam) == rows
        assert not request.exists()
        assert stat.S_IMODE(self._reply(seam).stat().st_mode) == 0o640

    def test_a_service_that_would_not_restart_is_reported(self, seam, monkeypatch):
        monkeypatch.setattr(configure_site, '_service_control', lambda verb: False)
        self._request(seam, 'restart', configure_site._request_nonce())

        rows = configure_site.drain_privileged_requests()

        assert [row['outcome'] for row in rows] == ['failed']
        assert [row['outcome'] for row in self._audit(seam)] == ['executed', 'failed']
        # The answer is a line protocol appended to, not a file overwritten:
        # the status the app was already rendering survives the outcome.
        answer = self._reply(seam).read_text().splitlines()
        assert [json.loads(line)['event'] for line in answer] == ['status', 'error']
        assert 'could not restart the service' in answer[-1]

    def test_a_pair_request_spawns_the_headless_run_into_the_answer(
            self, seam, monkeypatch):
        spawned = {}

        def fake_popen(argv, **kwargs):
            spawned['argv'] = argv
            os.write(kwargs['stdout'], b'{"event": "phrase", "value": {}}\n')
            return MagicMock()

        monkeypatch.setattr(shared_utils, 'get_python_exe_path',
                            lambda: '/opt/owlette/python/bin/python3')
        monkeypatch.setattr(configure_site.subprocess, 'Popen', fake_popen)
        self._request(seam, 'pair', configure_site._request_nonce())

        rows = configure_site.drain_privileged_requests()

        assert rows[0]['outcome'] == 'executed'
        assert spawned['argv'] == [
            '/opt/owlette/python/bin/python3',
            shared_utils.get_path('configure_site.py'),
            '--json-progress',
            '--no-service-restart',
        ]
        # Off Windows only the daemon can write the token store, so the pairing
        # run is root's and its phrase reaches the app through the seam.
        assert self._reply(seam).read_text().startswith('{"event": "phrase"')

    def test_a_second_pair_is_refused_while_the_first_is_still_polling(
            self, seam, monkeypatch):
        # A pairing polls for ten minutes and writes the token store when it
        # lands. Two of them — a second click, or a loop in the kiosk session —
        # would race each other over `.tokens.enc` and the site this machine
        # ends up bound to.
        child = MagicMock()
        child.poll.return_value = None
        monkeypatch.setattr(shared_utils, 'get_python_exe_path',
                            lambda: '/opt/owlette/python/bin/python3')
        monkeypatch.setattr(configure_site.subprocess, 'Popen',
                            lambda argv, **kwargs: child)

        self._request(seam, 'pair', configure_site._request_nonce(), name='a')
        assert configure_site.drain_privileged_requests()[0]['outcome'] == 'executed'

        self._request(seam, 'pair', configure_site._request_nonce(), name='b')
        rows = configure_site.drain_privileged_requests()

        assert rows[0]['outcome'] == 'in_progress'
        assert 'already pairing' in self._reply(seam, 'b').read_text()
        assert child.poll.called

        # Once it has finished, the next request pairs.
        child.poll.return_value = 0
        self._request(seam, 'pair', configure_site._request_nonce(), name='c')
        assert configure_site.drain_privileged_requests()[0]['outcome'] == 'executed'

    def test_a_reboot_request_records_the_intent_before_the_call(self, seam, monkeypatch):
        calls = []
        session_state = MagicMock()
        session_state.set_intent.side_effect = lambda intent: calls.append(('intent', intent))
        monkeypatch.setattr(configure_site.osadapter, 'reboot',
                            lambda delay, message=None: calls.append(('reboot', delay, message)))
        self._request(seam, 'reboot', configure_site._request_nonce())

        with patch.dict(sys.modules, {'session_state': session_state}):
            rows = configure_site.drain_privileged_requests()

        assert calls == [
            ('intent', 'owlette_reboot'),
            ('reboot', 1, configure_site._REBOOT_MESSAGE),
        ]
        assert rows[0]['outcome'] == 'executed'

    # what is refused

    def test_a_group_writable_request_is_refused_and_logged(
            self, seam, monkeypatch, caplog):
        # What the app wrote has to be what the daemon read.
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('ran a group-writable request'))
        request = self._request(seam, 'restart', configure_site._request_nonce(),
                                mode=0o660)

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not request.exists()
        assert 'group- or world-writable' in caplog.text
        # The file is the console user's own — Ubuntu ships pam_umask with
        # USERGROUPS_ENAB, so a graphical session's default umask is 002 and an
        # app that does not set the mode itself writes 0664 every time — so the
        # writer is told why rather than left waiting on an answer.
        assert 'group- or world-writable' in self._reply(seam).read_text(
            encoding='utf-8')

    def test_a_request_owned_by_anyone_else_is_refused_and_logged(
            self, seam, monkeypatch, caplog):
        other = _other_account()
        if other is None:
            pytest.skip('no second local account to stand in for another user')
        monkeypatch.setattr(configure_site.osadapter, 'console_user', lambda: other)
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail("ran another account's request"))
        request = self._request(seam, 'restart', configure_site._request_nonce())

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not request.exists()
        assert 'not the console user' in caplog.text

    def test_a_stale_nonce_is_refused_and_logged(self, seam, monkeypatch, caplog):
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('replayed an old request'))
        request = self._request(seam, 'restart', 'a-nonce-from-an-earlier-session')

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not request.exists()
        assert 'nonce' in caplog.text

    def test_the_nonce_is_one_shot(self, seam, monkeypatch):
        # A batch written against one nonce yields one execution; the app reads
        # a fresh nonce for every request it makes.
        monkeypatch.setattr(configure_site, '_service_control', lambda verb: True)
        nonce = configure_site._request_nonce()
        self._request(seam, 'restart', nonce, name='a')
        self._request(seam, 'restart', nonce, name='b')

        rows = configure_site.drain_privileged_requests()

        assert [row['outcome'] for row in rows] == ['executed']
        assert configure_site._request_nonce() != nonce

    def test_a_symlink_into_the_tree_is_refused_rather_than_followed(
            self, seam, monkeypatch, caplog):
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('followed a symlink out of the seam'))
        target = seam / 'planted.json'
        target.write_text(json.dumps(
            {'verb': 'restart', 'nonce': configure_site._request_nonce()}))
        link = seam / 'ipc' / 'requests' / 'req.json'
        os.symlink(target, link)

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not link.is_symlink()
        assert target.exists()

    def test_an_entry_the_daemon_cannot_unlink_is_removed_whole(self, seam, caplog):
        # A directory named like a request cannot be unlinked, and the poll gate
        # counts it: left there it would start a drain thread on every 5s tick
        # for as long as the agent ran.
        planted = seam / 'ipc' / 'requests' / 'x.json'
        planted.mkdir()

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not planted.exists()
        assert configure_site.poll_request_seam() is False

    def test_a_request_bigger_than_a_request_is_refused_rather_than_read(
            self, seam, monkeypatch, caplog):
        # A verb and a nonce are a few hundred bytes. The directory is
        # group-writable, so an unbounded read of whatever was named `.json`
        # there is the drain thread's memory to lose.
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('ran a request nobody could read'))
        path = seam / 'ipc' / 'requests' / 'req.json'
        path.write_text(json.dumps({
            'verb': 'restart',
            'nonce': 'x' * configure_site.REQUEST_MAX_BYTES,
        }))
        os.chmod(path, 0o600)

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not path.exists()
        assert 'longer than' in caplog.text

    def test_a_nonce_the_daemon_did_not_write_is_replaced(self, seam, caplog):
        # `ipc/` is group-writable, so the entry can be removed and re-created
        # by anyone in the group; quoting that value back would defeat the
        # one-shot nonce entirely.
        nonce_path = seam / 'ipc' / 'request_nonce'
        nonce_path.write_text('a-nonce-nobody-issued')
        os.chmod(nonce_path, 0o666)

        with caplog.at_level(logging.WARNING):
            issued = configure_site._request_nonce()

        assert issued and issued != 'a-nonce-nobody-issued'
        assert nonce_path.read_text().strip() == issued
        assert stat.S_IMODE(nonce_path.stat().st_mode) == 0o640
        assert 'Replacing the request nonce' in caplog.text

    def test_a_symlink_at_the_nonce_path_does_not_wedge_the_seam(
            self, seam, monkeypatch, caplog):
        # O_NOFOLLOW made every re-issue fail against a planted link, and an
        # empty nonce refuses every request there is — for good.
        monkeypatch.setattr(configure_site, '_service_control', lambda verb: True)
        target = seam / 'planted'
        target.write_text('a-nonce-nobody-issued')
        os.symlink(target, seam / 'ipc' / 'request_nonce')

        with caplog.at_level(logging.WARNING):
            nonce = configure_site._request_nonce()
        self._request(seam, 'restart', nonce)

        assert nonce and nonce != 'a-nonce-nobody-issued'
        assert not (seam / 'ipc' / 'request_nonce').is_symlink()
        assert target.read_text() == 'a-nonce-nobody-issued'
        assert [row['outcome'] for row in
                configure_site.drain_privileged_requests()] == ['executed']

    def test_an_answer_the_daemon_did_not_create_is_not_written_through(
            self, seam, monkeypatch):
        # The directory is the app's to write, so the answer's name can be
        # taken first. A hard link would otherwise have the daemon append the
        # answer into whatever it points at and chmod that file to 0640.
        monkeypatch.setattr(configure_site, '_service_control', lambda verb: True)
        elsewhere = seam / 'config.json'
        elsewhere.write_text('{"firebase": {}}')
        os.chmod(elsewhere, 0o660)
        os.link(elsewhere, self._reply(seam))
        self._request(seam, 'restart', configure_site._request_nonce())

        rows = configure_site.drain_privileged_requests()

        assert rows[0]['outcome'] == 'executed'
        assert elsewhere.read_text() == '{"firebase": {}}'
        assert stat.S_IMODE(elsewhere.stat().st_mode) == 0o660
        assert self._reply(seam).stat().st_nlink == 1
        assert json.loads(
            self._reply(seam).read_text().splitlines()[0])['event'] == 'status'

    def test_nothing_is_honoured_with_nobody_at_a_graphical_session(
            self, seam, monkeypatch, caplog):
        monkeypatch.setattr(configure_site.osadapter, 'console_user', lambda: None)
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('ran a request with no session'))
        request = self._request(seam, 'restart', configure_site._request_nonce())

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not request.exists()
        assert 'nobody at a graphical session' in caplog.text

    # the rate limit

    def test_a_second_restart_inside_five_minutes_is_refused(self, seam, monkeypatch):
        controls = []
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: controls.append(verb) or True)
        self._request(seam, 'restart', configure_site._request_nonce(), name='a')
        configure_site.drain_privileged_requests()
        self._request(seam, 'restart', configure_site._request_nonce(), name='b')

        rows = configure_site.drain_privileged_requests()

        assert controls == ['restart']
        assert rows[0]['outcome'] == 'rate_limited'
        assert 'less than five minutes ago' in self._reply(seam, 'b').read_text()

    def test_the_window_reopens_once_it_has_passed(self, seam, monkeypatch):
        controls = []
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: controls.append(verb) or True)
        self._request(seam, 'reboot', configure_site._request_nonce(), name='a')
        monkeypatch.setattr(configure_site.osadapter, 'reboot',
                            lambda delay, message=None: controls.append('reboot'))
        configure_site.drain_privileged_requests()

        self._backdate_executed(seam, configure_site.REQUEST_RATE_LIMIT_SECONDS + 1)
        self._request(seam, 'reboot', configure_site._request_nonce(), name='b')
        rows = configure_site.drain_privileged_requests()

        assert rows[0]['outcome'] == 'executed'

    def test_a_refused_request_does_not_extend_the_window(self, seam, monkeypatch):
        # The window is read off executed rows only: one rate-limited request
        # must not buy the block another five minutes.
        monkeypatch.setattr(configure_site, '_service_control', lambda verb: True)
        self._request(seam, 'restart', configure_site._request_nonce(), name='a')
        configure_site.drain_privileged_requests()
        self._request(seam, 'restart', configure_site._request_nonce(), name='b')
        configure_site.drain_privileged_requests()

        self._backdate_executed(seam, configure_site.REQUEST_RATE_LIMIT_SECONDS + 1)
        self._request(seam, 'restart', configure_site._request_nonce(), name='c')
        rows = configure_site.drain_privileged_requests()

        assert [row['outcome'] for row in self._audit(seam)] == [
            'executed', 'rate_limited', 'executed']
        assert rows[0]['outcome'] == 'executed'

    # the negative control

    def test_a_hand_written_leave_request_is_refused(self, seam, monkeypatch, caplog):
        monkeypatch.setattr(configure_site, 'run_leave_site',
                            lambda: pytest.fail('the seam deregistered this machine'))
        request = self._request(seam, 'leave', configure_site._request_nonce())

        with caplog.at_level(logging.WARNING):
            assert configure_site.drain_privileged_requests() == []

        assert not request.exists()
        assert "asks for 'leave'" in caplog.text


    def test_a_fifo_at_the_answer_does_not_wedge_the_drain(self, seam):
        """The answer's name is derived from the request's and the directory is
        the app's to write, so a fifo can be left under it — and opening one
        for writing waits for a reader. The drain runs on its own thread behind
        a single-flight gate, so one that blocked would take `pair`, `restart`
        and `reboot` out for the life of the process.

        The wait is the assertion: without O_NONBLOCK this never returns.
        """
        self._request(seam, 'restart', 'not-the-nonce-the-daemon-issued')
        os.mkfifo(self._reply(seam))
        finished = threading.Event()

        def drain():
            configure_site.drain_privileged_requests()
            finished.set()

        thread = threading.Thread(target=drain, daemon=True)
        thread.start()

        assert finished.wait(10) is True

    def test_the_audit_is_rotated_rather_than_grown_forever(
            self, seam, monkeypatch):
        """An accepted request appends a row every tick an app asks on, and
        nothing ages the file out — cleanup_old_logs deletes by mtime, which one
        being appended to never reaches. It is rotated at the same cap the
        installer log is."""
        controls = []
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: controls.append(verb) or True)
        audit = seam / 'logs' / 'privileged_requests.log'
        audit.write_text('x' * (shared_utils.EXTERNAL_LOG_MAX_BYTES + 1),
                         encoding='utf-8')

        self._request(seam, 'restart', configure_site._request_nonce())
        configure_site.drain_privileged_requests()

        assert (seam / 'logs' / 'privileged_requests.log.1').exists()
        assert audit.stat().st_size < configure_site.REQUEST_MAX_BYTES
        assert controls == ['restart']

    def test_the_window_survives_the_rotation_that_carries_it_away(
            self, seam, monkeypatch):
        """The rate limit's only memory is the audit, and the audit is rotated:
        an executed row can be one generation behind by the time the next
        request asks, and a window read off the live file alone would reopen."""
        monkeypatch.setattr(configure_site, '_service_control',
                            lambda verb: pytest.fail('ran a rate-limited restart'))
        (seam / 'logs' / 'privileged_requests.log.1').write_text(
            json.dumps({'at': time.time(), 'verb': 'restart',
                        'outcome': 'executed', 'detail': ''}) + '\n',
            encoding='utf-8')
        self._request(seam, 'restart', configure_site._request_nonce())

        rows = configure_site.drain_privileged_requests()

        assert rows[0]['outcome'] == 'rate_limited'


class TestRequestSeamVerbs:
    def test_leave_is_not_a_verb_the_daemon_executes(self):
        """The negative control for the seam: deregistration stays an
        uninstall-time root operation (`prerm` / `uninstall.sh`) and a dashboard
        command. Adding a `leave` handler fails here first."""
        assert set(configure_site.REQUEST_VERBS) == {'pair', 'restart', 'reboot'}

    @pytest.mark.skipif(sys.platform != 'win32',
                        reason='the Windows half of the seam gate')
    def test_windows_has_no_request_seam(self, tmp_path, monkeypatch):
        # The app there controls the service through the SCM and elevates on a
        # deliberate click; a request file is not a path into the service.
        monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
        requests = tmp_path / 'ipc' / 'requests'
        requests.mkdir(parents=True)
        (requests / 'req.json').write_text('{"verb": "restart"}')

        assert configure_site.poll_request_seam() is False
        assert configure_site.drain_privileged_requests() == []
