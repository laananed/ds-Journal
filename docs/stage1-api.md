# SeekJournal - Stage 1 API Contract

## 1. Purpose

本文档定义 Stage 1：

React Frontend

与：

FastAPI Backend

之间的 API 契约。

Developer Agent 不得自行修改：

- URL；
- HTTP Method；
- 字段名称；
- 字段语义；
- 基础 Response 结构。

如果需要修改：

先提出问题并等待确认。

---

## 2. Base Path

所有 Stage 1 API 使用：

`/api`

Journal Base Path：

`/api/journals`

---

## 3. Journal Object

完整 Journal Response：

```json
{
  "id": 1,
  "title": "广州动物园",
  "content": "今天去了广州动物园……",
  "journal_date": "2026-10-02",
  "created_at": "2026-10-02T14:30:00Z",
  "updated_at": "2026-10-02T14:30:00Z"
}
```

字段说明：

### id

类型：

integer

说明：

Journal 唯一标识。

由系统生成。

---

### title

类型：

string | null

说明：

用户自定义标题。

允许为空。

默认显示日期属于前端 UI 逻辑。

数据库不得为了默认标题自动写入日期字符串。

---

### content

类型：

string

说明：

Journal 正文。

必填。

---

### journal_date

类型：

date

JSON 格式：

`YYYY-MM-DD`

例如：

`2026-10-02`

说明：

用户认为该 Journal 属于哪一天。

允许多篇 Journal 使用同一个 journal_date。

不得设置为唯一值。

---

### created_at

类型：

datetime

说明：

Journal 实际创建时间。

由系统自动生成。

用户不能修改。

---

### updated_at

类型：

datetime

说明：

Journal 最近一次修改时间。

由系统自动维护。

---

## 4. POST /api/journals

用途：

创建 Journal。

### Request

```json
{
  "title": null,
  "content": "今天开始学习 SeekJournal 的项目架构。",
  "journal_date": "2026-10-02"
}
```

也允许：

```json
{
  "title": "广州动物园复盘",
  "content": "今天去了广州动物园……",
  "journal_date": "2026-10-02"
}
```

### Required Fields

- content
- journal_date

### Optional Fields

- title

### Success

HTTP:

`201 Created`

Response：

返回创建后的完整 Journal。

例如：

```json
{
  "id": 12,
  "title": null,
  "content": "今天开始学习 SeekJournal 的项目架构。",
  "journal_date": "2026-10-02",
  "created_at": "2026-10-02T14:30:00Z",
  "updated_at": "2026-10-02T14:30:00Z"
}
```

---

## 5. GET /api/journals

用途：

获取 Journal 列表。

### Request

```text
GET /api/journals
```

### Default Sort

第一排序：

`journal_date DESC`

第二排序：

`created_at DESC`

### Success

HTTP:

`200 OK`

Response：

Journal Array。

例如：

```json
[
  {
    "id": 15,
    "title": null,
    "content": "晚上补充了一些内容。",
    "journal_date": "2026-10-02",
    "created_at": "2026-10-03T01:20:00Z",
    "updated_at": "2026-10-03T01:20:00Z"
  },
  {
    "id": 12,
    "title": "广州动物园复盘",
    "content": "今天去了广州动物园……",
    "journal_date": "2026-10-02",
    "created_at": "2026-10-02T14:30:00Z",
    "updated_at": "2026-10-02T14:30:00Z"
  }
]
```

如果没有 Journal：

返回：

```json
[]
```

---

## 6. GET /api/journals?journal_date=YYYY-MM-DD

用途：

查询指定日期的全部 Journal。

例如：

```text
GET /api/journals?journal_date=2026-10-02
```

### Success

HTTP:

`200 OK`

返回：

该 journal_date 下所有 Journal。

例如：

```json
[
  {
    "id": 12,
    "title": "广州动物园复盘",
    "content": "今天去了广州动物园……",
    "journal_date": "2026-10-02",
    "created_at": "2026-10-02T14:30:00Z",
    "updated_at": "2026-10-02T14:30:00Z"
  },
  {
    "id": 15,
    "title": null,
    "content": "晚上又补了一点。",
    "journal_date": "2026-10-02",
    "created_at": "2026-10-03T01:20:00Z",
    "updated_at": "2026-10-03T01:20:00Z"
  }
]
```

