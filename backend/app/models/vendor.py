import uuid

from sqlalchemy import Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category


class Vendor(Base, UUIDPKMixin, TimestampMixin):
    """The company behind a `vendor`-role user.

    Exactly one per user: the User row is the login, this is who they are.
    Both are created together by POST /api/vendor/register, and /api/users
    refuses to mint a vendor account on its own, so a vendor user without a
    profile shouldn't exist.
    """

    __tablename__ = "vendors"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    company_name: Mapped[str] = mapped_column(String(255), index=True)

    # Where tender correspondence goes. Seeded from the account email at
    # registration but free to diverge — often a shared sales inbox rather
    # than the individual who signed up.
    contact_email: Mapped[str] = mapped_column(String(255))
    # Matches submissions.phone. The old String(20) silently truncated
    # anything with a country code and an extension.
    contact_phone: Mapped[str] = mapped_column(String(64))

    # The same enum tenders use — this is what vendor visibility keys off.
    vendor_category: Mapped[Category] = mapped_column(Enum(Category, name="category"), index=True)

    tax_id: Mapped[str] = mapped_column(String(255))
    address: Mapped[str] = mapped_column(String(255))
