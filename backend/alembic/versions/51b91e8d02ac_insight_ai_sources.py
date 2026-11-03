"""Allow Insight AI checkpoints and Minds comments.

Revision ID: 51b91e8d02ac
Revises: c01a7e421b50
"""
from alembic import op
import sqlalchemy as sa

revision = '51b91e8d02ac'
down_revision = 'c01a7e421b50'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('ck_ai_checkpoints_type', 'ai_checkpoints', type_='check')
    op.create_check_constraint('ck_ai_checkpoints_type', 'ai_checkpoints',
                               "file_type IN ('journal', 'inbox', 'insight')")
    op.add_column('ai_comments', sa.Column('insight_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_ai_comments_insight_id', 'ai_comments', 'insights',
                          ['insight_id'], ['id'], ondelete='CASCADE')
    op.alter_column('ai_comments', 'journal_id', existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint('ck_ai_comments_one_source', 'ai_comments',
        '(journal_id IS NOT NULL AND insight_id IS NULL) OR '
        '(journal_id IS NULL AND insight_id IS NOT NULL)')


def downgrade():
    # Refuse to silently discard Insight-owned AI data or protected nodes.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM ai_checkpoints WHERE file_type = 'insight')
          OR EXISTS (SELECT 1 FROM ai_comments WHERE insight_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM ai_requests WHERE sources @> '[{"type":"insight"}]'::jsonb)
          OR EXISTS (SELECT 1 FROM insights WHERE content_doc::text LIKE '%"aiReply"%'
            OR content_doc::text LIKE '%"aiPlaceholder"%'
            OR content_doc::text LIKE '%"mindComment"%')
        THEN RAISE EXCEPTION 'Insight AI data exists; refusing destructive downgrade'; END IF;
        END $$""")
    op.drop_constraint('ck_ai_comments_one_source', 'ai_comments', type_='check')
    op.alter_column('ai_comments', 'journal_id', existing_type=sa.Integer(), nullable=False)
    op.drop_constraint('fk_ai_comments_insight_id', 'ai_comments', type_='foreignkey')
    op.drop_column('ai_comments', 'insight_id')
    op.drop_constraint('ck_ai_checkpoints_type', 'ai_checkpoints', type_='check')
    op.create_check_constraint('ck_ai_checkpoints_type', 'ai_checkpoints',
                               "file_type IN ('journal', 'inbox')")
