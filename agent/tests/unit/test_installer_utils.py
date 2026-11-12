"""Unit tests for installer_utils: download, execution, verification, cleanup
and cancellation of software installers.
"""

import pytest
import os
import subprocess
import hashlib
from unittest.mock import Mock, patch, mock_open, MagicMock, call
import requests
import psutil

import installer_utils


class TestDownloadFile:
    """Tests for download_file()"""

    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_successful_download(self, mock_get, mock_makedirs, mock_exists):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '100'}
        mock_response.iter_content.return_value = [b'x' * 100]
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        with patch('builtins.open', mock_open()):
            success, path = installer_utils.download_file(
                'https://example.com/setup.exe', '/tmp/setup.exe'
            )

        assert success is True
        assert path == '/tmp/setup.exe'
        mock_get.assert_called_once()

    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_connection_error_retries(self, mock_get, mock_makedirs, mock_exists):
        mock_get.side_effect = requests.exceptions.ConnectionError('refused')

        with patch('installer_utils.time.sleep'):
            success, path = installer_utils.download_file(
                'https://example.com/setup.exe', '/tmp/setup.exe',
                max_retries=2
            )

        assert success is False
        assert path == ''
        assert mock_get.call_count == 2

    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_timeout_retries(self, mock_get, mock_makedirs, mock_exists):
        mock_get.side_effect = requests.exceptions.Timeout('timed out')

        success, path = installer_utils.download_file(
            'https://example.com/setup.exe', '/tmp/setup.exe',
            max_retries=1
        )

        assert success is False
        assert path == ''

    @patch('installer_utils.time.sleep')
    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_retry_succeeds_on_second_attempt(self, mock_get, mock_makedirs,
                                               mock_exists, mock_sleep):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '50'}
        mock_response.iter_content.return_value = [b'x' * 50]
        mock_response.raise_for_status.return_value = None

        mock_get.side_effect = [
            requests.exceptions.ConnectionError('fail'),
            mock_response
        ]

        with patch('builtins.open', mock_open()):
            success, path = installer_utils.download_file(
                'https://example.com/setup.exe', '/tmp/setup.exe',
                max_retries=3
            )

        assert success is True
        assert mock_get.call_count == 2

    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_incomplete_download_detected(self, mock_get, mock_makedirs, mock_exists):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '1000'}
        mock_response.iter_content.return_value = [b'x' * 500]
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        with patch('builtins.open', mock_open()):
            with patch('installer_utils.time.sleep'):
                success, path = installer_utils.download_file(
                    'https://example.com/setup.exe', '/tmp/setup.exe',
                    max_retries=1
                )

        assert success is False

    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_existing_file_removed_before_download(self, mock_get, mock_makedirs):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '0'}
        mock_response.iter_content.return_value = [b'data']
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        with patch('installer_utils.os.path.exists', return_value=True):
            with patch('installer_utils.os.remove') as mock_remove:
                with patch('builtins.open', mock_open()):
                    installer_utils.download_file(
                        'https://example.com/setup.exe', '/tmp/setup.exe'
                    )

        mock_remove.assert_called_with('/tmp/setup.exe')

    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_locked_file_gets_unique_name(self, mock_get, mock_makedirs):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '0'}
        mock_response.iter_content.return_value = [b'data']
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        with patch('installer_utils.os.path.exists', return_value=True):
            with patch('installer_utils.os.remove', side_effect=PermissionError('locked')):
                with patch('builtins.open', mock_open()):
                    success, path = installer_utils.download_file(
                        'https://example.com/setup.exe', '/tmp/setup.exe'
                    )

        assert success is True
        assert path != '/tmp/setup.exe'
        assert 'setup_' in path

    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_progress_callback_called(self, mock_get, mock_makedirs, mock_exists):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '200'}
        mock_response.iter_content.return_value = [b'x' * 100, b'x' * 100]
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        progress_values = []

        with patch('builtins.open', mock_open()):
            success, _ = installer_utils.download_file(
                'https://example.com/setup.exe', '/tmp/setup.exe',
                progress_callback=lambda p: progress_values.append(p)
            )

        assert success is True
        assert len(progress_values) == 2
        assert progress_values[-1] == 100

    @patch('installer_utils.requests.get')
    def test_stop_ends_the_download_and_leaves_no_partial_file(self, mock_get, tmp_path):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '300'}
        mock_response.iter_content.return_value = iter([b'x' * 100] * 3)
        mock_get.return_value = mock_response
        dest = tmp_path / 'setup.exe'
        # asked before the attempt and before each chunk: the first chunk is
        # written, the second is where it stops
        answers = iter([False, False, True])

        success, path = installer_utils.download_file(
            'https://example.com/setup.exe', str(dest), should_stop=lambda: next(answers))

        assert (success, path) == (False, '')
        assert not dest.exists()
        # a stop is not a failure, so nothing is tried again
        mock_get.assert_called_once()
        mock_response.close.assert_called_once()

    @patch('installer_utils.time.sleep')
    @patch('installer_utils.os.path.exists', return_value=False)
    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.requests.get')
    def test_stop_during_the_retry_wait_opens_no_new_connection(self, mock_get, mock_makedirs,
                                                                 mock_exists, mock_sleep):
        mock_get.side_effect = requests.exceptions.ConnectionError('refused')
        # the first attempt fails, and the stop arrives while the second waits its turn
        waited = []
        mock_sleep.side_effect = waited.append

        success, path = installer_utils.download_file(
            'https://example.com/setup.exe', '/tmp/setup.exe', should_stop=lambda: bool(waited))

        assert (success, path) == (False, '')
        assert mock_get.call_count == 1

    @patch('installer_utils.requests.get')
    def test_a_download_nobody_stops_runs_to_its_end(self, mock_get, tmp_path):
        mock_response = MagicMock()
        mock_response.headers = {'content-length': '300'}
        mock_response.iter_content.return_value = iter([b'x' * 100] * 3)
        mock_get.return_value = mock_response
        dest = tmp_path / 'setup.exe'

        success, path = installer_utils.download_file(
            'https://example.com/setup.exe', str(dest), should_stop=lambda: False)

        assert (success, path) == (True, str(dest))
        assert dest.stat().st_size == 300