如果该日期没有记录：

返回：

```json
[]
```

该 API 用于：

用户选择日期时展示当天已有 Journal。

---

## 7. GET /api/journals/{id}

用途：

获取某一篇 Journal。

例如：

```text
GET /api/journals/12
```

### Success

HTTP:

`200 OK`

Response：

```json
{
  "id": 12,
  "title": "广州动物园复盘",
  "content": "今天去了广州动物园……",
  "journal_date": "2026-10-02",
  "created_at": "2026-10-02T14:30:00Z",
  "updated_at": "2026-10-02T14:30:00Z"
}
```

### Not Found

如果 id 不存在：

HTTP:

`404 Not Found`

---

## 8. PATCH /api/journals/{id}

用途：

修改 Journal。

PATCH：

只修改本次 Request 提交的字段。

允许修改：

- title
- content
- journal_date

不允许修改：

- id
- created_at
- updated_at

---

### Example 1 - 修改 title

```json
{
  "title": "广州动物园游玩复盘"
}
```

---

### Example 2 - 修改 content

```json
{
  "content": "修改后的正文。"
}
```

---

### Example 3 - 修改 journal_date

```json
{
  "journal_date": "2026-10-01"
}
```

---

### Example 4 - 同时修改多个字段

```json
{
  "title": "新的标题",
  "content": "新的内容",
  "journal_date": "2026-10-01"
}
```

### Success

HTTP:

`200 OK`

返回修改后的完整 Journal。

### updated_at

成功修改后：

系统自动更新。

### created_at

保持不变。

### Not Found

id 不存在：

`404 Not Found`

---

## 9. DELETE /api/journals/{id}

用途：

删除 Journal。

例如：

```text
DELETE /api/journals/12
```

Stage 1：

使用硬删除。

删除后：

该记录直接从 PostgreSQL 移除。

### Success

HTTP:

`204 No Content`

Response Body：

为空。

### Not Found

如果 id 不存在：

`404 Not Found`

---

## 10. Data Validation

### title

允许：

string

或者：

null

---

### content

必须存在。

类型：

string

Stage 1 暂不设置复杂字数限制。

---

### journal_date

必须存在。

必须是合法日期。

格式：

`YYYY-MM-DD`

---

## 11. Validation Error

请求结构不合法时：

由 FastAPI / Pydantic 返回标准验证错误。

通常 HTTP：

`422 Unprocessable Entity`

Stage 1 不自定义复杂错误格式。

---

## 12. Server Error

未预期服务器异常：

HTTP：

`500 Internal Server Error`

Stage 1 暂不设计：

- 自定义 Error Code；
- 多语言错误；
- 全局复杂错误体系。

---

## 13. Frontend Display Rules

这些规则属于前端。

不是数据库规则。

### Default Title

如果：

title != null

显示：

title。

如果：

title == null

显示：

journal_date。

---

### Same-Day Numbering

如果同一天存在多篇无标题 Journal：

可以显示：

```text
2026-10-02
2026-10-02 (2)
2026-10-02 (3)
```

`(n)` 不进入 API。

`(n)` 不进入数据库。

---

## 14. Default journal_date

默认日期由 Frontend 计算。

规则：

00:00 ～ 03:59：

默认前一天。

04:00 ～ 23:59：

默认当天。

Frontend 最终必须明确把：

`journal_date`

发送给 Backend。

Backend Stage 1 不负责推断用户想写哪一天。

---

## 15. API Summary

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/journals` | 创建 Journal |
| GET | `/api/journals` | 获取 Journal 列表 |
| GET | `/api/journals?journal_date=YYYY-MM-DD` | 按日期查询 |
| GET | `/api/journals/{id}` | 获取单篇 Journal |
| PATCH | `/api/journals/{id}` | 修改 Journal |
| DELETE | `/api/journals/{id}` | 删除 Journal |

---

## 16. API Change Protocol

如果开发过程中发现 API 设计存在问题：

Developer 不得直接修改。

必须首先提交：

### Problem

哪里存在问题。

### Impact

当前设计造成什么影响。

### Options

有哪些可行方案。

### Recommendation

推荐什么方案以及原因。

用户确认以后：

先修改本文件。

再修改代码。
