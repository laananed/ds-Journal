"""stage3_writing_ai

Revision ID: 3aa16300a58a
Revises: 18ecf7e09da6
Create Date: 2026-10-10 17:12:36.034611

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '3aa16300a58a'
down_revision: Union[str, Sequence[str], None] = '18ecf7e09da6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('ai_checkpoints',
    sa.Column('file_type', sa.Text(), nullable=False),
    sa.Column('file_id', sa.Integer(), nullable=False),
    sa.Column('consumed_user_text', sa.Text(), nullable=False),
    sa.Column('last_request_id', sa.UUID(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("file_type IN ('journal', 'inbox')", name='ck_ai_checkpoints_type'),
    sa.PrimaryKeyConstraint('file_type', 'file_id')
    )
    op.create_table('ai_requests',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.Text(), nullable=False),
    sa.Column('payload_hash', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('sources', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('question', sa.Text(), nullable=True),
    sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('saved_target', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('save_payload_hash', sa.Text(), nullable=True),
    sa.Column('error_category', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('ai_settings',
    sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('custom_prompt', sa.Text(), server_default=sa.text("''"), nullable=False),
    sa.Column('web_enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('revision', sa.BigInteger(), server_default=sa.text('1'), nullable=False),
    sa.CheckConstraint('id = 1', name='ck_ai_settings_singleton'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('ai_usage',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('request_id', sa.UUID(), nullable=True),
    sa.Column('subcall_index', sa.Integer(), nullable=False),
    sa.Column('response_id', sa.Text(), nullable=True),
    sa.Column('prompt_tokens', sa.BigInteger(), nullable=True),
    sa.Column('completion_tokens', sa.BigInteger(), nullable=True),
    sa.Column('total_tokens', sa.BigInteger(), nullable=True),
    sa.Column('metering', sa.Text(), nullable=False),
    sa.Column('search_requests', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['request_id'], ['ai_requests.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('request_id', 'subcall_index', name='uq_ai_usage_request_subcall')
    )
    op.add_column('inboxes', sa.Column('revision', sa.BigInteger(), server_default='1', nullable=False))
    op.add_column('inboxes', sa.Column('client_create_id', sa.UUID(), nullable=True))
    op.add_column('inboxes', sa.Column('create_payload_hash', sa.Text(), nullable=True))
    op.add_column('inboxes', sa.Column('content_blocks', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True))
    op.create_unique_constraint('inboxes_client_create_id_key', 'inboxes', ['client_create_id'])
    op.add_column('insights', sa.Column('revision', sa.BigInteger(), server_default='1', nullable=False))
    op.add_column('insights', sa.Column('client_create_id', sa.UUID(), nullable=True))
    op.add_column('insights', sa.Column('create_payload_hash', sa.Text(), nullable=True))
    op.create_unique_constraint('insights_client_create_id_key', 'insights', ['client_create_id'])
    op.add_column('journals', sa.Column('revision', sa.BigInteger(), server_default='1', nullable=False))
    op.add_column('journals', sa.Column('client_create_id', sa.UUID(), nullable=True))
    op.add_column('journals', sa.Column('create_payload_hash', sa.Text(), nullable=True))
    op.add_column('journals', sa.Column('content_blocks', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True))
    op.create_unique_constraint('journals_client_create_id_key', 'journals', ['client_create_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('journals_client_create_id_key', 'journals', type_='unique')
    op.drop_column('journals', 'content_blocks')
    op.drop_column('journals', 'create_payload_hash')
    op.drop_column('journals', 'client_create_id')
    op.drop_column('journals', 'revision')
    op.drop_constraint('insights_client_create_id_key', 'insights', type_='unique')
    op.drop_column('insights', 'create_payload_hash')
    op.drop_column('insights', 'client_create_id')
    op.drop_column('insights', 'revision')
    op.drop_constraint('inboxes_client_create_id_key', 'inboxes', type_='unique')
    op.drop_column('inboxes', 'content_blocks')
    op.drop_column('inboxes', 'create_payload_hash')
    op.drop_column('inboxes', 'client_create_id')
    op.drop_column('inboxes', 'revision')
    op.drop_table('ai_usage')
    op.drop_table('ai_settings')
    op.drop_table('ai_requests')
    op.drop_table('ai_checkpoints')
