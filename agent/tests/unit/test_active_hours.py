"""`active_hours` — inside the window, when it ends, and how it reads.

The window is whole hours on the machine's clock, the start inclusive and the
end exclusive, wrapping past midnight when the start is the later hour. The
DST cases run in a named zone, so they hold wherever the suite runs; the
machine-zone case sets the zone itself and so runs only where it can.
"""

import time
from datetime import datetime, timedelta, timezone

import pytest

import active_hours

ZoneInfo = pytest.importorskip(
    'zoneinfo', reason='python <3.9 uses the backports package',
).ZoneInfo

NEW_YORK = ZoneInfo('America/New_York')
DAYTIME = {'start': 8, 'end': 17, 'source': 'default'}
# the window measured on the dev box: 8 am to 2 am, eighteen hours across midnight
OVERNIGHT = {'start': 8, 'end': 2, 'source': 'user'}
LATE = {'start': 22, 'end': 2, 'source': 'policy'}


def _at(hour, minute=0, day=15, month=7, tz=None):
    return datetime(2026, month, day, hour, minute, tzinfo=tz)


def _elapsed(start, end):
    """Real time between two instants: subtracting two datetimes that share a
    tzinfo compares their clocks, not the time that passed."""
    return timedelta(seconds=end.timestamp() - start.timestamp())


class TestIsInside:

    @pytest.mark.parametrize('hour, minute, inside', [
        (7, 59, False),
        (8, 0, True),
        (12, 30, True),
        (16, 59, True),
        (17, 0, False),
        (23, 0, False),
    ])
    def test_the_start_is_inclusive_and_the_end_exclusive(self, hour, minute, inside):
        assert active_hours.is_inside(DAYTIME, _at(hour, minute)) is inside

    @pytest.mark.parametrize('hour, minute, inside', [
        (7, 59, False),
        (8, 0, True),
        (23, 59, True),
        (0, 0, True),
        (1, 59, True),
        (2, 0, False),
        (5, 0, False),
    ])
    def test_a_window_whose_start_is_later_wraps_past_midnight(self, hour, minute, inside):
        assert active_hours.is_inside(OVERNIGHT, _at(hour, minute)) is inside

    def test_the_hour_is_read_off_the_clock_in_the_callers_zone(self):
        """16:30 in New York is 13:30 in Los Angeles: one instant, outside an
        8-14 window on the first clock and inside it on the second."""
        instant = _at(16, 30, tz=NEW_YORK)
        los_angeles = instant.astimezone(ZoneInfo('America/Los_Angeles'))
        early = {'start': 8, 'end': 14, 'source': 'user'}

        assert active_hours.is_inside(early, instant) is False
        assert active_hours.is_inside(early, los_angeles) is True


class TestWindowEnd:

    def test_inside_the_window_it_is_when_the_window_ends(self):
        assert active_hours.window_end(DAYTIME, _at(9, tz=NEW_YORK)) == _at(17, tz=NEW_YORK)

    def test_before_the_window_it_is_the_end_of_todays(self):
        assert active_hours.window_end(DAYTIME, _at(6, tz=NEW_YORK)) == _at(17, tz=NEW_YORK)

    @pytest.mark.parametrize('hour', [17, 18, 23])
    def test_from_the_end_hour_on_it_is_tomorrows(self, hour):
        """At 17:00 the window has already ended, so the next end is a day out."""
        assert active_hours.window_end(DAYTIME, _at(hour, tz=NEW_YORK)) == _at(
            17, day=16, tz=NEW_YORK)

    def test_a_wrapped_window_entered_before_midnight_ends_tomorrow(self):
        assert active_hours.window_end(OVERNIGHT, _at(23, tz=NEW_YORK)) == _at(
            2, day=16, tz=NEW_YORK)

    def test_a_wrapped_window_after_midnight_ends_the_same_day(self):
        assert active_hours.window_end(OVERNIGHT, _at(1, 30, tz=NEW_YORK)) == _at(
            2, tz=NEW_YORK)

    def test_the_end_is_an_instant_in_the_callers_zone(self):
        end = active_hours.window_end(DAYTIME, _at(9, tz=NEW_YORK))

        assert end.tzinfo is NEW_YORK

    def test_a_naive_clock_answers_in_the_machines_zone(self):
        """`datetime.now()` reads naive local time; the end comes back aware."""
        end = active_hours.window_end(DAYTIME, _at(9))

        assert end.tzinfo is not None
        assert end.replace(tzinfo=None) == _at(17)


