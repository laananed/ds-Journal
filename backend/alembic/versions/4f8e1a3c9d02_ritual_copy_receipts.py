"""Persist Ritual copy idempotency receipts.

Revision ID: 4f8e1a3c9d02
Revises: 9e7a6c42d011
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '4f8e1a3c9d02'
down_revision = '9e7a6c42d011'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('ritual_copies',
        sa.Column('id', sa.UUID(), primary_key=True),
        sa.Column('source_id', sa.Integer(), nullable=False),
        sa.Column('target_id', sa.Integer(), nullable=False),
        sa.Column('payload_hash', sa.Text(), nullable=False),
        sa.Column('copied_nodes', postgresql.JSONB(), nullable=False))


def downgrade():
    op.execute("DO $$ BEGIN IF EXISTS (SELECT 1 FROM ritual_copies) THEN RAISE EXCEPTION 'copy receipts exist; refusing downgrade'; END IF; END $$")
    op.drop_table('ritual_copies')
