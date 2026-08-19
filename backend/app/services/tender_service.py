import random

from app.core.time import server_now


def generate_serial() -> str:
    year = server_now().year
    return f"TND-{year}-{random.randint(0, 9999):04d}"
