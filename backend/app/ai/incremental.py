"""Code-point deltas. AI blocks never enter the user sequence."""
from dataclasses import dataclass

from app.journal.schemas import _is_blank


@dataclass(frozen=True)
class Increment:
    text: str
    revised: bool
    position: int

    @property
    def valid(self):
        return not _is_blank(self.text)


def user_text(blocks, legacy_content):
    if blocks is None:
        return legacy_content
    return ''.join(b['text'] for b in blocks if b['kind'] == 'user')


def compute_increment(current: str, checkpoint: str | None) -> Increment:
    if checkpoint is None:
        return Increment(current, False, 0)
    if current.startswith(checkpoint):
        return Increment(current[len(checkpoint):], False, len(checkpoint))
    position = 0
    for old, new in zip(checkpoint, current):
        if old != new:
            break
        position += 1
    return Increment(current[position:], True, position)


def bounded_context(turns):
    """Questions and replies only; never replay previous journal deltas/full text.

    Input is oldest first. Select whole messages newest first, then restore order.
    At most three turns, six messages and 4,000 Unicode code points.
    """
    selected = []
    size = 0
    for turn in reversed(turns[-3:]):
        for role, key in [('assistant', 'reply'), ('user', 'question')]:
            value = turn.get(key)
            if not isinstance(value, str) or _is_blank(value):
                continue
            if size + len(value) > 4000:
                continue
            selected.append({'role': role, 'content': value})
            size += len(value)
    return list(reversed(selected))
