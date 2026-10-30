import unittest
import os
from datetime import datetime, timezone
from unittest.mock import patch
from contextlib import nullcontext
from fastapi import FastAPI
from fastapi.testclient import TestClient
os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://test:test@127.0.0.1/seekjournal_test')
from app.ritual.router import router
from app.database import get_db


class BusinessDayApiTests(unittest.TestCase):
    def test_shanghai_four_am_boundary(self):
        app = FastAPI()
        app.include_router(router)
        with patch('app.ritual.router.utc_now', return_value=datetime(2026, 10, 29, 20, 0, tzinfo=timezone.utc)):
            response = TestClient(app).get('/api/business-day')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['business_date'], '2026-10-30')
        self.assertEqual(response.json()['timezone'], 'Asia/Shanghai')
        self.assertEqual(response.json()['day_start_hour'], 4)

    def test_missing_ritual_and_templates_are_read_only(self):
        class EmptyResult:
            def all(self): return []
        class ReadOnlyDB:
            no_autoflush = nullcontext()
            def execute(self, statement): return EmptyResult()
            def scalars(self, statement): return EmptyResult()
            def __getattr__(self, name):
                raise AssertionError(f'unexpected database operation: {name}')
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: ReadOnlyDB()
        client = TestClient(app)
        rituals = client.get('/api/rituals?journal_date=2026-10-30')
        self.assertEqual(rituals.json(), {'journal_date':'2026-10-30', 'set':None, 'end':None})
        templates = client.get('/api/ritual-templates')
        self.assertEqual(templates.json()['set'], {'questions': [], 'revision': 0})


if __name__ == '__main__':
    unittest.main()
