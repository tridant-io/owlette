"""The streamer a build script tells you to build by hand is the one the full
build ships: audio-opus is not a default feature, so a bare
`cargo build --release` in agent/swoop gives a streamer with no audio."""
from pathlib import Path

QUICK = Path(__file__).resolve().parents[2] / 'build_installer_quick.bat'


def test_every_swoop_build_hint_enables_audio():
    hints = [line for line in QUICK.read_text(encoding='utf-8').splitlines()
             if 'cargo build' in line and 'swoop' in line]

    assert hints
    for line in hints:
        assert '--features audio-opus' in line, line