class TestWindowEndAcrossDst:
    """New York, 2026: the clocks go forward at 02:00 on 8 March and back at
    02:00 on 1 November."""

    def test_the_end_tomorrow_stays_on_the_clock_across_spring_forward(self):
        """17:00 the next day is 22 hours away, not 23: the instant moves and
        the hour on the clock does not."""
        now = _at(18, day=7, month=3, tz=NEW_YORK)

        end = active_hours.window_end(DAYTIME, now)

        assert end == _at(17, day=8, month=3, tz=NEW_YORK)
        assert _elapsed(now, end) == timedelta(hours=22)

    def test_the_end_tomorrow_stays_on_the_clock_across_fall_back(self):
        now = _at(18, day=31, month=10, tz=NEW_YORK)

        end = active_hours.window_end(DAYTIME, now)

        assert end == _at(17, day=1, month=11, tz=NEW_YORK)
        assert _elapsed(now, end) == timedelta(hours=24)

    def test_an_end_hour_the_jump_skips_ends_when_the_clock_jumps(self):
        """02:00 never shows on 8 March: the clock goes from 01:59 to 03:00,
        and the window is over the moment it does."""
        now = _at(1, 30, day=8, month=3, tz=NEW_YORK)

        end = active_hours.window_end(LATE, now)

        assert end.astimezone(timezone.utc) == datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc)
        assert (end.hour, end.minute) == (3, 0)
        assert _elapsed(now, end) == timedelta(minutes=30)
        assert active_hours.is_inside(LATE, now) is True
        assert active_hours.is_inside(LATE, end) is False

    def test_an_end_hour_the_clock_repeats_ends_on_its_first_pass(self):
        """01:00-02:00 shows twice on 1 November; the window ends the first
        time the clock reads 01:00, and the second pass is outside it too."""
        window = {'start': 20, 'end': 1, 'source': 'user'}
        now = _at(0, 30, day=1, month=11, tz=NEW_YORK)

        end = active_hours.window_end(window, now)

        assert end.astimezone(timezone.utc) == datetime(2026, 11, 1, 5, 0, tzinfo=timezone.utc)
        assert _elapsed(now, end) == timedelta(minutes=30)
        second_pass = datetime(2026, 11, 1, 1, 30, fold=1, tzinfo=NEW_YORK)
        assert active_hours.is_inside(window, second_pass) is False


@pytest.fixture
def machine_zone(monkeypatch):
    """Set the zone a naive clock is read in, where the OS lets a process do
    that (posix's TZ and tzset), and put it back afterwards."""
    if not hasattr(time, 'tzset'):
        pytest.skip('only posix lets a process set its own zone')

    with monkeypatch.context() as patch:
        def set_zone(name):
            patch.setenv('TZ', name)
            time.tzset()

        yield set_zone
    time.tzset()


def test_a_naive_clock_resolves_a_skipped_end_hour_to_the_jump(machine_zone):
    """The case a naive astimezone() gets wrong: it puts 02:00 on 8 March on
    01:00 EST, before the jump, which would read as already past and push the
    end a whole day out."""
    machine_zone('America/New_York')
    now = datetime(2026, 3, 8, 1, 30)

    end = active_hours.window_end(LATE, now)

    assert end.astimezone(timezone.utc) == datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc)
    assert _elapsed(now, end) == timedelta(minutes=30)


@pytest.mark.parametrize('window, reads', [
    (DAYTIME, '08:00–17:00'),
    (OVERNIGHT, '08:00–02:00'),
    ({'start': 0, 'end': 9, 'source': 'mdm'}, '00:00–09:00'),
])
def test_describe_reads_the_window_off_the_clock(window, reads):
    assert active_hours.describe(window) == reads


@pytest.mark.parametrize('override', [
    {'reason': 'swap the projector before doors', 'approvedBy': 'user:u1'},
    {'reason': 'x' * 500, 'approvedBy': 'apiKey:k1'},
])
def test_a_reason_and_who_approved_it_make_an_override(override):
    assert active_hours.is_valid_override(override) is True


@pytest.mark.parametrize('override', [
    None,
    'swap the projector',
    {},
    {'reason': 'swap the projector'},
    {'reason': '', 'approvedBy': 'user:u1'},
    {'reason': '   ', 'approvedBy': 'user:u1'},
    {'reason': 'x' * 501, 'approvedBy': 'user:u1'},
    {'reason': 'swap the projector', 'approvedBy': ''},
    {'reason': 'swap the projector', 'approvedBy': '   '},
    {'reason': 'swap the projector', 'approvedBy': 7},
    {'reason': ['swap the projector'], 'approvedBy': 'user:u1'},
])
def test_anything_less_is_no_override(override):
    assert active_hours.is_valid_override(override) is False
