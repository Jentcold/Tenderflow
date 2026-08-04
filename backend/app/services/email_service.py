from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.email import EmailTemplate, EmailType, SentEmail
from app.models.submission import Submission
from app.models.tender import Tender


def render_template(subject: str, body: str, replacements: dict[str, str]) -> tuple[str, str]:
    for key, value in replacements.items():
        subject = subject.replace(key, value)
        body = body.replace(key, value)
    return subject, body


async def get_templates(db: AsyncSession) -> dict[EmailType, EmailTemplate]:
    result = await db.execute(select(EmailTemplate))
    return {t.type: t for t in result.scalars().all()}


async def send_award_emails(
    db: AsyncSession,
    tender: Tender,
    submissions: list[Submission],
    combined_scores_by_submission: dict,
) -> list[SentEmail]:
    """Builds a SentEmail row per vendor (winner template for the awarded one, loser for the rest).
    This is a simulation layer: rows are persisted so the Email Log page has something to show.
    Wire in real SMTP/provider sending here later if needed.
    """
    templates = await get_templates(db)
    sent: list[SentEmail] = []

    for sub in submissions:
        is_winner = sub.id == tender.awarded_vendor_submission_id
        template = templates[EmailType.winner if is_winner else EmailType.loser]
        combined = combined_scores_by_submission.get(sub.id)

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
            "{combined_score}": f"{combined:.1f}" if combined is not None else "N/A",
        }
        subject, body = render_template(template.subject, template.body, replacements)

        record = SentEmail(
            tender_id=tender.id,
            tender_serial=tender.serial,
            tender_name=tender.name,
            submission_id=sub.id,
            vendor_company=sub.company_name,
            recipient_email=sub.email,
            type=EmailType.winner if is_winner else EmailType.loser,
            subject=subject,
            body=body,
        )
        db.add(record)
        sent.append(record)

    return sent
