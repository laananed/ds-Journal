"""HTTP revision parsing and the dedicated AI block deletion route."""
import re
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.writing.service import PreconditionRequired, WritingError


def matched_revision(if_match: str | None = Header(None)) -> int:
    if if_match is None:
        raise PreconditionRequired("If-Match is required")
    if not re.fullmatch(r'"[1-9][0-9]*"', if_match):
        raise WritingError('If-Match must be a quoted positive revision')
    digits = if_match[1:-1]
    if len(digits) > 19:
        raise WritingError('If-Match revision is outside bigint range')
    value = int(digits)
    if value > 9223372036854775807:
        raise WritingError('If-Match revision is outside bigint range')
    return value


router = APIRouter(prefix="/api/files", tags=["writing"])


@router.delete("/{type}/{id}/ai-blocks/{block_id}", status_code=204)
def delete_ai_block(type: Literal["journal", "inbox"], id: int, block_id: UUID,
                    expected_revision: int = Depends(matched_revision),
                    db: Session = Depends(get_db)):
    from app.writing.service import delete_ai_block as remove
    if not remove(db, type, id, str(block_id), expected_revision):
        raise HTTPException(status_code=404, detail="File or block not found")
    return Response(status_code=204)
