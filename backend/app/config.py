from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Metadata DB: users, grants, workspace files, upload requests
    datamanager_database_url: str
    # Any Postgres URL on the server hosting upload targets; the DB name is swapped per target
    target_database_url: str
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
