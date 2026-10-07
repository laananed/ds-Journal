"""create inboxes and insights

Revision ID: a8d98342e603
Revises: 52c8e94a365c
Create Date: 2026-10-07 21:14:55.105426

Stage 2 / S2-T01 的 M2：autogenerate 起步，人工审阅后定稿。

内容与 `docs/stage2-architecture.md` 第 10 节一致：

1. `inboxes`：id；title Nullable Text；content Text Not Null；
   inbox_date Date Not Null；is_daily Boolean Not Null 默认 false；
   folder_id Nullable FK → folders.id；created_at / updated_at（带时区）；
   deleted_at Nullable（带时区）；
2. `insights`：id；title Nullable Text；content Text Not Null；
   folder_id Nullable FK → folders.id；created_at / updated_at；deleted_at。

两张表都引用 M1 建好的 `folders`，所以 M2 必须接在 M1 之后。

刻意**不做**的事：

- 不建 Daily 的唯一索引（属于 S2-T04 的 M3，等 P2 确认唯一性范围）；
- 不建 status / 完成 / 颜色 / 过期 / Journal 来源 / AI 等未来字段；
- 不加长度 / 空白 CHECK，不把 Text 改成 VARCHAR；
- 外键不 cascade、不 SET NULL（PostgreSQL 默认 NO ACTION）。

`title` 先保持 Nullable：Inbox 空标题的产品规则是 Pending P1。
`is_daily` 同时给出 Python 默认值与数据库 `server_default=false()`，两者一致。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a8d98342e603'
down_revision: Union[str, Sequence[str], None] = '52c8e94a365c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'inboxes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.Text(), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('inbox_date', sa.Date(), nullable=False),
        sa.Column(
            'is_daily',
            sa.Boolean(),
            server_default=sa.text('false'),
            nullable=False,
        ),
        sa.Column('folder_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['folder_id'], ['folders.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'insights',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.Text(), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('folder_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['folder_id'], ['folders.id']),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    # 新表没有历史数据，直接按引用关系逆序删除；
    # drop_table 会连同表上的外键与索引一起删除。
    op.drop_table('insights')
    op.drop_table('inboxes')
