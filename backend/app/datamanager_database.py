from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from app.config import settings

_engine = None
_SessionLocal = None


def _get_engine():
    global _engine, _SessionLocal
    if _engine is None:
        _engine = create_async_engine(settings.datamanager_database_url)
        _SessionLocal = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine, _SessionLocal


async def get_dm_db() -> AsyncSession:
    _, SessionLocal = _get_engine()
    async with SessionLocal() as session:
        yield session
