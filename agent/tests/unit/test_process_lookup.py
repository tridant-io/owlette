"""
tests for shared_utils process lookup -- the refuse-instead-of-guess ladder
(D3). A pid comes back only on unambiguous evidence: file_path corroboration,
a unique exact exe-path match, a unique cmd.exe wrapper for a script target,
or exact equality with a RECORDED launch cmdline (expected_cmdline). Every
ambiguous shape returns None in BOTH modes -- non-strict callers deliberately
fall through to a fresh launch. Strict mode additionally never matches a bare
image name; kill/restart discovery relies on that.

The non-strict refusal tests replace deliberate pins of the pre-3.3.0 adopt
behaviour (first-full-match adoption, silent bare-basename fallback) -- they
assert the refusal that Wave 3 introduced, not a fixture accident.
"""

import logging

import pytest

import shared_utils

# Windows image-name matching over drive-letter fixtures: `D:\other\x.exe` has no
# basename on POSIX, so the ladder's refusal branches never fire there.
pytestmark = pytest.mark.windows


class FakeProc:
    def __init__(self, pid, exe, cmdline=None):
        self.info = {'pid': pid, 'exe': exe}
        self._cmdline = cmdline if cmdline is not None else ([exe] if exe else [])

    def cmdline(self):
        return self._cmdline


def _patch_procs(monkeypatch, procs):
    monkeypatch.setattr(shared_utils.psutil, 'process_iter', lambda attrs=None: iter(procs))


TD_EXE = r'C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe'
TOE = r'C:\Shows\wall.toe'
CMD_EXE = r'C:\Windows\System32\cmd.exe'
BAT = r'C:\Program Files\Signage\start loop.bat'


# --- unique matches still resolve (both modes) -------------------------------

def test_strict_exact_path_unique_match(monkeypatch):
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) == 100


def test_non_strict_exact_path_unique_match(monkeypatch):
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE)])
    assert shared_utils.find_running_process_by_exe(TD_EXE) == 100


def test_strict_file_path_corroboration_disambiguates(monkeypatch):
    _patch_procs(monkeypatch, [
        FakeProc(100, TD_EXE, [TD_EXE, r'C:\Shows\other.toe']),
        FakeProc(200, TD_EXE, [TD_EXE, TOE]),
    ])
    assert shared_utils.find_running_process_by_exe(TD_EXE, TOE, strict=True) == 200


# --- ambiguity refuses in BOTH modes (D3: launch fresh, never guess) ---------

def test_strict_refuses_ambiguous_match_without_file_path(monkeypatch):
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE), FakeProc(200, TD_EXE)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) is None


def test_non_strict_refuses_ambiguous_full_matches(monkeypatch, caplog):
    # Replaces the pin of the old tier-3b behaviour (adopt full_matches[0]).
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE), FakeProc(200, TD_EXE)])
    with caplog.at_level(logging.WARNING):
        assert shared_utils.find_running_process_by_exe(TD_EXE) is None
    # Operators grep these logs: the warning must name the ambiguity and the
    # launch-fresh consequence.
    assert 'refusing to guess' in caplog.text
    assert 'launch fresh' in caplog.text
    assert '2 instances' in caplog.text


