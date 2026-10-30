from datetime import datetime, timezone
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Fields(BaseModel):
    model_config = ConfigDict(extra='forbid')

    @field_validator('starts_at', 'ends_at', mode='before', check_fields=False)
    @classmethod
    def iso_input(cls, value):
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError('time must be an ISO datetime')
        return value

    @field_validator('starts_at', 'ends_at', check_fields=False)
    @classmethod
    def aware_utc(cls, value):
        if value is not None:
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError('time must include an offset')
            return value.astimezone(timezone.utc)
        return value

    @field_validator('title', check_fields=False)
    @classmethod
    def nonblank(cls, value):
        if value is not None and not value.strip():
            raise ValueError('title must not be blank')
        return value


class ScheduleCreate(Fields):
    title: str = Field(min_length=1, max_length=80, strict=True)
    starts_at: datetime
    ends_at: datetime | None
    completed: bool = Field(strict=True)
    client_create_id: UUID

    @model_validator(mode='after')
    def valid_range(self):
        if self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError('end must be after start')
        return self


class ScheduleUpdate(Fields):
    expected_revision: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    title: str | None = Field(default=None, min_length=1, max_length=80, strict=True)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    completed: bool | None = Field(default=None, strict=True)

    @model_validator(mode='after')
    def valid_fields(self):
        for name in ('expected_revision', 'title', 'starts_at', 'completed'):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f'{name} cannot be null')
        if not self.model_fields_set.intersection({'title', 'starts_at', 'ends_at', 'completed'}):
            raise ValueError('no fields to update')
        return self
