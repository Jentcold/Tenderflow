import random

from app.core.time import server_now


def generate_serial() -> str:
    # Server time, not UTC: a tender created on the evening of 31 December
    # should carry the year everyone in the office thinks it is.
    year = server_now().year
    return f"TND-{year}-{random.randint(0, 9999):04d}"
