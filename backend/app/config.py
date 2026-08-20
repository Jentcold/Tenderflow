from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str
    DATABASE_URL_SYNC: str = ""

    JWT_SECRET: str
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 720

    CORS_ORIGINS: str = "*"
    FRONTEND_BASE_URL: str = ""

    SERVER_TIMEZONE: str = ""

    DEFAULT_CURRENCY: str = "EGP"

    SEED_ADMIN_USERNAME: str = "admin"
    SEED_ADMIN_EMAIL: str = "admin@tenderflow.com"
    SEED_ADMIN_PASSWORD: str = "change-me"
    SEED_ADMIN_NAME: str = "System Administrator"

    RATE_LIMIT_ENABLED: bool = True
    TRUST_PROXY_HEADERS: bool = False

    LOGIN_RATE_LIMIT_TIMES: int = 10
    LOGIN_RATE_LIMIT_SECONDS: int = 60
    LOGIN_MAX_FAILURES: int = 5
    LOGIN_LOCKOUT_SECONDS: int = 900

    VENDOR_READ_RATE_LIMIT_TIMES: int = 60
    VENDOR_READ_RATE_LIMIT_SECONDS: int = 60
    VENDOR_SUBMIT_RATE_LIMIT_TIMES: int = 5
    VENDOR_SUBMIT_RATE_LIMIT_SECONDS: int = 3600

    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_START_TLS: bool = True
    SMTP_USE_SSL: bool = False
    SMTP_TIMEOUT_SECONDS: int = 30

    MAIL_FROM: str = "noreply@tenderflow.com"
    MAIL_FROM_NAME: str = "TenderFlow"
    MAIL_MAX_ATTEMPTS: int = 3

    MAIL_REDIRECT_TO: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def mail_configured(self) -> bool:
        return bool(self.SMTP_HOST.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
