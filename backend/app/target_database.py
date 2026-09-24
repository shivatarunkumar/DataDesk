"""Sessions against target Postgres databases that approved uploads load into."""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings


async def _get_db_session(db_name: str | None, default_db: AsyncSession | None):
    """Return the default session or a temporary one for db_name."""
    if not db_name:
        return default_db, None
    base_url = settings.target_database_url.rsplit("/", 1)[0]
    engine = create_async_engine(f"{base_url}/{db_name}")
    maker = async_sessionmaker(engine, expire_on_commit=False)
    session = maker()
    return session, engine
