"""create folders and add journals folder_id / deleted_at

Revision ID: 52c8e94a365c
Revises: 3a70890ddb10
Create Date: 2026-10-07 21:13:47.581484

Stage 2 / S2-T01 的 M1：autogenerate 起步，人工审阅后定稿。

内容与 `docs/stage2-architecture.md` 第 10 节一致（顺序不能反）：

1. 先创建被引用的 `folders`；
2. 再给 `journals` 增加两个**可空**列：
   - `folder_id`：可空外键 → `folders.id`；
   - `deleted_at`：可空的带时区时间。

刻意**不做**的事：

- 不改动 `journals` 原有六字段、主键、sequence 与 `journal_date` 索引；
- 不重建表、不搬数据、不清洗旧内容（旧记录升级后两列都是 NULL）；
- 不把 Text 改成 VARCHAR，不加长度 / 空白 CHECK；
- 外键不 cascade、不 SET NULL，保持 PostgreSQL 默认的 NO ACTION。

`deleted_at` 只是列占位：本任务没有软删除行为，API 仍是 Stage 1.5 的硬删除。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '52c8e94a365c'
down_revision: Union[str, Sequence[str], None] = '3a70890ddb10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'folders',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('journals', sa.Column('folder_id', sa.Integer(), nullable=True))
    op.add_column(
        'journals',
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    # 显式写出外键名：与 PostgreSQL 的默认命名一致（journals_folder_id_fkey），
    # 这样 downgrade 里有确定的名字可以 drop。
    # 外键名不参与 `alembic check` 的比较，所以它与 Model 里未命名的 ForeignKey 等价。
    op.create_foreign_key(
        'journals_folder_id_fkey',
        'journals',
        'folders',
        ['folder_id'],
        ['id'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('journals_folder_id_fkey', 'journals', type_='foreignkey')
    op.drop_column('journals', 'deleted_at')
    op.drop_column('journals', 'folder_id')
    op.drop_table('folders')
