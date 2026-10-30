from uuid import uuid4
import pytest
from pydantic import ValidationError

from fastapi.testclient import TestClient

from fastapi import FastAPI
from app.schedule.schemas import ScheduleCreate
from app.schedule.router import router


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