class TestExecuteInstaller:
    """Tests for execute_installer()"""

    @patch('installer_utils.subprocess.Popen')
    @patch('installer_utils.os.path.exists', return_value=True)
    def test_successful_execution(self, mock_exists, mock_popen):
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ('', '')
        mock_proc.returncode = 0
        mock_proc.pid = 1234
        mock_popen.return_value = mock_proc

        success, code, msg = installer_utils.execute_installer(
            'C:/temp/setup.exe', '/S'
        )

        assert success is True
        assert code == 0
        assert msg == ''
        mock_popen.assert_called_once()

    @patch('installer_utils.subprocess.Popen')
    @patch('installer_utils.os.path.exists', return_value=True)
    def test_nonzero_exit_code(self, mock_exists, mock_popen):
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ('', 'error details')
        mock_proc.returncode = 1
        mock_proc.pid = 1234
        mock_popen.return_value = mock_proc

        success, code, msg = installer_utils.execute_installer(
            'C:/temp/setup.exe', '/S'
        )

        assert success is False
        assert code == 1
        assert 'error details' in msg

    @patch('installer_utils.os.path.exists', return_value=False)
    def test_installer_not_found(self, mock_exists):
        success, code, msg = installer_utils.execute_installer('C:/temp/missing.exe')

        assert success is False
        assert code == -1
        assert 'not found' in msg

    @patch('installer_utils.psutil.wait_procs', return_value=([], []))
    @patch('installer_utils.psutil.Process')
    @patch('installer_utils.subprocess.Popen')
    @patch('installer_utils.os.path.exists', return_value=True)
    def test_timeout_kills_process_tree(self, mock_exists, mock_popen,
                                         mock_psutil_process, mock_wait):
        mock_proc = MagicMock()
        mock_proc.communicate.side_effect = subprocess.TimeoutExpired('cmd', 600)
        mock_proc.pid = 1234
        mock_popen.return_value = mock_proc

        mock_parent = MagicMock()
        mock_child = MagicMock()
        mock_parent.children.return_value = [mock_child]
        mock_psutil_process.return_value = mock_parent

        success, code, msg = installer_utils.execute_installer(
            'C:/temp/setup.exe', '/S', timeout_seconds=1
        )

        assert success is False
        assert 'timeout' in msg.lower()
        mock_child.kill.assert_called_once()
        mock_parent.kill.assert_called_once()

    @patch('installer_utils.subprocess.Popen')
    @patch('installer_utils.os.path.exists', return_value=True)
    def test_tracks_and_removes_active_process(self, mock_exists, mock_popen):
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ('', '')
        mock_proc.returncode = 0
        mock_proc.pid = 1234
        mock_popen.return_value = mock_proc

        active = {}
        installer_utils.execute_installer(
            'C:/temp/setup.exe', '/S',
            installer_name='setup.exe', active_processes=active
        )

        assert 'setup.exe' not in active


