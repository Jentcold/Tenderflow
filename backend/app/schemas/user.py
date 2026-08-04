import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.models.user import UserRole, UserStatus


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: EmailStr
    name: str
    role: UserRole
    status: UserStatus
    created_at: datetime


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    name: str
    password: str
    role: UserRole
    status: UserStatus = UserStatus.active

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


class UserUpdate(BaseModel):
    username: str | None = None
    email: EmailStr | None = None
    name: str | None = None
    password: str | None = None
    role: UserRole | None = None
    status: UserStatus | None = None
