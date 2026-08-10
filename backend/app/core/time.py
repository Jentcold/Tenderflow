"""One definition of "now" for the whole backend.

Everything runs on server time. The values are still timezone-aware, because
mixing naive and aware datetimes is exactly the bug this module exists to
prevent: the columns are `timestamptz`, so a naive value gets an offset
guessed for it somewhere down the stack, and comparing the two kinds raises
TypeError outright.

`SERVER_TIMEZONE` in .env pins the zone by name (e.g. "Africa/Cairo"). Left
empty, the process's local zone is used. Prefer naming it: a named zone knows
when DST starts and stops, so a deadline six months out still lands on the
right instant. Reading the offset once at startup would freeze whatever was
in effect the day the server booted.
"""
from datetime import date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.config import settings


def _configured_tz() -> ZoneInfo | None:
    name = settings.SERVER_TIMEZONE.strip()
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise RuntimeError(
            f"SERVER_TIMEZONE={name!r} is not a known timezone. Use an IANA "
            f"name like 'Africa/Cairo', or leave it empty to use the server's "
            f"local zone."
        ) from exc


# Resolved once: an unusable value should stop the app at startup, not at the
# first request that happens to touch a deadline.
SERVER_TZ = _configured_tz()


def server_now() -> datetime:
    """Current time, timezone-aware, on server time."""
    if SERVER_TZ is not None:
        return datetime.now(SERVER_TZ)
    return datetime.now().astimezone()


def combine_deadline(deadline_date: date, deadline_time: time) -> datetime:
    """A tender's deadline as an instant on server time.

    Deadlines are stored as a bare date and a bare time — what procurement
    typed — so the zone is applied here rather than at rest.
    """
    naive = datetime.combine(deadline_date, deadline_time)
    if SERVER_TZ is not None:
        # ZoneInfo resolves the offset for *that* date, DST included.
        return naive.replace(tzinfo=SERVER_TZ)
    # astimezone() on a naive value reads it as local time, likewise per-date.
    return naive.astimezone()


def is_past_deadline(deadline_date: date, deadline_time: time) -> bool:
    return server_now() > combine_deadline(deadline_date, deadline_time)