class TestVerifyChecksum:
    """Tests for verify_checksum()"""

    def test_matching_checksum(self):
        data = b'test data for checksum'
        expected = hashlib.sha256(data).hexdigest()

        with patch('builtins.open', mock_open(read_data=data)):
            assert installer_utils.verify_checksum('/tmp/file.exe', expected) is True

    def test_case_insensitive_match(self):
        data = b'test data for checksum'
        expected = hashlib.sha256(data).hexdigest().upper()

        with patch('builtins.open', mock_open(read_data=data)):
            assert installer_utils.verify_checksum('/tmp/file.exe', expected) is True

    def test_mismatched_checksum(self):
        with patch('builtins.open', mock_open(read_data=b'some data')):
            assert installer_utils.verify_checksum('/tmp/file.exe', 'deadbeef' * 8) is False

    def test_file_not_found(self):
        with patch('builtins.open', side_effect=FileNotFoundError('not found')):
            assert installer_utils.verify_checksum('/tmp/missing.exe', 'abc123') is False

    def test_permission_error(self):
        with patch('builtins.open', side_effect=PermissionError('access denied')):
            assert installer_utils.verify_checksum('/tmp/locked.exe', 'abc123') is False


class TestVerifyInstallation:
    """Tests for verify_installation()"""

    @patch('installer_utils.os.path.exists', return_value=True)
    def test_file_exists(self, mock_exists):
        assert installer_utils.verify_installation('C:/Program Files/App/app.exe') is True
        mock_exists.assert_called_with('C:/Program Files/App/app.exe')

    @patch('installer_utils.os.path.exists', return_value=False)
    def test_file_missing(self, mock_exists):
        assert installer_utils.verify_installation('C:/Program Files/App/app.exe') is False


class TestGetTempInstallerPath:
    """Tests for get_temp_installer_path()"""

    @patch('installer_utils.os.makedirs')
    @patch('installer_utils.tempfile.gettempdir', return_value='C:/temp')
    def test_returns_correct_path(self, mock_tempdir, mock_makedirs):
        path = installer_utils.get_temp_installer_path('setup.exe')

        assert path == os.path.join('C:/temp', 'owlette_installers', 'setup.exe')
        mock_makedirs.assert_called_once()


class TestCleanupInstaller:
    """Tests for cleanup_installer()"""

    @patch('installer_utils.os.path.exists', return_value=True)
    @patch('installer_utils.os.remove')
    def test_successful_cleanup(self, mock_remove, mock_exists):
        assert installer_utils.cleanup_installer('/tmp/setup.exe') is True
        mock_remove.assert_called_once_with('/tmp/setup.exe')

    @patch('installer_utils.os.path.exists', return_value=False)
    def test_file_not_found(self, mock_exists):
        assert installer_utils.cleanup_installer('/tmp/missing.exe') is False

    @patch('installer_utils.os.path.exists', return_value=True)
    @patch('installer_utils.os.remove', side_effect=PermissionError('locked'))
    def test_locked_file_no_force(self, mock_remove, mock_exists):
        assert installer_utils.cleanup_installer('/tmp/setup.exe', force=False) is False


