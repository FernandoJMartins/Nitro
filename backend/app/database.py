"""Conexão com o banco (SQLAlchemy) e sessão por requisição."""
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

# SQLite (testes/dev): o scheduler roda publicações por conta em threads próprias,
# então a conexão precisa permitir múltiplas threads e aguardar lock (WAL + busy_timeout)
# em vez de estourar "database is locked". Postgres em produção não é afetado.
_is_sqlite = settings.database_url.startswith("sqlite")
_connect_args = {"check_same_thread": False, "timeout": 30} if _is_sqlite else {}

engine = create_engine(settings.database_url, pool_pre_ping=True, connect_args=_connect_args)

if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _connection_record) -> None:  # pragma: no cover
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


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
