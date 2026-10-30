"""Shanghai business-day calculation shared by read and write paths."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
DAY_START_HOUR = 4


def business_date(instant: datetime) -> date:
    """Return the local business date for an unambiguous instant."""
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("business date requires an aware datetime")
    local = instant.astimezone(SHANGHAI)
    return (local - timedelta(hours=DAY_START_HOUR)).date()
