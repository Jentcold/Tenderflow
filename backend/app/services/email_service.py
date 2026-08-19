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
    extra: dict[str, str] | None = None,
) -> SentEmail:
    replacements = {
        "{vendor_company}": sub.company_name,
        "{vendor_contact}": sub.contact_name,
        "{vendor_email}": sub.email,
        "{tender_name}": tender.name,
        "{tender_serial}": tender.serial,
        "{tender_category}": tender.category_name or tender.category,
        "{currency}": tender.currency,
        "{awarded_amount}": f"{tender.awarded_amount:,.2f}" if tender.awarded_amount else "0",
        "{bid_amount}": f"{sub.total_amount:,.2f}",
        "{combined_score}": "",
        "{awarded_lines}": extra.get("awarded_lines", "") if extra else "",
        "{awarded_line_total}": extra.get("awarded_line_total", "") if extra else "",
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
) -> list[SentEmail]:
    templates = await get_templates(db)
    return [
        _queue_email(
            db,
            templates[EmailType.winner if sub.id == tender.awarded_vendor_submission_id else EmailType.loser],
            tender,
            sub,
            EmailType.winner if sub.id == tender.awarded_vendor_submission_id else EmailType.loser,
        )
        for sub in submissions
    ]


async def send_basket_emails(
    db: AsyncSession,
    tender: Tender,
    submissions: list[Submission],
    won_by_submission: dict[uuid.UUID, list],
) -> list[SentEmail]:
    templates = await get_templates(db)
    out: list[SentEmail] = []

    for sub in submissions:
        lines = won_by_submission.get(sub.id) or []
        if not lines:
            out.append(_queue_email(db, templates[EmailType.loser], tender, sub, EmailType.loser))
            continue

        total = sum(float(line.quantity) * float(line.unit_price) for line in lines)
        rendered = "\n".join(
            f"- {line.name}: {float(line.quantity):g} {line.unit} "
            f"@ {tender.currency} {float(line.unit_price):,.2f} "
            f"= {tender.currency} {float(line.quantity) * float(line.unit_price):,.2f}"
            for line in lines
        )
        template = templates.get(EmailType.basket_award) or templates[EmailType.winner]
        out.append(
            _queue_email(
                db,
                template,
                tender,
                sub,
                EmailType.basket_award,
                extra={
                    "awarded_lines": rendered,
                    "awarded_line_total": f"{total:,.2f}",
                },
            )
        )
    return out


async def send_reassignment_emails(
    db: AsyncSession,
    tender: Tender,
    previous: Submission,
    replacement: Submission,
) -> list[SentEmail]:
    templates = await get_templates(db)
    return [
        _queue_email(
            db, templates[EmailType.award_revoked], tender, previous, EmailType.award_revoked
        ),
        _queue_email(db, templates[EmailType.winner], tender, replacement, EmailType.winner),
    ]


async def _deliver_one(db: AsyncSession, email: SentEmail) -> None:
    last_error = "Unknown error"

    for attempt in range(1, settings.MAIL_MAX_ATTEMPTS + 1):
        email.attempts += 1
        try:
            await send_message(email.recipient_email, email.subject, email.body)
        except Exception as exc:  # noqa: BLE001
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
