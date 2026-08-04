"""Run once after migrations: `python seed.py`

Creates the fixed department list and exactly one bootstrap admin account
(from SEED_ADMIN_* in .env) so you have a way to log in on a fresh database.
Does NOT create any sample tenders/submissions/users beyond that admin.
Safe to re-run: skips anything that already exists.
"""

import asyncio

from sqlalchemy import select

from app.config import settings
from app.core.security import hash_password
from app.database import AsyncSessionLocal
from app.models.department import Department
from app.models.email import EmailTemplate, EmailType
from app.models.user import User, UserRole, UserStatus

DEPARTMENTS = [
    "IT Department",
    "Human Resources",
    "Operations",
    "Marketing",
    "Facilities Management",
    "Finance Department",
    "Legal & Compliance",
    "Administration",
]

DEFAULT_TEMPLATES = {
    EmailType.winner: {
        "subject": "Congratulations! You have been awarded the tender - {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "Congratulations! Your company, {vendor_company}, has been selected as the "
            "winning bidder for {tender_name} ({tender_serial}).\n\n"
            "Awarded Amount: {currency} {awarded_amount}\n"
            "Your Score: {combined_score}/10\n\n"
            "Our procurement team will contact you shortly regarding next steps.\n\n"
            "Best regards,\nTenderFlow Procurement Team"
        ),
    },
    EmailType.loser: {
        "subject": "Tender Award Notification - {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "Thank you for submitting your proposal for {tender_name} ({tender_serial}).\n\n"
            "After careful evaluation, we regret to inform you that your bid was not "
            "selected. The contract has been awarded to another vendor.\n\n"
            "Your Bid: {currency} {bid_amount}\nYour Score: {combined_score}/10\n\n"
            "We encourage you to participate in our future tenders.\n\n"
            "Best regards,\nTenderFlow Procurement Team"
        ),
    },
}


async def seed() -> None:
    async with AsyncSessionLocal() as db:
        for name in DEPARTMENTS:
            existing = await db.scalar(select(Department).where(Department.name == name))
            if not existing:
                db.add(Department(name=name))

        admin = await db.scalar(select(User).where(User.username == settings.SEED_ADMIN_USERNAME))
        if not admin:
            db.add(
                User(
                    username=settings.SEED_ADMIN_USERNAME,
                    email=settings.SEED_ADMIN_EMAIL,
                    name=settings.SEED_ADMIN_NAME,
                    password_hash=hash_password(settings.SEED_ADMIN_PASSWORD),
                    role=UserRole.admin,
                    status=UserStatus.active,
                )
            )
            print(f"Created bootstrap admin: {settings.SEED_ADMIN_USERNAME}")
        else:
            print("Bootstrap admin already exists, skipping")

        for email_type, content in DEFAULT_TEMPLATES.items():
            existing_template = await db.get(EmailTemplate, email_type)
            if not existing_template:
                db.add(EmailTemplate(type=email_type, subject=content["subject"], body=content["body"]))

        await db.commit()
        print("Seed complete.")


if __name__ == "__main__":
    asyncio.run(seed())
