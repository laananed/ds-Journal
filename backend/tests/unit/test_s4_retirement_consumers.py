import os
import unittest

os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://test:test@127.0.0.1/seekjournal_test')

from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from sqlalchemy.dialects import postgresql
from app.database import get_db
from app.link.service import _candidates
from app.main import app
from app.search.schemas import SearchType


class TransitionConsumerTests(unittest.TestCase):
    def test_existing_inbox_search_filter_remains_valid(self):
        self.assertEqual(TypeAdapter(SearchType).validate_python('inbox'), 'inbox')
        app.dependency_overrides[get_db] = lambda: None
        try:
            result = TestClient(app).get('/api/search?type=inbox')
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['items'], [])
        finally:
            app.dependency_overrides.clear()

    def test_link_candidates_keep_all_three_file_types(self):
        sql = str(_candidates().select().compile(dialect=postgresql.dialect()))
        for table in ('journals', 'inboxes', 'insights'):
            self.assertIn(table, sql)

    def test_inbox_and_related_routes_remain_registered(self):
        paths = app.openapi()['paths']
        for path in ('/api/inboxes', '/api/search', '/api/links/resolve',
                     '/api/folders', '/api/ai/requests/{request_id}'):
            self.assertIn(path, paths)


if __name__ == '__main__':
    unittest.main()