class TestCancelInstallation:
    """Tests for cancel_installation()"""

    @patch('installer_utils.cleanup_installer')
    @patch('installer_utils.get_temp_installer_path', return_value='/tmp/owlette_installers/setup.exe')
    @patch('installer_utils.psutil.wait_procs', return_value=([], []))
    @patch('installer_utils.psutil.Process')
    def test_successful_cancel(self, mock_psutil_process, mock_wait,
                                mock_temp_path, mock_cleanup):
        mock_proc = MagicMock()
        mock_proc.pid = 1234

        mock_parent = MagicMock()
        mock_parent.children.return_value = []
        mock_psutil_process.return_value = mock_parent

        active = {'setup.exe': mock_proc}
        success, msg = installer_utils.cancel_installation('setup.exe', active)

        assert success is True
        assert 'setup.exe' not in active
        mock_cleanup.assert_called_once()
        mock_parent.kill.assert_called_once()

    def test_cancel_not_found(self):
        active = {}
        success, msg = installer_utils.cancel_installation('setup.exe', active)

        assert success is False
        assert 'No active installation' in msg

    @patch('installer_utils.cleanup_installer')
    @patch('installer_utils.get_temp_installer_path', return_value='/tmp/setup.exe')
    @patch('installer_utils.psutil.Process')
    def test_cancel_already_terminated(self, mock_psutil_process,
                                        mock_temp_path, mock_cleanup):
        mock_proc = MagicMock()
        mock_proc.pid = 1234
        mock_psutil_process.side_effect = psutil.NoSuchProcess(1234)

        active = {'setup.exe': mock_proc}
        success, msg = installer_utils.cancel_installation('setup.exe', active)

        assert success is True
        assert 'setup.exe' not in active


@pytest.fixture
def held():
    """The held-install registry is process-global: empty around each test."""
    installer_utils._held_installs.clear()
    yield installer_utils._held_installs
    installer_utils._held_installs.clear()


class TestHeldInstalls:
    """Tests for the held-install registry a cancel_installation works through"""

    def test_a_cancel_marks_the_install_its_deployment_names(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        installer_utils.hold_install('cmd-2', 'app.exe', 'dep-2')

        assert installer_utils.request_cancel('app.exe', 'dep-2') == (['cmd-2'], [])
        assert installer_utils.cancel_requested('cmd-2') is True
        assert installer_utils.cancel_requested('cmd-1') is False

    def test_a_cancel_with_no_deployment_id_goes_by_installer_name(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        installer_utils.hold_install('cmd-2', 'other.exe', 'dep-2')

        assert installer_utils.request_cancel('app.exe', None) == (['cmd-1'], [])
        assert installer_utils.cancel_requested('cmd-2') is False

    def test_a_deployment_id_that_matches_nothing_does_not_fall_back_to_the_name(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')

        assert installer_utils.request_cancel('app.exe', 'dep-9') == ([], [])
        assert installer_utils.cancel_requested('cmd-1') is False

    def test_a_cancel_that_matches_nothing_leaves_nothing_behind(self, held):
        assert installer_utils.request_cancel('app.exe', 'dep-1') == ([], [])
        assert held == {}

        # the same deployment retried, or the same installer sent again
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        assert installer_utils.cancel_requested('cmd-1') is False

    def test_a_released_install_takes_its_cancel_with_it(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        installer_utils.request_cancel('app.exe', 'dep-1')

        # the release is where the cancel is read for the last time
        assert installer_utils.release_install('cmd-1') is True

        assert held == {}
        assert installer_utils.cancel_requested('cmd-1') is False
        # and a cancel after it finds nothing held
        assert installer_utils.request_cancel('app.exe', 'dep-1') == ([], [])

    def test_a_release_says_when_there_was_no_cancel(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')

        assert installer_utils.release_install('cmd-1') is False
        assert installer_utils.release_install('cmd-1') is False

    def test_a_cancel_that_names_nothing_matches_nothing(self, held):
        installer_utils.hold_install('cmd-1', None, None)

        assert installer_utils.request_cancel(None, None) == ([], [])
        assert installer_utils.cancel_requested('cmd-1') is False

    def test_a_cancelled_install_may_not_launch_its_installer(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        installer_utils.request_cancel('app.exe', 'dep-1')

        assert installer_utils.claim_launch('cmd-1') is False

    def test_an_install_that_has_launched_is_past_cancelling(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')

        assert installer_utils.claim_launch('cmd-1') is True
        # named, so the answer can say it will finish, but never flagged
        assert installer_utils.request_cancel('app.exe', 'dep-1') == ([], ['cmd-1'])
        assert installer_utils.cancel_requested('cmd-1') is False

    def test_a_cancel_flags_what_waits_and_names_what_has_launched(self, held):
        installer_utils.hold_install('cmd-1', 'app.exe', 'dep-1')
        installer_utils.hold_install('cmd-2', 'app.exe', 'dep-1')
        installer_utils.claim_launch('cmd-1')

        assert installer_utils.request_cancel('app.exe', 'dep-1') == (['cmd-2'], ['cmd-1'])

    def test_an_install_nobody_holds_may_launch(self, held):
        assert installer_utils.claim_launch('cmd-9') is True
        assert held == {}
