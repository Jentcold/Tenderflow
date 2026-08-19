"""Addresses that get mailed to people outside the company.

Every link in an email has to resolve on *their* machine, which is the one
constraint the rest of the app never has to think about. `http://localhost:5500`
is correct on the laptop running the stack and meaningless everywhere else: to
the recipient, "localhost" is their own machine, so the mail arrives looking
fine and the link goes nowhere. That failure is silent - nothing logs, nothing
500s, the vendor just can't bid.

So links are built in exactly one place, here, and no router spells out a host
of its own.

There are two ways to answer "what host?", and the setting picks between them:

- FRONTEND_BASE_URL set  -> that, verbatim. Explicit, stable, and the right
  answer for a real deployment. It is also the only one a request can't
  influence, which matters because these links go out by email.

- FRONTEND_BASE_URL empty -> read it off the request being served. This is what
  makes a tunnel work without touching config: whatever host the browser used
  to reach the app is the host the vendor gets. Handy for demos, ngrok included,
  where the address changes every restart and uvicorn's --reload does not pick
  up .env anyway.

The derived path trusts X-Forwarded-Proto/Host when they are present. It has to:
a tunnel terminates TLS at its own edge and forwards plain http to us, so the
Host alone would build an http:// link for an https-only domain. The cost is
that those headers are caller-supplied, so anyone able to reach the API directly
can shape the link in the *next* RFQ email. That is the trade being made by
leaving the setting empty, and it is why anything long-lived should set it.
"""
from fastapi import Request

from app.config import settings


def frontend_base_url(request: Request) -> str:
    """Where the browser-facing pages live, without a trailing slash."""
    configured = (settings.FRONTEND_BASE_URL or "").strip().rstrip("/")
    if configured:
        return configured

    # Behind a tunnel or proxy the interesting values are in the forwarded
    # headers; hitting uvicorn directly leaves them absent and the request's
    # own scheme/host are already right.
    forwarded_host = request.headers.get("x-forwarded-host")
    host = (forwarded_host or request.headers.get("host") or "").split(",")[0].strip()

    scheme = (
        request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        or request.url.scheme
    )

    if not host:
        # No Host header at all is HTTP/1.0 or a synthetic call. Nothing useful
        # to derive from, so fall back rather than emit a link to "://".
        return "http://localhost:5500"

    return f"{scheme}://{host}"


def vendor_invite_link(token: str, request: Request) -> str:
    """The address a vendor opens to price a tender.

    `vendor.html` is a page of its own, not the staff app with a query string
    on it. A vendor is outside the company, and serving them index.html served
    them every internal screen and endpoint name along with it. The file
    extension is there because nothing does server-side routing here, so a
    pretty path like `/vendor` 404s on whatever is serving the files.
    """
    return f"{frontend_base_url(request)}/vendor.html?invite={token}"
