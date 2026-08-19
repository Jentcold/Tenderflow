import asyncio

from sqlalchemy import select

from app.config import settings
from app.core.security import hash_password
from app.database import AsyncSessionLocal
from app.models.department import (
    PURCHASING_CODE,
    SUPPLY_CHAIN_CODE,
    WAREHOUSE_CODE,
    Department,
)
from app.models.category import DEFAULT_CATEGORIES, Category
from app.models.email import EmailTemplate, EmailType
from app.models.user import User, UserRole, UserStatus

DEPARTMENTS: list[tuple[str, str | None]] = [
    ("IT Department", None),
    ("Human Resources", None),
    ("Operations", None),
    ("Marketing", None),
    ("Facilities Management", None),
    ("Finance Department", None),
    ("Legal & Compliance", None),
    ("Administration", None),
    ("Purchasing", PURCHASING_CODE),
    ("Supply Chain", SUPPLY_CHAIN_CODE),
    ("Warehouse", WAREHOUSE_CODE),
]

DEFAULT_TEMPLATES = {
    EmailType.winner: {
        "subject": "Congratulations! You have been awarded the tender - {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "Congratulations! Your company, {vendor_company}, has been selected as the "
            "winning bidder for {tender_name} ({tender_serial}).\n\n"
            "Awarded Amount: {currency} {awarded_amount}\n\n"
            "Our purchasing team will contact you shortly regarding next steps.\n\n"
            "Best regards,\nTenderFlow Procurement Team"
        ),
    },
    EmailType.basket_award: {
        "subject": "You have been awarded part of {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "Your company, {vendor_company}, has been awarded the following items "
            "from {tender_name} ({tender_serial}):\n\n"
            "{awarded_lines}\n\n"
            "Total awarded to you: {currency} {awarded_line_total}\n\n"
            "Please note this tender was awarded across more than one supplier, so "
            "the items listed above are the full extent of your order. Our purchasing "
            "team will confirm delivery arrangements shortly.\n\n"
            "Best regards,\nTenderFlow Purchasing Team"
        ),
    },
    EmailType.loser: {
        "subject": "Tender Award Notification - {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "Thank you for submitting your proposal for {tender_name} ({tender_serial}).\n\n"
            "After careful review, we regret to inform you that your bid was not "
            "selected. The contract has been awarded to another vendor.\n\n"
            "Your Bid: {currency} {bid_amount}\n\n"
            "We encourage you to participate in our future tenders.\n\n"
            "Best regards,\nTenderFlow Purchasing Team"
        ),
    },
    EmailType.award_revoked: {
        "subject": "Award Withdrawn - {tender_serial}",
        "body": (
            "Dear {vendor_contact},\n\n"
            "We are writing regarding {tender_name} ({tender_serial}), which was "
            "previously awarded to {vendor_company}.\n\n"
            "That award has been withdrawn and the tender reassigned to another "
            "vendor. Our procurement team will be in touch about the reasons and "
            "any next steps.\n\n"
            "Your Bid: {currency} {bid_amount}\n\n"
            "We value your participation and encourage you to bid on future tenders.\n\n"
            "Best regards,\nTenderFlow Procurement Team"
        ),
    },
}


async def seed() -> None:
    async with AsyncSessionLocal() as db:
        for position, (slug, name) in enumerate(DEFAULT_CATEGORIES):
            existing_category = await db.scalar(select(Category).where(Category.slug == slug))
            if not existing_category:
                db.add(Category(name=name, slug=slug, position=position, active=True))

        for name, code in DEPARTMENTS:
            existing = await db.scalar(select(Department).where(Department.name == name))
            if not existing:
                db.add(Department(name=name, code=code))
            elif code and existing.code != code:
                existing.code = code

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
