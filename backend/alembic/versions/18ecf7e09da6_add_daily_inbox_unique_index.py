"""Add the one-Daily-per-business-date partial unique index.

Revision ID: 18ecf7e09da6
Revises: a8d98342e603
"""
from alembic import op
import sqlalchemy as sa

revision = '18ecf7e09da6'
down_revision = 'a8d98342e603'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index('uq_inboxes_daily_date', 'inboxes', ['inbox_date'],
                    unique=True, postgresql_where=sa.text('is_daily = true'))


def downgrade() -> None:
    op.drop_index('uq_inboxes_daily_date', table_name='inboxes')
