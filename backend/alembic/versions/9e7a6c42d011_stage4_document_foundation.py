"""Add Stage 4 document and ritual foundations without converting old rows.

Revision ID: 9e7a6c42d011
Revises: 3aa16300a58a
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '9e7a6c42d011'
down_revision = '3aa16300a58a'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('journals', sa.Column('content_doc', postgresql.JSONB(none_as_null=True), nullable=True))
    op.add_column('insights', sa.Column('content_doc', postgresql.JSONB(none_as_null=True), nullable=True))
    op.add_column('journals', sa.Column('journal_kind', sa.Text(), nullable=False, server_default='writing'))
    op.create_check_constraint('ck_journals_kind', 'journals', "journal_kind IN ('writing', 'set', 'end')")
    op.create_index('uq_journals_active_ritual', 'journals', ['journal_date', 'journal_kind'], unique=True,
                    postgresql_where=sa.text("deleted_at IS NULL AND journal_kind IN ('set','end')"))
    op.create_table('ritual_templates',
        sa.Column('kind', sa.Text(), primary_key=True), sa.Column('questions', postgresql.JSONB(), nullable=False),
        sa.Column('revision', sa.BigInteger(), nullable=False, server_default='1'),
        sa.CheckConstraint("kind IN ('set','end')", name='ck_ritual_templates_kind'))
    op.create_table('ritual_goal_links',
        sa.Column('id', sa.UUID(), primary_key=True),
        sa.Column('set_journal_id', sa.Integer(), sa.ForeignKey('journals.id', ondelete='SET NULL')),
        sa.Column('end_journal_id', sa.Integer(), sa.ForeignKey('journals.id', ondelete='CASCADE'), nullable=False),
        sa.Column('goal_id', sa.UUID(), nullable=False), sa.Column('end_node_id', sa.UUID(), nullable=False),
        sa.UniqueConstraint('end_journal_id', 'goal_id', name='uq_ritual_link_end_goal'))
    op.create_table('ai_comments',
        sa.Column('id', sa.UUID(), primary_key=True),
        sa.Column('journal_id', sa.Integer(), sa.ForeignKey('journals.id', ondelete='CASCADE'), nullable=False),
        sa.Column('request_id', sa.UUID(), sa.ForeignKey('ai_requests.id', ondelete='SET NULL')),
        sa.Column('mind_preset_id', sa.Text(), nullable=False), sa.Column('text', sa.Text(), nullable=False),
        sa.Column('quote', sa.Text(), nullable=False), sa.Column('anchor', postgresql.JSONB(), nullable=False),
        sa.Column('anchor_state', sa.Text(), nullable=False), sa.Column('created_at', sa.DateTime(timezone=True), nullable=False))
    op.add_column('ai_requests', sa.Column('started_at', sa.DateTime(timezone=True)))
    op.add_column('ai_requests', sa.Column('auto_dedupe_key', sa.Text()))
    op.create_unique_constraint('ai_requests_auto_dedupe_key_key', 'ai_requests', ['auto_dedupe_key'])
    op.add_column('ai_settings', sa.Column('auto_go_deeper', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    op.add_column('ai_settings', sa.Column('auto_minds_comments', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    op.add_column('ai_settings', sa.Column('mind_preset_ids', postgresql.JSONB(), nullable=False, server_default=sa.text("'[\"gentle_reflection\"]'::jsonb")))


def downgrade():
    # Refuse to discard Stage 4 data, even if someone calls downgrade directly.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM journals WHERE content_doc IS NOT NULL OR journal_kind <> 'writing')
          OR EXISTS (SELECT 1 FROM insights WHERE content_doc IS NOT NULL)
          OR EXISTS (SELECT 1 FROM ritual_templates)
          OR EXISTS (SELECT 1 FROM ritual_goal_links)
          OR EXISTS (SELECT 1 FROM ai_comments)
          OR EXISTS (SELECT 1 FROM ai_requests WHERE started_at IS NOT NULL OR auto_dedupe_key IS NOT NULL)
          OR EXISTS (SELECT 1 FROM ai_settings WHERE auto_go_deeper OR auto_minds_comments OR mind_preset_ids <> '["gentle_reflection"]'::jsonb)
        THEN RAISE EXCEPTION 'stage4 data exists; refusing destructive downgrade'; END IF;
        END $$""")
    op.drop_column('ai_settings', 'mind_preset_ids')
    op.drop_column('ai_settings', 'auto_minds_comments')
    op.drop_column('ai_settings', 'auto_go_deeper')
    op.drop_constraint('ai_requests_auto_dedupe_key_key', 'ai_requests', type_='unique')
    op.drop_column('ai_requests', 'auto_dedupe_key')
    op.drop_column('ai_requests', 'started_at')
    op.drop_table('ai_comments')
    op.drop_table('ritual_goal_links')
    op.drop_table('ritual_templates')
    op.drop_index('uq_journals_active_ritual', table_name='journals')
    op.drop_constraint('ck_journals_kind', 'journals', type_='check')
    op.drop_column('journals', 'journal_kind')
    op.drop_column('insights', 'content_doc')
    op.drop_column('journals', 'content_doc')
