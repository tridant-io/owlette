"""ADR 0006 puts a fleet fix's upgrade-path half in the installer; this is
ADR 0005's.

During a self-update the old desktop app is what runs on the box, and a 3.2.0
app answers a stopped service with an elevated restart, a UAC prompt on the
screen. The installer is the only new code that runs there, so it closes the
app before it stops the service, and parks its exe first: until its own stop
lands, a 3.2.0 service relaunches a closed app on its next status check, and it
skips that launch only when the exe is missing. This pins that order.
"""
from pathlib import Path

ISS = Path(__file__).resolve().parents[2] / 'owlette_installer.iss'


def _routine(text, signature):
    """One top-level [Code] routine, up to the next one."""
    start = text.index(signature)
    ends = [i for i in (text.find('\nfunction ', start + 1),
                        text.find('\nprocedure ', start + 1)) if i != -1]
    return text[start:min(ends)] if ends else text[start:]


def _iss():
    return ISS.read_text(encoding='utf-8-sig')


def test_the_desktop_app_is_closed_before_the_service_is_stopped():
    setup = _routine(_iss(), 'function InitializeSetup(): Boolean;')
    stop = setup.index("Exec('net', 'stop OwletteService'")
    kill = setup.find('KillDesktopApps(')

    assert kill != -1 and kill < stop


def test_a_second_pass_after_the_stop_catches_a_relaunched_app():
    # until it has stopped, the old service relaunches the app on its next
    # status check, and a relaunched app holds its exe through the file copy
    setup = _routine(_iss(), 'function InitializeSetup(): Boolean;')
    stop = setup.index("Exec('net', 'stop OwletteService'")

    assert setup.find('KillDesktopApps(', stop) != -1


def test_the_kill_is_scoped_to_the_install():
    kill = _routine(_iss(), 'procedure KillDesktopApps(')

    assert 'owlette-desktop, owlette-swoop-viewer' in kill
    assert "*\\Owlette\\*" in kill


def test_the_exe_is_parked_before_the_first_kill():
    setup = _routine(_iss(), 'function InitializeSetup(): Boolean;')
    park = setup.find('ParkDesktopExe(')

    assert park != -1 and park < setup.find('KillDesktopApps(')


def test_an_upgrade_that_stops_short_puts_the_parked_exe_back():
    # every way an upgrade ends after the park passes through DeinitializeSetup,
    # whose service restart needs the app's exe where the old service looks
    teardown = _routine(_iss(), 'procedure DeinitializeSetup();')
    settle = teardown.find('SettleParkedDesktopExe(')

    assert settle != -1 and settle < teardown.find("'start OwletteService'")


def test_the_parked_exe_outlives_a_rolled_back_copy():
    # [InstallDelete] runs before the copy, and a copy that aborts rolls the new
    # exe back as a new file, so deleting the parked one there left no app at all
    iss = _iss()
    section = iss[iss.index('\n[InstallDelete]'):]
    section = section[:section.index('\n[', 1)]
    assert '.upgrading' not in section

    settle = _routine(iss, 'procedure SettleParkedDesktopExe(')
    assert settle.index('FileExists(DesktopExePath())') < settle.index('DeleteFile(ParkedDesktopExePath())')
