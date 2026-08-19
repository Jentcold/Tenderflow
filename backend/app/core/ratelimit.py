import asyncio
import math
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

from app.config import settings

_PRUNE_INTERVAL_SECONDS = 300


def client_ip(request: Request) -> str:
    if settings.TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class _SlidingWindow:
    def __init__(self, window_seconds: int) -> None:
        self._window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()
        self._last_prune = 0.0

    async def hit(self, key: str, limit: int) -> float:
        now = time.monotonic()
        async with self._lock:
            self._prune(now)
            hits = self._hits[key]
            cutoff = now - self._window
            while hits and hits[0] <= cutoff:
                hits.popleft()

            if len(hits) >= limit:
                return max(0.0, hits[0] + self._window - now)

            hits.append(now)
            return 0.0

    def _prune(self, now: float) -> None:
        if now - self._last_prune < _PRUNE_INTERVAL_SECONDS:
            return
        self._last_prune = now
        cutoff = now - self._window
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]


class RateLimit:
    def __init__(self, times: int, seconds: int) -> None:
        self.times = times
        self.seconds = seconds
        self._window = _SlidingWindow(seconds)

    async def __call__(self, request: Request) -> None:
        if not settings.RATE_LIMIT_ENABLED:
            return
        retry_after = await self._window.hit(client_ip(request), self.times)
        if retry_after:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many requests. Please slow down and try again shortly.",
                headers={"Retry-After": str(math.ceil(retry_after))},
            )


class LoginThrottle:
    def __init__(self) -> None:
        self._failures: dict[str, tuple[int, float]] = {}
        self._lock = asyncio.Lock()
        self._last_prune = 0.0

    async def seconds_remaining(self, identifier: str) -> float:
        async with self._lock:
            now = time.monotonic()
            self._prune(now)
            entry = self._failures.get(identifier)
            if not entry:
                return 0.0
            count, last_failure = entry
            if count < settings.LOGIN_MAX_FAILURES:
                return 0.0
            return max(0.0, last_failure + settings.LOGIN_LOCKOUT_SECONDS - now)

    async def record_failure(self, identifier: str) -> None:
        async with self._lock:
            now = time.monotonic()
            count, last_failure = self._failures.get(identifier, (0, now))
            if now - last_failure > settings.LOGIN_LOCKOUT_SECONDS:
                count = 0
            self._failures[identifier] = (count + 1, now)

    async def reset(self, identifier: str) -> None:
        async with self._lock:
            self._failures.pop(identifier, None)

    def _prune(self, now: float) -> None:
        if now - self._last_prune < _PRUNE_INTERVAL_SECONDS:
            return
        self._last_prune = now
        cutoff = now - settings.LOGIN_LOCKOUT_SECONDS
        for key in [k for k, (_, last) in self._failures.items() if last <= cutoff]:
            del self._failures[key]


def lockout_error(retry_after: float) -> HTTPException:
    minutes = max(1, math.ceil(retry_after / 60))
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        f"Too many failed login attempts. Try again in about {minutes} minute(s).",
        headers={"Retry-After": str(math.ceil(retry_after))},
    )


login_ip_limit = RateLimit(settings.LOGIN_RATE_LIMIT_TIMES, settings.LOGIN_RATE_LIMIT_SECONDS)
login_throttle = LoginThrottle()

vendor_read_limit = RateLimit(settings.VENDOR_READ_RATE_LIMIT_TIMES, settings.VENDOR_READ_RATE_LIMIT_SECONDS)
vendor_submit_limit = RateLimit(settings.VENDOR_SUBMIT_RATE_LIMIT_TIMES, settings.VENDOR_SUBMIT_RATE_LIMIT_SECONDS)
vendor_register_limit = RateLimit(
    settings.VENDOR_REGISTER_RATE_LIMIT_TIMES, settings.VENDOR_REGISTER_RATE_LIMIT_SECONDS
)
