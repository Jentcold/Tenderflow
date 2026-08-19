"""Development test accounts: `python dev_accounts.py`

Run AFTER `alembic upgrade head` and `python seed.py`. Creates one account per
desk in the flow so the whole chain can be walked by hand, and attaches each to
the department that gives them their authority.

**Development only.** Every account here shares one obvious password, which is
the point: it is for a local database you can throw away. Nothing in this file
should ever run against anything reachable from outside the machine.

Safe to re-run: skips accounts that already exist, and fills in a department
that is missing without touching anything else.
"""

import asyncio

from sqlalchemy import select

from app.core.security import hash_password
from app.database import AsyncSessionLocal
from app.models.department import Department
from app.models.user import User, UserRole, UserStatus
from app.models.vendor import Vendor
from app.models.category import Category

DEV_PASSWORD = "pass1234"
# Not `.local`, however tempting: pydantic's EmailStr rejects reserved TLDs, so
# an account created with one logs in fine and then 500s serialising the user
# out of the token response.
EMAIL_DOMAIN = "tenderflow.com"

# username, name, role, department name (None = attached to no department)
#
# The two managers are the point of the list. Seniority is not a role here: the
# purchasing manager is `role=manager` whose department is Purchasing, and the
# department manager is the same role pointed at their own department. Adding a
# second manager of either is adding a row to this list.
ACCOUNTS: list[tuple[str, str, UserRole, str | None]] = [
    ("mgr1",  "Dana Aziz (IT Manager)",         UserRole.manager,      "IT Department"),
    ("pmgr1", "Rami Habib (Purchasing Mgr)",    UserRole.manager,      "Purchasing"),
    ("proc1", "Nour Selim (Purchasing)",        UserRole.procurement,  "Purchasing"),
    ("sc1",   "Karim Fouad (Supply Chain)",     UserRole.supply_chain, "Supply Chain"),
    ("fin1",  "Hala Mostafa (Finance)",         UserRole.finance,      "Finance Department"),
    ("emp1",  "Omar Tarek (IT staff)",          UserRole.employee,     "IT Department"),
    # No warehouse role, by design — whoever works there is a user attached to
    # the Warehouse department. The receiving endpoints will gate on that.
    ("wh1",   "Sara Nabil (Warehouse)",         UserRole.employee,     "Warehouse"),
]

# Departments whose manager pointer should be set, so both routes to "who
# manages this" agree: users.department_id (the general rule) and
# departments.manager (the single designated head).
DEPARTMENT_HEADS = {"IT Department": "mgr1", "Purchasing": "pmgr1", "Supply Chain": "sc1"}

# Vendors have no accounts. These are directory records: purchasing invites
# them to a tender and they arrive by an addressed link. The last one has no
# email on file on purpose — that is the case the invite list has to flag for
# somebody to phone.
# Category slugs, and a list each - a vendor supplies more than one thing, and
# the demo data should show that rather than pretending otherwise.
VENDORS = [
    ("Acme Supplies",       "sales@acme.example",    "+20 100 000 0001", ["goods"]),
    ("BuildCo Contracting", "bids@buildco.example",  "+20 100 000 0002", ["works", "services"]),
    ("Techno Distribution", "quotes@techno.example", "+20 100 000 0003", ["goods", "services"]),
    ("Nile Office Supply",  None,                    "+20 100 000 0004", ["goods"]),
]


async def main() -> None:
    async with AsyncSessionLocal() as db:
        departments = {
            d.name: d for d in (await db.execute(select(Department))).scalars().all()
        }
        if not departments:
            print("No departments found — run `python seed.py` first.")
            return

        created, updated = [], []

        for username, name, role, dept_name in ACCOUNTS:
            department = departments.get(dept_name) if dept_name else None
            if dept_name and department is None:
                print(f"  ! {dept_name} does not exist, {username} left unattached")

            user = await db.scalar(select(User).where(User.username == username))
            if user is None:
                db.add(
                    User(
                        username=username,
                        email=f"{username}@{EMAIL_DOMAIN}",
                        name=name,
                        password_hash=hash_password(DEV_PASSWORD),
                        role=role,
                        status=UserStatus.active,
                        department_id=department.id if department else None,
                    )
                )
                created.append(f"{username} ({role.value}{', ' + dept_name if dept_name else ''})")
            elif department is not None and user.department_id != department.id:
                user.department_id = department.id
                updated.append(f"{username} -> {dept_name}")

        await db.flush()

        categories = {
            c.slug: c for c in (await db.execute(select(Category))).scalars().all()
        }
        if not categories:
            print("  ! no categories exist — run `python seed.py` first")

        for company, email, phone, slugs in VENDORS:
            existing_vendor = await db.scalar(
                select(Vendor).where(Vendor.company_name == company)
            )
            if existing_vendor is None:
                vendor = Vendor(
                    company_name=company,
                    contact_email=email,
                    contact_phone=phone,
                    categories=[categories[s] for s in slugs if s in categories],
                    tax_id=f"TAX-{company.split()[0].upper()}",
                    address="Cairo, Egypt",
                )
                db.add(vendor)
                await db.flush()  # assigns the code default
                created.append(
                    f"{company} [{vendor.code}]"
                    + ("" if email else " — no email, needs another channel")
                )

        await db.flush()

        for dept_name, username in DEPARTMENT_HEADS.items():
            department = departments.get(dept_name)
            head = await db.scalar(select(User).where(User.username == username))
            if department is not None and head is not None and department.manager != head.id:
                department.manager = head.id
                updated.append(f"{dept_name} head -> {username}")

        await db.commit()

    for line in created:
        print(f"  created {line}")
    for line in updated:
        print(f"  updated {line}")
    if not created and not updated:
        print("  nothing to do — accounts already in place")
    print(f"\nAll staff accounts use the password: {DEV_PASSWORD}")
    print("The admin account comes from seed.py and SEED_ADMIN_* in .env.")
    print("Vendors have NO accounts — invite one to a tender and use the link it gives you.")


if __name__ == "__main__":
    asyncio.run(main())
