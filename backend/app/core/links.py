from fastapi import Request

from app.config import settings


def frontend_base_url(request: Request) -> str:
    configured = (settings.FRONTEND_BASE_URL or "").strip().rstrip("/")
    if configured:
        return configured

    forwarded_host = request.headers.get("x-forwarded-host")
    host = (forwarded_host or request.headers.get("host") or "").split(",")[0].strip()

    scheme = (
        request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        or request.url.scheme
    )

    if not host:
        return "http://localhost:5500"

    return f"{scheme}://{host}"


def vendor_invite_link(token: str, request: Request) -> str:
    return f"{frontend_base_url(request)}/vendor.html?invite={token}"
