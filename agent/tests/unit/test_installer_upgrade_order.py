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


# a self-update's old agent leaves OwletteRecovery_<ts>, a task that net-starts
# the service 300 s after the update starts. on a slow install that landed
# mid-copy, and the rolled-back install left site-packages empty (TEC-A4D,
# 2026-11-25). the installer ends it once the old agent is dead, which is when
# the task certainly exists, and before the copy.

def test_the_recovery_watchdog_is_ended_after_the_old_agent_is_dead_and_before_the_copy():
    setup = _routine(_iss(), 'function InitializeSetup(): Boolean;')
    watchdog = setup.find('OwletteRecovery_*')
    last_python_kill = setup.index("Log('Module-based kill returned: '")

    assert watchdog != -1
    # after the python kill passes: the old agent creates the task only after
    # it has started the installer, so an earlier sweep can miss it
    assert watchdog > last_python_kill
    # outside the upgrade branch, whose early aborts keep the watchdog as their
    # only restart; and ahead of the libcrypto poll, the last step before the copy
    assert watchdog < setup.index('LibCryptoPath :=')


def test_the_watchdog_sweep_kills_only_cmd_carrying_the_task_name():
    setup = _routine(_iss(), 'function InitializeSetup(): Boolean;')
    sweep = setup[setup.index("Log('Ending any self-update recovery watchdog...');"):]
    sweep = sweep[:sweep.index('Recovery watchdog cleanup returned')]

    # the name filter keeps the sweep off its own powershell and off any
    # other process whose command line mentions the task
    assert "Name = ''''cmd.exe''''''" in sweep
    assert "-like ''*OwletteRecovery_*''" in sweep
