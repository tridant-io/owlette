"""
tests for process_launcher — hidden-launch command construction.

The .bat/.cmd hidden path must be built as a single `cmd.exe /s /c "..."`
string. Passing a list lets list2cmdline quote the script path and each
spaced argument separately, and with more than two quote characters after
/c, cmd.exe strips the first and last quote and mangles the command
('C:\\Program' is not recognized...). These tests pin the /s /c outer-quote
form and the token normalization that prevents double quoting.
"""

import subprocess

import pytest

from process_launcher import build_hidden_batch_command


SPACED_BAT = r'C:\Program Files\Signage\start loop.bat'
SPACED_ARG = r'C:\Media\playlist file.m3u'


def test_spaced_path_and_spaced_arg_uses_s_c_outer_quotes():
    cmd = build_hidden_batch_command(SPACED_BAT, [SPACED_ARG])
    assert isinstance(cmd, str)
    assert cmd == f'cmd.exe /s /c ""{SPACED_BAT}" "{SPACED_ARG}""'


def test_no_args_still_wraps_with_outer_quote_pair():
    cmd = build_hidden_batch_command(SPACED_BAT, [])
    assert cmd == f'cmd.exe /s /c ""{SPACED_BAT}""'


def test_prequoted_token_from_shlex_is_not_double_quoted():
    # shlex.split(posix=False) keeps surrounding quotes on tokens; the builder
    # must strip them so list2cmdline re-quotes exactly once.
    cmd = build_hidden_batch_command(SPACED_BAT, [f'"{SPACED_ARG}"'])
    assert cmd == f'cmd.exe /s /c ""{SPACED_BAT}" "{SPACED_ARG}""'


def test_unspaced_tokens_stay_bare():
    # list2cmdline only quotes tokens containing whitespace; an unspaced path
    # and flag pass through bare, and /s strips exactly the outer pair.
    cmd = build_hidden_batch_command(r'C:\ops\run.bat', ['--verbose'])
    assert cmd == 'cmd.exe /s /c "C:\\ops\\run.bat --verbose"'


@pytest.mark.windows(reason='requires cmd.exe')
def test_spaced_path_and_arg_actually_executes(tmp_path):
    # End-to-end: the exact combination that broke the naive list form
    # (>2 quote chars after /c) must launch and receive the arg intact.
    workdir = tmp_path / 'space test dir'
    workdir.mkdir()
    bat = workdir / 'my script.bat'
    marker = workdir / 'marker.txt'
    arg = str(workdir / 'some spaced arg.txt')
    bat.write_bytes(b'@echo off\r\necho %~1> "%~dp0marker.txt"\r\n')

    cmd = build_hidden_batch_command(str(bat), [arg])
    rc = subprocess.run(cmd, creationflags=subprocess.CREATE_NO_WINDOW).returncode

    assert rc == 0
    assert marker.read_text().strip() == arg
