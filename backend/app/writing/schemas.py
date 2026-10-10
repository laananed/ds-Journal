"""Strict block identities and safe writing input contracts."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Revision = Annotated[int, Field(strict=True, ge=1, le=9223372036854775807)]


class UserBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    kind: Literal["user"]
    text: str


class AIBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    kind: Literal["ai_reply", "ai_summary"]
    text: str
    request_id: UUID


Block = Annotated[UserBlock | AIBlock, Field(discriminator="kind")]


class StructuredInput(BaseModel):
    """Ordinary legacy extras stay ignored; structured requests reject extras."""
    content: str = None
    content_blocks: list[Block] = None

    @model_validator(mode="before")
    @classmethod
    def check_body_fields(cls, data):
        if isinstance(data, dict) and "content_blocks" in data:
            if "content" in data:
                raise ValueError("content and content_blocks are mutually exclusive")
            if set(data) - set(cls.model_fields):
                raise ValueError("unknown structured writing fields")
        return data


class StructuredCreate(StructuredInput):
    @model_validator(mode="after")
    def require_body(self):
        if not ({"content", "content_blocks"} & self.model_fields_set):
            raise ValueError("content or content_blocks is required")
        return self
