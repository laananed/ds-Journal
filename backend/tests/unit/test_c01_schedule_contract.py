from uuid import uuid4
import pytest
from pydantic import ValidationError

from fastapi.testclient import TestClient

from fastapi import FastAPI
from app.schedule.schemas import ScheduleCreate
from app.schedule.router import router
from app.schedule.models import Schedule


def test_schedule_model_declares_migration_index_in_list_order():
    """模型必须声明迁移 c01a7e421b50 建的同名索引，列顺序与服务列表查询一致。

    列表分页按 (starts_at, id) 排序，索引名称与列顺序都不能变；
    只依赖 Model 元数据，不连接数据库。
    """
    table = Schedule.__table__
    assert {index.name: [column.name for column in index.columns] for index in table.indexes} == {
        'ix_schedules_starts_at_id': ['starts_at', 'id']}
    assert [index.unique for index in table.indexes if index.name == 'ix_schedules_starts_at_id'] == [False]


def test_schedule_create_requires_timezone_and_valid_fields():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    body = {'title': '合成日程', 'starts_at': '2026-10-30T09:00:00',
            'ends_at': None, 'completed': False, 'client_create_id': str(uuid4())}
    response = client.post('/api/schedules', json=body)
    assert response.status_code == 422


def test_schedule_rejects_numeric_timestamp():
    body = {'title': 'Synthetic', 'starts_at': 1793322000,
            'ends_at': None, 'completed': False, 'client_create_id': str(uuid4())}
    with pytest.raises(ValidationError):
        ScheduleCreate.model_validate(body)
