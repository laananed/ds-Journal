"""SQLAlchemy 数据库基础配置。

Stage 1 / Task 3 第二步建立 Engine / Session 工厂 / Base；
Task 4.2 增加了请求级的 Session 依赖函数 `get_db`。

本模块只做五件事：

1. 显式定位并加载 `backend/.env`；
2. 从环境变量读取 `DATABASE_URL`；
3. 创建 Engine 与 Session 工厂；
4. 定义全项目共享的 Declarative Base；
5. 提供一个请求级的 Session 依赖函数。

不包含 Settings 类、独立配置层、Repository 或连接池调优。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import URL, create_engine, make_url
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

# 显式定位 backend/.env，不依赖当前工作目录
# （与 scripts/check_db.py 保持同一种做法）。
BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"

# override=False：进程内已存在的环境变量优先，不被打包在 .env 里的值覆盖。
load_dotenv(dotenv_path=ENV_FILE, override=False)


def build_database_url() -> URL:
    """读取 `DATABASE_URL`，并明确指定使用 psycopg 3 驱动。

    使用 SQLAlchemy 的 URL 工具解析后只改写 drivername，
    其余连接信息（用户名、密码、主机、端口、库名、查询参数）原样保留，
    因此不需要手工拼接字符串，也不会对密码做二次 URL 编码。
    """
    raw_url = os.environ.get("DATABASE_URL")
    if not raw_url:
        raise RuntimeError(f"未找到 DATABASE_URL，请检查配置文件：{ENV_FILE}")

    url = make_url(raw_url)

    # .env 中写的是 postgresql://，这里明确改成 postgresql+psycopg，
    # 表示使用已安装的 psycopg 3 驱动，而不是 psycopg2。
    if url.drivername in ("postgresql", "postgres"):
        url = url.set(drivername="postgresql+psycopg")

    if url.drivername != "postgresql+psycopg":
        raise RuntimeError(
            f"DATABASE_URL 使用了不受支持的驱动：{url.drivername}。"
            "Stage 1 只使用 postgresql+psycopg。"
        )

    return url


DATABASE_URL = build_database_url()

# 同步 Engine。使用 SQLAlchemy 默认连接池配置，当前不做调优。
engine: Engine = create_engine(DATABASE_URL)

# Session 工厂。每次请求从这里取一个独立的 Session。
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    """全项目共享的 Declarative Base。

    Journal Model 与 Alembic 的 env.py 引用的是同一个 Base，
    因此 `Base.metadata` 始终与实际 Model 一致。
    """


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：提供请求级的 Session 生命周期。

    每个请求取一个 Session，请求结束后关闭，把连接归还连接池。

    这里只负责「取」和「关」：

    - 提交与回滚由 Service 负责（成功 commit，失败 rollback）；
    - 不做自动重试、不做异常包装、不加嵌套事务。

    测试可以用 `app.dependency_overrides[get_db]` 换成测试 Session，
    不需要改动 Router 与 Service。
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
