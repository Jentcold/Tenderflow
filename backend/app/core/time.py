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


SERVER_TZ = _configured_tz()


def server_now() -> datetime:
    if SERVER_TZ is not None:
        return datetime.now(SERVER_TZ)
    return datetime.now().astimezone()


def combine_deadline(deadline_date: date, deadline_time: time) -> datetime:
    naive = datetime.combine(deadline_date, deadline_time)
    if SERVER_TZ is not None:
        return naive.replace(tzinfo=SERVER_TZ)
    return naive.astimezone()


def is_past_deadline(deadline_date: date | None, deadline_time: time | None) -> bool:
    if deadline_date is None or deadline_time is None:
        return False
    return server_now() > combine_deadline(deadline_date, deadline_time)
