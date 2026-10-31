from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Index, Integer, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Schedule(Base):
    __tablename__ = 'schedules'
    __table_args__ = (
        CheckConstraint('ends_at IS NULL OR ends_at > starts_at', name='ck_schedule_time_order'),
        # 列表分页固定按 (starts_at, id) 排序，索引列顺序必须与迁移 c01a7e421b50 一致。
        Index('ix_schedules_starts_at_id', 'starts_at', 'id'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1)
    client_create_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False, unique=True)
    create_payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
