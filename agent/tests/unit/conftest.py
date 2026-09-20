"""
unit-test fixtures.

`_neutralize_harden_acl` no-ops sync_assembler._harden_acl by default so unit
tests can read back assembled files without elevation. tests that explicitly
verify ACL-hardening behavior should patch _harden_acl themselves inside the
test (the autouse here is overridden cleanly by inner patches).

without this fixture, post-Wave-4b ACL hardening (SYSTEM + Administrators
only DACL) makes assembled tmp files unreadable by the non-elevated test
runner, breaking ~15 unrelated assembler tests.
"""

import os
import shutil
import subprocess
import sys

import pytest

# What a private executable does once started: nothing, until it is killed.
_PAUSE_SOURCE = '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n'


@pytest.fixture(scope='session')
def _darwin_pause_binary(tmp_path_factory):
    """A runnable Mach-O of our own, built once per session.

    macOS 26 SIGKILLs a copy of a system binary: `/bin/sleep` copied into a
    temp directory exits 137 as soon as it is run, so a test that needs a
    process at a path of its own cannot copy one there. A binary the linker
    signed ad hoc carries no such restriction and runs from wherever it is
    copied.
    """
    # /usr/bin/cc is a stub on a Mac without the developer tools, and running
    # it opens their installer; xcode-select says whether there is a compiler
    # behind it without asking for one.
    developer = subprocess.run(['xcode-select', '-p'], capture_output=True, timeout=30)
    compiler = shutil.which('cc')
    if developer.returncode != 0 or compiler is None:
        pytest.skip('no developer tools to build a private executable with')
    binary = tmp_path_factory.mktemp('private-executable') / 'pause'
    built = subprocess.run(
        [compiler, '-x', 'c', '-o', str(binary), '-'],
        input=_PAUSE_SOURCE, capture_output=True, text=True, timeout=120,
    )
    if built.returncode != 0:
        if 'license' in built.stderr.lower():
            pytest.skip(f'the developer tools are not usable yet: {built.stderr.strip()}')
        pytest.fail(f'could not build a private executable: {built.stderr}')
    return binary


@pytest.fixture
def private_executable(request, tmp_path):
    """Make a runnable executable at `tmp_path / name`, for a process whose
    image path the test controls; it runs until it is killed.

    A copy of /bin/sleep off macOS, where a copied system binary still runs,
    and a copy of a binary built for the session on it.
    """
    def make(name):
        source = (request.getfixturevalue('_darwin_pause_binary')
                  if sys.platform == 'darwin' else '/bin/sleep')
        target = tmp_path / name
        shutil.copy(source, target)
        os.chmod(target, 0o755)
        return target

    return make


@pytest.fixture(autouse=True)
def _neutralize_harden_acl(monkeypatch):
    """make _harden_acl a no-op for the duration of each unit test."""
    try:
        import sync_assembler
        monkeypatch.setattr(sync_assembler, '_harden_acl', lambda _path: None)
    except ImportError:
        pass
    yield
