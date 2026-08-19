import logging
from email.message import EmailMessage
from email.utils import formataddr

import aiosmtplib

from app.config import settings

logger = logging.getLogger(__name__)


class MailNotConfigured(RuntimeError):
    pass


def build_message(to_email: str, subject: str, body: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr((settings.MAIL_FROM_NAME, settings.MAIL_FROM))

    redirect = settings.MAIL_REDIRECT_TO.strip()
    if redirect:
        message["To"] = redirect
        message["X-Original-To"] = to_email
        message["Subject"] = f"[TEST -> {to_email}] {subject}"
        body = f"--- Test redirect. In production this would go to {to_email}. ---\n\n{body}"
    else:
        message["To"] = to_email
        message["Subject"] = subject

    message.set_content(body)
    return message


async def send_message(to_email: str, subject: str, body: str) -> None:
    if not settings.mail_configured:
        raise MailNotConfigured("SMTP_HOST is empty")

    message = build_message(to_email, subject, body)

    await aiosmtplib.send(
        message,
        hostname=settings.SMTP_HOST,
        port=settings.SMTP_PORT,
        username=settings.SMTP_USERNAME or None,
        password=settings.SMTP_PASSWORD or None,
        use_tls=settings.SMTP_USE_SSL,
        start_tls=settings.SMTP_START_TLS and not settings.SMTP_USE_SSL,
        timeout=settings.SMTP_TIMEOUT_SECONDS,
    )
    logger.info("Delivered email to %s (%s)", to_email, subject)
