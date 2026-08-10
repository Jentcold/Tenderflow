import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.models.user import UserStatus
from app.models.category import Category


class VendorRegisterRequest(BaseModel):
    """Creates the login and the company profile in one call."""

    # --- account ---
    username: str
    email: EmailStr
    password: str
    name: str  # the person signing up, not the company

    # --- company ---
    company_name: str
    vendor_category: Category
    contact_phone: str
    tax_id: str
    address: str
    # Falls back to the account email when omitted.
    contact_email: EmailStr | None = None

    @field_validator("username")
    @classmethod
    def lowercase_username(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def min_password_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters")
        return v

    @field_validator("company_name", "name", "tax_id", "address", "contact_phone")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("This field is required")
        return v.strip()


class VendorUpdate(BaseModel):
    """Company details a vendor can change about themselves. The account
    (username/email/password) is edited through the user routes instead."""

    company_name: str | None = None
    vendor_category: Category | None = None
    contact_email: EmailStr | None = None
    contact_phone: str | None = None
    tax_id: str | None = None
    address: str | None = None


class VendorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    company_name: str
    vendor_category: Category
    contact_email: EmailStr
    contact_phone: str
    tax_id: str
    address: str
    created_at: datetime


class VendorWithAccountOut(VendorOut):
    """Profile plus the account it belongs to, for staff-facing lists.

    Flattened rather than nested so a table can bind straight to it; the
    `account_` prefix keeps it clear which fields describe the login and
    which describe the company.
    """

    account_username: str
    account_email: EmailStr
    account_name: str
    account_status: UserStatus