def test_strict_never_matches_bare_basename(monkeypatch):
    other_dir = r'D:\other\TouchDesigner.exe'
    _patch_procs(monkeypatch, [FakeProc(100, other_dir)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) is None


def test_non_strict_refuses_bare_basename_match(monkeypatch, caplog):
    # Replaces the pin of the old tier-3c behaviour (silent bare-basename
    # fallback): an exe that only shares the image name may be a different
    # install or build -- adopting it is the guess this ladder refuses.
    other_dir = r'D:\other\TouchDesigner.exe'
    _patch_procs(monkeypatch, [FakeProc(100, other_dir)])
    with caplog.at_level(logging.WARNING):
        assert shared_utils.find_running_process_by_exe(TD_EXE) is None
    assert 'only by image name' in caplog.text
    assert 'launch fresh' in caplog.text


# --- .bat/.cmd wrapper matching ----------------------------------------------

def test_unique_script_wrapper_matches_in_both_modes(monkeypatch):
    procs = [
        FakeProc(100, CMD_EXE, ['cmd.exe', '/s', '/c', 'something else']),
        FakeProc(200, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}"']),
    ]
    _patch_procs(monkeypatch, procs)
    assert shared_utils.find_running_process_by_exe(BAT, strict=True) == 200
    _patch_procs(monkeypatch, procs)
    assert shared_utils.find_running_process_by_exe(BAT) == 200


def test_strict_refuses_ambiguous_script_wrappers(monkeypatch):
    # Pre-3.3.0 this branch ignored strict and returned the first wrapper.
    _patch_procs(monkeypatch, [
        FakeProc(100, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}"']),
        FakeProc(200, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}"']),
    ])
    assert shared_utils.find_running_process_by_exe(BAT, strict=True) is None


def test_non_strict_refuses_ambiguous_script_wrappers(monkeypatch, caplog):
    _patch_procs(monkeypatch, [
        FakeProc(100, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}"']),
        FakeProc(200, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}"']),
    ])
    with caplog.at_level(logging.WARNING):
        assert shared_utils.find_running_process_by_exe(BAT) is None
    assert 'cmd.exe wrappers' in caplog.text
    assert 'launch fresh' in caplog.text


def test_expected_cmdline_disambiguates_script_wrappers(monkeypatch):
    _patch_procs(monkeypatch, [
        FakeProc(100, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}" a']),
        FakeProc(200, CMD_EXE, ['cmd.exe', '/s', '/c', f'"{BAT}" b']),
    ])
    expected = f'cmd.exe /s /c "{BAT}" b'
    assert shared_utils.find_running_process_by_exe(
        BAT, expected_cmdline=expected) == 200


# --- expected_cmdline tier (recorded launch evidence only) -------------------

def test_expected_cmdline_disambiguates_ambiguous_full_matches(monkeypatch):
    _patch_procs(monkeypatch, [
        FakeProc(100, TD_EXE, [TD_EXE, r'C:\Shows\a.toe']),
        FakeProc(200, TD_EXE, [TD_EXE, r'C:\Shows\b.toe']),
    ])
    # Mixed slashes and case must still compare equal: the recorded string is
    # normalised the same way live cmdlines are.
    expected = f'{TD_EXE} C:/Shows/B.TOE'
    assert shared_utils.find_running_process_by_exe(
        TD_EXE, expected_cmdline=expected) == 200


def test_expected_cmdline_mismatch_still_refuses(monkeypatch, caplog):
    _patch_procs(monkeypatch, [
        FakeProc(100, TD_EXE, [TD_EXE, r'C:\Shows\a.toe']),
        FakeProc(200, TD_EXE, [TD_EXE, r'C:\Shows\b.toe']),
    ])
    with caplog.at_level(logging.WARNING):
        assert shared_utils.find_running_process_by_exe(
            TD_EXE, expected_cmdline=f'{TD_EXE} C:\\Shows\\gone.toe') is None
    assert 'refusing to guess' in caplog.text


def test_expected_cmdline_matching_several_stays_ambiguous(monkeypatch):
    # Two candidates with IDENTICAL cmdlines: recorded evidence points at
    # both, so nothing was actually disambiguated -- still a refusal.
    cmdline = [TD_EXE, r'C:\Shows\same.toe']
    _patch_procs(monkeypatch, [
        FakeProc(100, TD_EXE, cmdline),
        FakeProc(200, TD_EXE, cmdline),
    ])
    assert shared_utils.find_running_process_by_exe(
        TD_EXE, expected_cmdline=f'{TD_EXE} C:\\Shows\\same.toe') is None


def test_expected_cmdline_does_not_override_unique_full_match(monkeypatch):
    # The tier only DISAMBIGUATES: a unique exact exe-path match returns on
    # its own evidence even when the recorded cmdline points elsewhere.
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE, [TD_EXE, r'C:\Shows\a.toe'])])
    assert shared_utils.find_running_process_by_exe(
        TD_EXE, expected_cmdline=f'{TD_EXE} C:\\Shows\\b.toe') == 100


# --- exception envelope ------------------------------------------------------

def test_unexpected_failure_logs_and_returns_none(monkeypatch, caplog):
    def boom(attrs=None):
        raise RuntimeError('psutil fell over')

    monkeypatch.setattr(shared_utils.psutil, 'process_iter', boom)
    with caplog.at_level(logging.ERROR):
        assert shared_utils.find_running_process_by_exe(TD_EXE) is None
    # logging.exception, not silent pass: the traceback must reach the log.
    assert 'failed unexpectedly' in caplog.text
    assert 'psutil fell over' in caplog.text
