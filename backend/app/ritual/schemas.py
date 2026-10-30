"""Validated inputs for the current Ritual question templates."""
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class TemplateQuestion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: UUID
    text: str

    @field_validator('text')
    @classmethod
    def valid_text(cls, value):
        value = value.strip()
        if not value or len(value) > 500:
            raise ValueError('question must contain 1 to 500 characters')
        return value


class TemplateUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int | None = Field(default=None, strict=True, ge=0)
    questions: list[TemplateQuestion] = Field(max_length=4)

    @model_validator(mode='after')
    def unique_questions(self):
        ids = [question.id for question in self.questions]
        if len(ids) != len(set(ids)):
            raise ValueError('question IDs must be unique')
        if 'expected_revision' in self.model_fields_set and self.expected_revision is None:
            raise ValueError('expected_revision cannot be null')
        return self


class RestoreReplace(BaseModel):
    model_config = ConfigDict(extra='forbid')
    target_id: int = Field(strict=True, gt=0)
    expected_target_revision: int | None = Field(default=None, strict=True, gt=0)
    related_revisions: list[dict]

    @model_validator(mode='after')
    def no_explicit_null_revision(self):
        if 'expected_target_revision' in self.model_fields_set and self.expected_target_revision is None:
            raise ValueError('expected_target_revision cannot be null')
        return self


class CopySelection(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)
    node_id: UUID
    start: int | None = Field(default=None, alias='from', strict=True, ge=0)
    end: int | None = Field(default=None, alias='to', strict=True, ge=0)

    @model_validator(mode='after')
    def range_pair(self):
        if (self.start is None) != (self.end is None) or (self.start is not None and self.end <= self.start):
            raise ValueError('invalid selection range')
        return self


class CopyContent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_revision: int | None = Field(default=None, strict=True, gt=0)
    target_id: int = Field(strict=True, gt=0)
    expected_target_revision: int | None = Field(default=None, strict=True, gt=0)
    copy_id: UUID
    selection: list[CopySelection] = Field(min_length=1)
    insert_after_node_id: UUID
    related_revisions: list[dict]

    @model_validator(mode='after')
    def no_explicit_null_revisions(self):
        for key in ('source_revision', 'expected_target_revision'):
            if key in self.model_fields_set and getattr(self, key) is None:
                raise ValueError(f'{key} cannot be null')
        return self
