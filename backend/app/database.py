"""Conexão com o banco (SQLAlchemy) e sessão por requisição."""
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    """Dependência do FastAPI: entrega uma sessão e fecha no fim da requisição."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
