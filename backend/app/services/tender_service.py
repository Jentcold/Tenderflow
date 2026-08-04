import random
from datetime import datetime


def generate_serial() -> str:
    year = datetime.utcnow().year
    return f"TND-{year}-{random.randint(0, 9999):04d}"
