"""Task 3 第一步：验证 Python 能否连接本地开发数据库。

本脚本只读，不创建也不修改任何 Schema。

用法（在 backend/ 目录下执行）：

    .\\.venv\\Scripts\\python.exe scripts/check_db.py

它会：

1. 显式定位 backend/.env 并加载；
2. 用 DATABASE_URL 通过 psycopg 连接；
3. 执行 SELECT current_database(), 1；
4. 查询用户表，确认还没有业务表。

脚本不打印密码，也不打印完整连接串。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# 显式定位 backend/.env，不依赖当前工作目录。
BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"

EXPECTED_DATABASE = "seekjournal"

# 有限连接超时，避免连不上时长时间挂起。
CONNECT_TIMEOUT_SECONDS = 5


def redact(message: str) -> str:
    """把可能出现在错误信息里的密码替换掉。"""
    secrets = [
        os.environ.get("POSTGRES_PASSWORD"),
        os.environ.get("DATABASE_URL"),
    ]
    for secret in secrets:
        if secret:
            message = message.replace(secret, "***")
    return message


def main() -> int:
    # override=False：已存在的环境变量优先，不被 .env 覆盖。
    load_dotenv(dotenv_path=ENV_FILE, override=False)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("FAIL  未找到 DATABASE_URL")
        print(f"      已尝试读取配置：{ENV_FILE}")
        return 1

    try:
        with psycopg.connect(
            database_url, connect_timeout=CONNECT_TIMEOUT_SECONDS
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT current_database(), 1")
                row = cur.fetchone()

                if row is None:
                    print("FAIL  SELECT current_database(), 1 没有返回结果")
                    return 1

                current_database, literal_one = row

                cur.execute(
                    """
                    SELECT table_schema, table_name
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name
                    """
                )
                user_tables = cur.fetchall()
    except psycopg.Error as exc:
        print(f"FAIL  连接或查询失败（{type(exc).__name__}）")
        print(f"      {redact(str(exc))}")
        return 1

    print("连接成功")
    print(f"  current_database() = {current_database}")
    print(f"  常量 1             = {literal_one}")
    print(f"  用户表数量         = {len(user_tables)}")

    for table_schema, table_name in user_tables:
        print(f"    - {table_schema}.{table_name}")

    failed = False

    if current_database != EXPECTED_DATABASE:
        print(f"FAIL  current_database() 期望 {EXPECTED_DATABASE}")
        failed = True

    if literal_one != 1:
        print("FAIL  常量 1 的取值不是 1")
        failed = True

    if user_tables:
        print("FAIL  期望当前还没有业务表")
        failed = True

    if failed:
        return 1

    print("PASS  数据库连接可用，且尚未创建业务表")
    return 0


if __name__ == "__main__":
    sys.exit(main())
