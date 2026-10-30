import os
import unittest
import subprocess
import sys
from pathlib import Path
os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://test:test@127.0.0.1/seekjournal_test')
from app.database import Base
from app.journal.models import Journal
from app.insight.models import Insight
from app.ritual import models


class Stage4MetadataTests(unittest.TestCase):
    def test_offline_migration_contains_safe_foundation(self):
        result = subprocess.run([sys.executable, '-B', '-m', 'alembic', 'upgrade', '3aa16300a58a:head', '--sql'],
                                cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ADD COLUMN content_doc JSONB', result.stdout)
        self.assertIn('uq_journals_active_ritual', result.stdout)
        self.assertIn('CREATE TABLE ai_comments', result.stdout)
    def test_body_columns_and_kind(self):
        self.assertIn('content_doc', Journal.__table__.c)
        self.assertIn('journal_kind', Journal.__table__.c)
        self.assertIn('content_doc', Insight.__table__.c)

    def test_foundation_tables_registered(self):
        for name in ('ritual_templates', 'ritual_goal_links', 'ai_comments'):
            self.assertIn(name, Base.metadata.tables)


if __name__ == '__main__':
    unittest.main()
