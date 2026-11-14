"""Active hours as a window on the machine's clock.

Pure maths over the `{start, end}` window osadapter.active_hours() reads, so
everything that asks whether the machine is inside its active hours, or when
they end, gets the same answer. Whole hours, the start inclusive and the end
exclusive: Windows' default 8-17 is 8 AM to 5 PM. Also the one rule for the
override that lets a command act inside them.
"""

from datetime import datetime, time, timedelta, timezone

# the longest reason an override carries: the server refuses a longer one, so
# a longer one is not the server's
_OVERRIDE_REASON_MAX = 500


def is_inside(window: dict, now_local: datetime) -> bool:
    """Whether the wall-clock hour of `now_local` falls inside the window,
    which wraps past midnight when its start is the later hour."""
    start, end, hour = window['start'], window['end'], now_local.hour
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def window_end(window: dict, now_local: datetime) -> datetime:
    """The next instant the window's end hour strikes after `now_local`: when
    the window ends, from inside it.

    `now_local` is the machine's wall clock, naive as `datetime.now()` reads it
    or aware in a zone that carries its DST rules, and the answer is aware in
    the same zone. The end hour is set on the calendar date and only then
    resolved to an instant, the way shared_utils.compute_scheduled_instant
    resolves a scheduled reboot, so a DST change before the end moves the
    instant and never the hour on the clock. An end hour that a spring-forward
    gap skips resolves to the instant the clock jumps past it, and one that a
    fall-back repeats to its first pass.
    """
    end_hour, tz = time(window['end']), now_local.tzinfo
    end = _instant(datetime.combine(now_local.date(), end_hour), tz)
    if end.timestamp() <= now_local.timestamp():
        end = _instant(datetime.combine(now_local.date() + timedelta(days=1), end_hour), tz)
    return end


def describe(window: dict) -> str:
    """The window as the clock reads it: `08:00–17:00`."""
    return f"{window['start']:02d}:00–{window['end']:02d}:00"


def is_valid_override(override) -> bool:
    """Whether a command's `activeHoursOverride` has the shape the server
    writes for a person's approved call: a reason of at most 500 characters
    and who approved it, neither blank."""
    if not isinstance(override, dict):
        return False
    reason, approved_by = override.get('reason'), override.get('approvedBy')
    return (isinstance(reason, str) and bool(reason.strip())
            and len(reason) <= _OVERRIDE_REASON_MAX
            and isinstance(approved_by, str) and bool(approved_by.strip()))


def _instant(wall: datetime, tz) -> datetime:
    """A naive wall-clock time as an aware instant, in `tz` or, for None, the
    machine's own zone."""
    # through a timestamp, not straight to astimezone(): a naive astimezone()
    # puts an hour inside a spring-forward gap on the instant before the jump,
    # and an aware one leaves it reading a time the clock never shows
    stamp = wall.replace(tzinfo=tz).timestamp()
    return datetime.fromtimestamp(stamp, timezone.utc).astimezone(tz)
