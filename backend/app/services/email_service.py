import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.time import server_now
from app.database import AsyncSessionLocal
from app.models.email import EmailStatus, EmailTemplate, EmailType, SentEmail
from app.models.submission import Submission
from app.models.tender import Tender
from app.services.mailer import send_message

logger = logging.getLogger(__name__)


def render_template(subject: str, body: str, replacements: dict[str, str]) -> tuple[str, str]:
    for key, value in replacements.items():
        subject = subject.replace(key, value)
        body = body.replace(key, value)
    return subject, body


async def get_templates(db: AsyncSession) -> dict[EmailType, EmailTemplate]:
    result = await db.execute(select(EmailTemplate))
    return {t.type: t for t in result.scalars().all()}


def _queue_email(
    db: AsyncSession,
    template: EmailTemplate,
    tender: Tender,
    sub: Submission,
    email_type: EmailType,
    score: float | None,
) -> SentEmail:
    """Render one template against one submission and stage the row."""
    replacements = {
        "{vendor_company}": sub.company_name,
        "{vendor_contact}": sub.contact_name,
        "{vendor_email}": sub.email,
        "{tender_name}": tender.name,
        "{tender_serial}": tender.serial,
        "{tender_category}": tender.category.value,
        "{currency}": tender.currency,
        "{awarded_amount}": f"{tender.awarded_amount:,.2f}" if tender.awarded_amount else "0",
        "{bid_amount}": f"{sub.total_amount:,.2f}",
        # Placeholder token kept as-is: it's baked into template bodies
        # already stored in email_templates, renaming it would silently
        # stop substituting in anything procurement has saved.
        "{combined_score}": f"{score:.1f}" if score is not None else "N/A",
    }
    subject, body = render_template(template.subject, template.body, replacements)

    record = SentEmail(
        tender_id=tender.id,
        tender_serial=tender.serial,
        tender_name=tender.name,
        submission_id=sub.id,
        vendor_company=sub.company_name,
        recipient_email=sub.email,
        type=email_type,
        subject=subject,
        body=body,
        status=EmailStatus.queued if settings.mail_configured else EmailStatus.simulated,
    )
    db.add(record)
    return record


async def send_award_emails(
    db: AsyncSession,
    tender: Tender,
    submissions: list[Submission],
    scores_by_submission: dict,
) -> list[SentEmail]:
    """Builds a SentEmail row per vendor (winner template for the awarded one, loser for the rest).

    Every submission on the tender gets one, including bids procurement never
    scored — an unscored vendor still bid and is still owed an answer.

    Rows are only queued here — nothing touches the network inside the request.
    Hand the returned ids to `dispatch_emails` as a background task so a slow or
    unreachable mail server can't fail (or stall) the award itself.
    """
    templates = await get_templates(db)
    return [
        _queue_email(
            db,
            templates[EmailType.winner if sub.id == tender.awarded_vendor_submission_id else EmailType.loser],
            tender,
            sub,
            EmailType.winner if sub.id == tender.awarded_vendor_submission_id else EmailType.loser,
            scores_by_submission.get(sub.id),
        )
        for sub in submissions
    ]


async def send_reassignment_emails(
    db: AsyncSession,
    tender: Tender,
    previous: Submission,
    replacement: Submission,
    scores_by_submission: dict,
) -> list[SentEmail]:
    """Two emails only: the withdrawal to the vendor who lost the award, and the
    win to the vendor who gained it.

    The other bidders were already told they lost when the tender was first
    awarded, and nothing about that has changed — mailing them again would just
    reopen a decision they've already been given.
    """
    templates = await get_templates(db)
    return [
        _queue_email(
            db, templates[EmailType.award_revoked], tender, previous,
            EmailType.award_revoked, scores_by_submission.get(previous.id),
        ),
        _queue_email(
            db, templates[EmailType.winner], tender, replacement,
            EmailType.winner, scores_by_submission.get(replacement.id),
        ),
    ]


# ------------------------------------------------------------------ delivery


async def _deliver_one(db: AsyncSession, email: SentEmail) -> None:
    """Attempt one email, recording the outcome on its row.

    Retries in-process with a short backoff. That covers a mail server
    momentarily refusing connections; it does not survive a restart, so a row
    left `failed` is meant to be picked up by the resend endpoint.
    """
    last_error = "Unknown error"

    for attempt in range(1, settings.MAIL_MAX_ATTEMPTS + 1):
        email.attempts += 1
        try:
            await send_message(email.recipient_email, email.subject, email.body)
        except Exception as exc:  # noqa: BLE001 — outcome is recorded, not swallowed
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Email %s to %s failed (attempt %d/%d): %s",
                email.id, email.recipient_email, attempt, settings.MAIL_MAX_ATTEMPTS, last_error,
            )
            if attempt < settings.MAIL_MAX_ATTEMPTS:
                await asyncio.sleep(2 ** attempt)
            continue

        email.status = EmailStatus.sent
        email.sent_at = server_now()
        email.error = None
        await db.commit()
        return

    email.status = EmailStatus.failed
    email.error = last_error[:2000]
    await db.commit()


async def dispatch_emails(email_ids: list[uuid.UUID]) -> None:
    """Send queued emails. Runs as a BackgroundTask, so it opens its own
    session — the request's session is already closed by the time this runs."""
    if not email_ids:
        return

    if not settings.mail_configured:
        logger.info("SMTP_HOST unset — %d email(s) logged but not delivered", len(email_ids))
        return

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(SentEmail).where(SentEmail.id.in_(email_ids)))
        for email in result.scalars().all():
            if email.status == EmailStatus.sent:
                continue
            await _deliver_one(db, email)
