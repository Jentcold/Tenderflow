"""vendors become directory records, not logins; per-tender invite links

Vendors stop having accounts. Purchasing creates the record, and the vendor
reaches a tender through a link addressed to them — `tender_vendor_invites`,
one row per (tender, vendor), carrying its own token.

What changes on `vendors`:

* `user_id` becomes nullable and `SET NULL` on delete. Rows created before this
  keep theirs; nothing new sets one, and `auth.login` refuses the vendor role
  outright regardless.
* `code` — the short identifier that travels in the link. Backfilled with a
  random value per existing row, because it has to be unique and unguessable.
* `contact_email`, `contact_phone`, `tax_id`, `address` become nullable. A
  vendor with no email on file is the case the invite list has to be able to
  flag; refusing to record them just keeps them out of the system.
* `notes`, `active`, `created_by`.

`sent_emails.submission_id` becomes nullable and `emailtype` gains `rfq`: the
invitation goes out before there is a bid to attach it to.

Revision ID: d8b3f60c1a94
Revises: c7a9e14b2d85
Create Date: 2026-08-17

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd8b3f60c1a94'
down_revision: Union[str, None] = 'c7a9e14b2d85'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- emails: the RFQ has no submission behind it ---
    op.execute("ALTER TYPE emailtype ADD VALUE IF NOT EXISTS 'rfq'")
    op.alter_column("sent_emails", "submission_id", existing_type=sa.Uuid(), nullable=True)

    # --- vendors ---
    op.alter_column("vendors", "user_id", existing_type=sa.Uuid(), nullable=True)
    for column in ("contact_email", "contact_phone", "tax_id", "address"):
        op.alter_column("vendors", column, existing_type=sa.String(), nullable=True)

    op.add_column("vendors", sa.Column("code", sa.String(length=32), nullable=True))
    op.add_column("vendors", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column(
        "vendors", sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true())
    )
    op.add_column("vendors", sa.Column("created_by", sa.Uuid(), nullable=True))
    op.create_foreign_key("fk_vendors_created_by", "vendors", "users", ["created_by"], ["id"])

    # Random per row: the code travels in the link, so a sequence would let one
    # vendor walk it to the next company. gen_random_uuid() is available on
    # Postgres 13+ without an extension.
    op.execute(
        "UPDATE vendors SET code = 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)) "
        "WHERE code IS NULL"
    )
    op.alter_column("vendors", "code", existing_type=sa.String(length=32), nullable=False)
    op.create_index(op.f("ix_vendors_code"), "vendors", ["code"], unique=True)
    op.create_index(op.f("ix_vendors_active"), "vendors", ["active"], unique=False)

    # The old FK cascaded a vendor away with its user account. Now that the
    # account is the vestigial half, deleting it must not take the company.
    # Named explicitly by c68bd5372288, so the name is reused rather than
    # guessed at — Postgres' default `vendors_user_id_fkey` was never created.
    op.drop_constraint("fk_vendors_user_id", "vendors", type_="foreignkey")
    op.create_foreign_key(
        "fk_vendors_user_id", "vendors", "users", ["user_id"], ["id"], ondelete="SET NULL"
    )

    # --- the invite list ---
    op.create_table(
        "tender_vendor_invites",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        sa.Column("vendor_id", sa.Uuid(), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("invited_by", sa.Uuid(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("needs_other_channel", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invited_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tender_vendor_invites_tender_id"), "tender_vendor_invites", ["tender_id"])
    op.create_index(op.f("ix_tender_vendor_invites_vendor_id"), "tender_vendor_invites", ["vendor_id"])
    op.create_index(op.f("ix_tender_vendor_invites_token"), "tender_vendor_invites", ["token"], unique=True)
    op.create_index(op.f("ix_tender_vendor_invites_revoked"), "tender_vendor_invites", ["revoked"])


def downgrade() -> None:
    op.drop_table("tender_vendor_invites")

    op.drop_constraint("fk_vendors_user_id", "vendors", type_="foreignkey")
    op.create_foreign_key(
        "fk_vendors_user_id", "vendors", "users", ["user_id"], ["id"], ondelete="CASCADE"
    )
    op.drop_index(op.f("ix_vendors_active"), table_name="vendors")
    op.drop_index(op.f("ix_vendors_code"), table_name="vendors")
    op.drop_constraint("fk_vendors_created_by", "vendors", type_="foreignkey")
    op.drop_column("vendors", "created_by")
    op.drop_column("vendors", "active")
    op.drop_column("vendors", "notes")
    op.drop_column("vendors", "code")

    # Rows without an account or the old required detail can't go back, so they
    # are removed rather than left to fail the NOT NULLs below.
    op.execute(
        "DELETE FROM vendors WHERE user_id IS NULL OR contact_email IS NULL "
        "OR contact_phone IS NULL OR tax_id IS NULL OR address IS NULL"
    )
    for column in ("contact_email", "contact_phone", "tax_id", "address"):
        op.alter_column("vendors", column, existing_type=sa.String(), nullable=False)
    op.alter_column("vendors", "user_id", existing_type=sa.Uuid(), nullable=False)

    op.execute("DELETE FROM sent_emails WHERE submission_id IS NULL")
    op.alter_column("sent_emails", "submission_id", existing_type=sa.Uuid(), nullable=False)
