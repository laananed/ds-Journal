"""AI recovery snapshots, checkpoints, anonymous usage, and one settings row."""
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, true, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class AIRequest(Base):
    __tablename__ = "ai_requests"
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[list] = mapped_column(JSONB, nullable=False)
    question: Mapped[str | None] = mapped_column(Text)
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    result: Mapped[dict | None] = mapped_column(JSONB)
    saved_target: Mapped[dict | None] = mapped_column(JSONB)
    save_payload_hash: Mapped[str | None] = mapped_column(Text)
    error_category: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AICheckpoint(Base):
    __tablename__ = "ai_checkpoints"
    __table_args__ = (CheckConstraint("file_type IN ('journal', 'inbox')", name="ck_ai_checkpoints_type"),)
    file_type: Mapped[str] = mapped_column(Text, primary_key=True)
    file_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    consumed_user_text: Mapped[str] = mapped_column(Text, nullable=False)
    # No FK: deleting a multi-source request must not erase other source checkpoints.
    last_request_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class AIUsage(Base):
    __tablename__ = "ai_usage"
    __table_args__ = (UniqueConstraint("request_id", "subcall_index", name="uq_ai_usage_request_subcall"),)
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    request_id: Mapped[UUID | None] = mapped_column(ForeignKey("ai_requests.id", ondelete="SET NULL"))
    subcall_index: Mapped[int] = mapped_column(Integer, nullable=False)
    response_id: Mapped[str | None] = mapped_column(Text)
    prompt_tokens: Mapped[int | None] = mapped_column(BigInteger)
    completion_tokens: Mapped[int | None] = mapped_column(BigInteger)
    total_tokens: Mapped[int | None] = mapped_column(BigInteger)
    metering: Mapped[str] = mapped_column(Text, nullable=False)
    search_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class AISettings(Base):
    __tablename__ = "ai_settings"
    __table_args__ = (CheckConstraint("id = 1", name="ck_ai_settings_singleton"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    custom_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default=text("''"))
    web_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=true())
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default=text("1"))
