"""Stage 4 storage foundations; business writes belong to later tasks."""
from datetime import datetime
from uuid import UUID

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class RitualTemplate(Base):
    __tablename__ = 'ritual_templates'
    __table_args__ = (CheckConstraint("kind IN ('set','end')", name='ck_ritual_templates_kind'),)
    kind: Mapped[str] = mapped_column(Text, primary_key=True)
    questions: Mapped[list] = mapped_column(JSONB, nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default='1')


class RitualGoalLink(Base):
    __tablename__ = 'ritual_goal_links'
    __table_args__ = (UniqueConstraint('end_journal_id', 'goal_id', name='uq_ritual_link_end_goal'),)
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    set_journal_id: Mapped[int | None] = mapped_column(ForeignKey('journals.id', ondelete='SET NULL'))
    end_journal_id: Mapped[int] = mapped_column(ForeignKey('journals.id', ondelete='CASCADE'), nullable=False)
    goal_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    end_node_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)


class RitualCopy(Base):
    __tablename__ = 'ritual_copies'
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    target_id: Mapped[int] = mapped_column(Integer, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    copied_nodes: Mapped[list] = mapped_column(JSONB, nullable=False)


class AIComment(Base):
    __tablename__ = 'ai_comments'
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    journal_id: Mapped[int] = mapped_column(ForeignKey('journals.id', ondelete='CASCADE'), nullable=False)
    request_id: Mapped[UUID | None] = mapped_column(ForeignKey('ai_requests.id', ondelete='SET NULL'))
    mind_preset_id: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    quote: Mapped[str] = mapped_column(Text, nullable=False)
    anchor: Mapped[dict] = mapped_column(JSONB, nullable=False)
    anchor_state: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
