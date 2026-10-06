"""API 测试连接必须与开发数据库分离；本文件不建立连接。"""

from app.database import engine


def test_api_engine_targets_dedicated_test_database():
    assert engine.url.database == "seekjournal_test"
