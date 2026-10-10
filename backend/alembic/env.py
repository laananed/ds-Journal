from app.ai import models as _ai_models  # noqa: F401
"""Alembic 迁移环境。

连接配置不在 alembic.ini 里重复一份，
而是复用 `app/database.py` 的 Engine 与 Base：
真实 DATABASE_URL 只存在于本机 backend/.env。
"""

from logging.config import fileConfig

from alembic import context

from app.database import Base, engine

# 必须显式导入 Model 模块，让 Model 完成注册，
# 否则 Base.metadata 里不会有 journals 表，autogenerate 会认为“没有变化”。
#
# Stage 2 / S2-T01：新增的 Model 也要在这里注册。
# Journal / Inbox / Insight 的 folder_id 外键都指向 folders，
# metadata 里必须同时有 folders，外键才能解析。
from app.folder import models  # noqa: F401
from app.inbox import models  # noqa: F401
from app.insight import models  # noqa: F401
from app.journal import models  # noqa: F401

# Alembic Config 对象，对应正在使用的 alembic.ini。
config = context.config

# 按 ini 中的配置初始化日志。
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# autogenerate 的对比目标：与 Model 共用同一个 metadata。
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：只输出 SQL，不建立数据库连接。

    URL 同样取自共享 Engine，不来自 alembic.ini。
    """
    context.configure(
        url=engine.url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：直接复用 app/database.py 的 Engine。"""
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
