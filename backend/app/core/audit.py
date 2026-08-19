from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


async def log_audit(db: AsyncSession, action: str, details: str, user_name: str = "System") -> None:
    db.add(AuditLog(action=action, details=details, user_name=user_name))
