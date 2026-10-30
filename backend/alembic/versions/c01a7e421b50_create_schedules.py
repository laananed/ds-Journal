"""Create independent schedules.

Revision ID: c01a7e421b50
Revises: 4f8e1a3c9d02
"""
from alembic import op
import sqlalchemy as sa

revision = 'c01a7e421b50'
down_revision = '4f8e1a3c9d02'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('schedules',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ends_at', sa.DateTime(timezone=True)),
        sa.Column('completed', sa.Boolean(), nullable=False),
        sa.Column('revision', sa.BigInteger(), nullable=False),
        sa.Column('client_create_id', sa.UUID(), nullable=False, unique=True),
        sa.Column('create_payload_hash', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint('ends_at IS NULL OR ends_at > starts_at', name='ck_schedule_time_order'))
    op.create_index('ix_schedules_starts_at_id', 'schedules', ['starts_at', 'id'])


def downgrade():
    op.execute("DO $$ BEGIN IF EXISTS (SELECT 1 FROM schedules) THEN RAISE EXCEPTION 'schedules exist; refusing downgrade'; END IF; END $$")
    op.drop_index('ix_schedules_starts_at_id', table_name='schedules')
    op.drop_table('schedules')
