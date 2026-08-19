"""Point vendor contact emails somewhere for a demo: `python vendor_email.py`

    python vendor_email.py you@example.com          # all vendors
    python vendor_email.py you@example.com "Acme"   # just the ones matching
    python vendor_email.py --clear "Nile"           # back to no email on file

Development only. Real RFQs go to whatever is in here, so pointing every vendor
at one inbox means three invites arrive as three near-identical mails that are
only tellable apart by the greeting and the link.

`--clear` exists because a vendor with no address is a case worth being able to
reproduce: it is the one the invite list has to flag for somebody to phone,
rather than skipping in silence.
"""
import asyncio
import sys

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.vendor import Vendor, TenderVendorInvite


async def main(email: str | None, needle: str | None) -> None:
    async with AsyncSessionLocal() as db:
        q = select(Vendor).order_by(Vendor.company_name)
        if needle:
            q = q.where(Vendor.company_name.ilike(f"%{needle}%"))
        vendors = (await db.execute(q)).scalars().all()
        if not vendors:
            print(f"No vendor matches {needle!r}")
            return

        for v in vendors:
            before = v.contact_email or "(none)"
            v.contact_email = email
            print(f"  {v.company_name:24} {before:34} -> {email or '(none)'}")

            # An invite raised while they had no address still carries "hand
            # this over another way". Giving them one makes that flag a lie.
            if email:
                invites = (await db.execute(
                    select(TenderVendorInvite).where(
                        TenderVendorInvite.vendor_id == v.id,
                        TenderVendorInvite.needs_other_channel.is_(True),
                    )
                )).scalars().all()
                for inv in invites:
                    inv.needs_other_channel = False
                if invites:
                    print(f"      cleared {len(invites)} stale 'needs another channel' flag(s)")

        await db.commit()
        print(f"\n{len(vendors)} vendor(s) updated")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        raise SystemExit(1)
    if args[0] == "--clear":
        asyncio.run(main(None, args[1] if len(args) > 1 else None))
    else:
        asyncio.run(main(args[0], args[1] if len(args) > 1 else None))
