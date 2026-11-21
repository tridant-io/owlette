"""`shared_utils.is_within_schedule` — which clock a process window is judged on.

This function decides, every 5 seconds, whether each `launch_mode='scheduled'`
process should be running. It has been timezone-aware and DST-correct since it
was written, and until 3.3.0 it had zero tests — because nothing could ever pass
it a timezone: `site_timezone` was populated only by a Firestore read that 403s.
Wave 2 made the argument reachable, so the behaviour it has always claimed is
now load-bearing and gets pinned here.

The clock is frozen in every test that cares about "now". `is_within_schedule`
resolves `datetime` by a function-local import, so the freeze is applied to the
`datetime` module's own attribute — patching `shared_utils.datetime` would miss
it entirely.
"""

import datetime as datetime_module
import re
from pathlib import Path

import pytest

import shared_utils

ZoneInfo = pytest.importorskip(
    'zoneinfo', reason='python <3.9 uses the backports package',
).ZoneInfo


# The window every test below is judged against: a plain office-hours schedule.
OFFICE_HOURS = [{
    'days': ['mon', 'tue', 'wed', 'thu', 'fri'],
    'ranges': [{'start': '09:00', 'stop': '17:00'}],
}]


@pytest.fixture
def frozen_clock(monkeypatch):
    """Freeze wall-clock time at a chosen instant, in a chosen machine timezone.

    Returns a setter taking (instant, machine_tz). `machine_tz` stands in for the
    OS timezone: `datetime.now(None)` returns naive local time, so without
    controlling it the "site tz vs machine tz" tests would pass or fail depending
    on where the test runner happens to be.
    """
    real_datetime = datetime_module.datetime

    def freeze(instant, machine_tz):
        class _Frozen(real_datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is None:
                    # What the OS clock would read: naive, in the machine's zone.
                    return instant.astimezone(machine_tz).replace(tzinfo=None)
                return instant.astimezone(tz)

        monkeypatch.setattr(datetime_module, 'datetime', _Frozen)

    return freeze


class TestTheSiteTimezoneActuallyChangesTheVerdict:
    """The whole point of Wave 2: two machines in different places, one window.

    The instant below is Wednesday 10:00 in Los Angeles and Thursday 02:00 in
    Tokyo. A mon–fri 09:00–17:00 window is open on the first reading and shut on
    the second — so if the timezone argument were ignored, or silently dropped,
    these two assertions could not both hold.
    """

    # 2026-06-10 17:00Z — inside LA's Wednesday, past midnight into Tokyo's Thursday.
    INSTANT = datetime_module.datetime(2026, 6, 10, 17, 0, tzinfo=datetime_module.timezone.utc)
    TOKYO = ZoneInfo('Asia/Tokyo')

    def test_the_site_clock_says_the_window_is_open(self, frozen_clock):
        frozen_clock(self.INSTANT, self.TOKYO)

        assert shared_utils.is_within_schedule(
            OFFICE_HOURS, 'America/Los_Angeles') is True

    def test_the_machine_clock_says_it_is_shut(self, frozen_clock):
        # Same instant, same schedule, no timezone — this is what every agent
        # before 3.3.0 did, and what a site that declines the flag still does.
        frozen_clock(self.INSTANT, self.TOKYO)

        assert shared_utils.is_within_schedule(OFFICE_HOURS, None) is False

    def test_the_machines_own_zone_agrees_with_passing_it_explicitly(self, frozen_clock):
        # Sanity anchor for the two above: the divergence is the timezones
        # disagreeing, not the None path taking a different code route.
        frozen_clock(self.INSTANT, self.TOKYO)

        assert shared_utils.is_within_schedule(OFFICE_HOURS, 'Asia/Tokyo') is False


class TestTheOvernightWindowAcrossTheSpringForwardGap:
    """R4. Overnight windows are the only branch that reasons about *yesterday*,
    and DST is where that reasoning can meet a wall clock that never existed.

    America/Los_Angeles springs forward on Sunday 2026-03-08: 02:00 becomes
    03:00, so local times 02:00–02:59 do not occur that day. A Saturday-22:00 →
    Sunday-02:30 window therefore loses its final half hour. The requirement is
    that it degrades to "not in the window" — quietly and without raising — not
    that it crashes the 5s loop or resurrects the missing time.
    """

    OVERNIGHT = [{'days': ['sat'], 'ranges': [{'start': '22:00', 'stop': '02:30'}]}]
    LA = 'America/Los_Angeles'
    TOKYO = ZoneInfo('Asia/Tokyo')

    def _at(self, utc_hour, utc_minute=0, day=8):
        return datetime_module.datetime(
            2026, 3, day, utc_hour, utc_minute, tzinfo=datetime_module.timezone.utc)

    def test_before_the_gap_the_window_is_still_open(self, frozen_clock):
        # 09:45Z Sunday = 01:45 PST — Saturday's window, 45 minutes to run.
        frozen_clock(self._at(9, 45), self.TOKYO)

        assert shared_utils.is_within_schedule(self.OVERNIGHT, self.LA) is True

    def test_at_the_gap_it_degrades_to_no_match_rather_than_raising(self, frozen_clock):
        # 10:00Z Sunday = 03:00 PDT. The clock jumped straight past 02:30, so the
        # window's stop time was never displayed and can never be matched.
        frozen_clock(self._at(10, 0), self.TOKYO)

        assert shared_utils.is_within_schedule(self.OVERNIGHT, self.LA) is False

    def test_the_evening_half_of_the_window_is_unaffected(self, frozen_clock):
        # Saturday 2026-03-07 23:00 PST = 07:00Z Sunday.
        frozen_clock(self._at(7, 0), self.TOKYO)

        assert shared_utils.is_within_schedule(self.OVERNIGHT, self.LA) is True

    def test_a_day_the_window_does_not_name_stays_shut(self, frozen_clock):
        # Sunday 22:00 PDT: the window is Saturday's, and Sunday is not in `days`.
        frozen_clock(self._at(5, 0, day=9), self.TOKYO)

        assert shared_utils.is_within_schedule(self.OVERNIGHT, self.LA) is False


class TestAnUnusableTimezone:
    """R5's failure mode, up close.

    A timezone key that `ZoneInfo` cannot resolve — a typo, or (far more likely
    in production) a perfectly valid key on a machine whose `tzdata` went missing
    — does not raise. It warns once and evaluates the window against the
    machine's local clock instead. That is the right call for a supervisor, but
    it means a broken IANA database shows up as processes running at the wrong
    hours rather than as an error, which is why the pin below is a test.
    """

    INSTANT = datetime_module.datetime(2026, 6, 10, 17, 0, tzinfo=datetime_module.timezone.utc)

    def test_an_invalid_key_falls_back_to_local_time_and_warns(self, frozen_clock, caplog):
        # Machine is in LA, where this instant is inside the window; the bogus
        # zone must not turn that into a False.
        frozen_clock(self.INSTANT, ZoneInfo('America/Los_Angeles'))

        with caplog.at_level('WARNING'):
            verdict = shared_utils.is_within_schedule(OFFICE_HOURS, 'Not/AZone')

        assert verdict is True
        assert 'falling back to local time' in caplog.text

    def test_a_valid_key_with_no_database_behind_it_degrades_the_same_way(
        self, frozen_clock, caplog, monkeypatch
    ):
        # Simulates tzdata being absent: the key is real, the lookup still fails.
        # The verdict silently becomes the machine's, which is the bug R5 is
        # about — assert it so the shape of the failure is documented.
        frozen_clock(self.INSTANT, ZoneInfo('Asia/Tokyo'))

        import zoneinfo

        def _no_database(key):
            raise zoneinfo.ZoneInfoNotFoundError(f'No time zone found with key {key}')

        # Patched on the module, not on shared_utils: the import is inside the
        # function, so it re-reads this attribute on every call.
        monkeypatch.setattr(zoneinfo, 'ZoneInfo', _no_database)

        with caplog.at_level('WARNING'):
            verdict = shared_utils.is_within_schedule(
                OFFICE_HOURS, 'America/Los_Angeles')

        # Tokyo's Thursday 02:00 — the site said it was open, the machine says shut.
        assert verdict is False
        assert 'falling back to local time' in caplog.text


class TestTheIanaDatabaseIsInstalled:
    """R5, pinned. Windows ships no IANA database, so `zoneinfo` can only resolve
    "America/Los_Angeles" out of the `tzdata` package. It reached the agent
    transitively, through `tzlocal`'s Windows marker — a coincidence, not a
    contract. If it ever stops arriving, every site-time schedule silently
    reverts to machine-local (see the test directly above) with nothing logged
    at install time and no error to chase in the field.
    """

    @pytest.mark.parametrize('key', [
        'America/Los_Angeles', 'America/New_York', 'Europe/London',
        'Asia/Tokyo', 'Australia/Sydney', 'UTC',
    ])
    def test_zoneinfo_resolves_real_site_timezones(self, key):
        assert ZoneInfo(key) is not None

    def test_requirements_pins_tzdata_directly(self):
        requirements = (
            Path(__file__).resolve().parents[2] / 'requirements.txt'
        ).read_text(encoding='utf-8')

        assert re.search(r'^tzdata==\d', requirements, re.MULTILINE), (
            'tzdata must be pinned directly, not inherited from tzlocal'
        )


class TestTheUnscheduledCases:
    """The cheap paths that run on every tick for every scheduled process."""

    def test_no_schedules_means_always_active(self):
        # Safety fallback: a process set to 'scheduled' with nothing configured
        # must not be silently un-supervised.
        assert shared_utils.is_within_schedule(None, 'America/Los_Angeles') is True
        assert shared_utils.is_within_schedule([], 'America/Los_Angeles') is True

    def test_a_malformed_range_is_skipped_not_fatal(self, frozen_clock):
        frozen_clock(
            datetime_module.datetime(2026, 6, 10, 17, 0, tzinfo=datetime_module.timezone.utc),
            ZoneInfo('America/Los_Angeles'),
        )
        schedules = [{
            'days': ['wed'],
            'ranges': [
                {'start': 'not-a-time', 'stop': '17:00'},
                {'start': '09:00', 'stop': '17:00'},
            ],
        }]

        # The good range still decides the verdict.
        assert shared_utils.is_within_schedule(schedules, 'America/Los_Angeles') is True

    @pytest.mark.parametrize('bad_range', [
        {'start': '24:00', 'stop': '17:00'},  # an hour no clock has
        {'start': '09:00', 'stop': '17:60'},  # a minute no clock has
        {'start': 900, 'stop': '17:00'},      # not a string
        '09:00-17:00',                        # not a mapping
    ])
    def test_a_range_no_clock_can_hold_is_skipped_not_fatal(self, frozen_clock, bad_range):
        # A raise here leaves the main loop and ends the agent, and owlette-host
        # (launchd, systemd) relaunches it into the same config: one bad value
        # would stop every process on the machine from being supervised.
        frozen_clock(
            datetime_module.datetime(2026, 6, 10, 17, 0, tzinfo=datetime_module.timezone.utc),
            ZoneInfo('America/Los_Angeles'),
        )
        schedules = [{
            'days': ['wed'],
            'ranges': [bad_range, {'start': '09:00', 'stop': '17:00'}],
        }]

        assert shared_utils.is_within_schedule(schedules, 'America/Los_Angeles') is True

    @pytest.mark.parametrize('bad_block', [
        'mon-fri 09:00-17:00',  # not a mapping
        {'days': None, 'ranges': [{'start': '00:00', 'stop': '23:59'}]},
        {'days': ['wed'], 'ranges': None},
    ])
    def test_a_malformed_block_is_skipped_not_fatal(self, frozen_clock, bad_block):
        frozen_clock(
            datetime_module.datetime(2026, 6, 10, 17, 0, tzinfo=datetime_module.timezone.utc),
            ZoneInfo('America/Los_Angeles'),
        )
        good_block = {'days': ['wed'], 'ranges': [{'start': '09:00', 'stop': '17:00'}]}

        assert shared_utils.is_within_schedule([bad_block, good_block], 'America/Los_Angeles') is True
        assert shared_utils.is_within_schedule([bad_block], 'America/Los_Angeles') is False

    def test_schedules_that_are_not_a_list_fall_back_like_none_at_all(self):
        assert shared_utils.is_within_schedule(7, 'America/Los_Angeles') is True

    def test_a_block_with_no_days_defaults_to_every_day(self, frozen_clock):
        frozen_clock(
            datetime_module.datetime(2026, 6, 13, 17, 0, tzinfo=datetime_module.timezone.utc),
            ZoneInfo('America/Los_Angeles'),
        )  # a Saturday, 10:00 in LA

        assert shared_utils.is_within_schedule(
            [{'ranges': [{'start': '09:00', 'stop': '17:00'}]}],
            'America/Los_Angeles',
        ) is True


class TestTheMainLoopKeepsTheCachedTimezoneFresh:
    """`OwletteService.main` must recopy the timezone every tick.

    Structural rather than behavioural: `main` is a several-hundred-line loop
    that launches processes, reads the registry and writes status files, so it
    cannot be driven in a unit test. The repo already guards it this way — see
    `test_config_sync_client.py::test_the_main_loop_starts_it_and_no_longer_calls_the_detector`.

    What this protects: before 3.3.0 `_cached_site_timezone` was copied exactly
    twice, both during startup. A site that opted in — or, worse, opted back out
    — after the service started never reached schedule evaluation until the next
    service restart, no matter how often the client refreshed underneath it.
    """

    REFRESH = 'self._cached_site_timezone = self.firebase_client.site_timezone'

    @staticmethod
    def _loop_body():
        import inspect

        import owlette_service

        source = inspect.getsource(owlette_service.OwletteService.main)
        marker = 'while self.is_alive:'
        assert marker in source, 'main loop shape changed — retarget this guard'
        return source.split(marker, 1)[1]

    def test_every_tick_recopies_the_timezone_from_the_client(self):
        assert self.REFRESH in self._loop_body()

    def test_the_refresh_precedes_the_schedule_evaluation_it_feeds(self):
        # A copy made after the process sweep would always be one tick stale.
        body = self._loop_body()

        assert body.index(self.REFRESH) < body.index('is_within_schedule(')

    def test_it_is_guarded_so_a_cloudless_machine_does_not_crash(self):
        # firebase_client is None on an unpaired or offline-configured machine,
        # and this runs before any connection check.
        body = self._loop_body()

        assert 'if self.firebase_client:' in body[:body.index(self.REFRESH)][-200:]

    def test_the_tick_does_no_network_work(self):
        # The 5s loop drives all process supervision. The refresh that feeds this
        # copy is a 10s-timeout HTTP call and lives on the metrics thread; only
        # the attribute read belongs here.
        body = self._loop_body()
        window = body[:body.index(self.REFRESH)][-400:]

        assert '_fetch_site_metadata' not in window
