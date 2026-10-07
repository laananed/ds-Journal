"""Journal 显示标题（display_title）投影。

Stage 2 / S2-T02。

`display_title` 是**只读读取投影**，不写入数据库、不新增字段：

- 手工标题（`title` 非 `None` 且非空字符串）原样显示，不 trim、不占编号；
- 无标题（`title` 为 `None` 或 `""`）显示其 `journal_date`；
  同一天的无标题记录按 `created_at ASC, id ASC` 分配序号，
  第一篇显示日期，其后显示 `日期 (2)`、`日期 (3)` ……

编号空间的定义（依据 `docs/stage2.md` §4 与已确认的 P3）：

- 在该日期**完整现存集合**上计算，**包含已软删除但仍存在的记录**；
- 因此新增较晚记录、软删除、恢复都不会改变其他现存记录的编号；
- 永久删除、改日期、手工标题转换允许重新编号（P3 已接受）。

本模块只做两件事：

1. `untitled_predicate()`：给出「无标题」的 SQL 条件（编号与投影共用同一判定）；
2. `build_display_title()`：把 `title` + `journal_date` + 序号合成显示标题（纯函数）。

编号本身由 `numbered_subquery()` 的窗口函数在数据库计算；
本模块不拉全量数据到 Python，也不按当前页位置编号。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import ColumnElement, func, or_, select

from app.journal.models import Journal


def is_untitled(title: str | None) -> bool:
    """判断是否为「无标题」。`None` 与空字符串都是无标题，纯空白非空字符串不是。"""
    return title is None or title == ""


def untitled_predicate(column: ColumnElement[str | None]) -> ColumnElement[bool]:
    """「无标题」的 SQL 条件：`title IS NULL OR title = ''`。

    与 `is_untitled()` 是同一条规则：NULL 与空字符串都算无标题，
    纯空白但非空的字符串是手工标题。
    """
    return or_(column.is_(None), column == "")


def build_display_title(
    title: str | None,
    journal_date: date,
    sequence: int | None,
) -> str:
    """合成显示标题。

    - 手工标题：原样返回（不 trim）；
    - 无标题：第一篇返回 `journal_date`，第 n 篇返回 `journal_date (n)`。

    `sequence` 是窗口函数算出的、该日期无标题集合内的 1 基序号。
    手工标题的记录不会有序号，此时 `sequence` 应为 `None`；
    无标题记录若因调用方遗漏而没有序号，则退化为「第一篇」的显示。
    """
    if not is_untitled(title):
        # mypy: 上面的判断已保证不是 None。
        return title  # type: ignore[return-value]

    day = journal_date.isoformat()
    if sequence is None or sequence <= 1:
        return day
    return f"{day} ({sequence})"


def numbered_subquery():
    """无标题 Journal 的编号子查询：`id` + 该日期内的 1 基序号 `seq`。

    ```sql
    SELECT id,
           row_number() OVER (PARTITION BY journal_date ORDER BY created_at, id) AS seq
    FROM journals
    WHERE title IS NULL OR title = ''
    ```

    刻意**不过滤 `deleted_at`**：编号必须在含已软删除记录的完整集合上计算，
    这样软删除/恢复才不会改动其他记录的编号。

    调用方把它 `LEFT JOIN` 到自己的查询上；手工标题的行 JOIN 不到，`seq` 为 NULL，
    由 `build_display_title()` 回退为显示原 `title`。
    """
    return (
        select(
            Journal.id.label("id"),
            func.row_number()
            .over(
                partition_by=Journal.journal_date,
                order_by=(Journal.created_at.asc(), Journal.id.asc()),
            )
            .label("seq"),
        )
        .where(untitled_predicate(Journal.title))
        .subquery("journal_untitled_numbered")
    )
