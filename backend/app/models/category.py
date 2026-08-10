import enum


class Category(str, enum.Enum):
    """What a tender is for, and what a vendor supplies.

    Deliberately one enum shared by `tenders.category` and
    `vendors.vendor_category`. Vendors only see tenders in their own category,
    and that match is only sound if both sides draw from the same list — two
    lookalike enums would let someone add a category to tenders alone and
    silently leave no vendor able to match it.
    """

    goods = "goods"
    services = "services"
    works = "works"
    consulting = "consulting"
