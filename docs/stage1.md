# SeekJournal - Stage 1

## 1. Stage 1 定位

Stage 1 是 SeekJournal 的第一个可运行 Demo。

它不是完整产品。

当前阶段主要目的：

跑通第一次完整 Web 软件开发链路：

React
→ REST API
→ FastAPI
→ SQLAlchemy
→ PostgreSQL

同时学习：

- 前后端分离；
- React 基础；
- HTTP / REST；
- FastAPI；
- Pydantic；
- SQLAlchemy；
- PostgreSQL；
- Alembic；
- pytest；
- 基础 Git 开发流程。

---

## 2. 当前用户

Stage 1 只有一个实际用户：

项目开发者本人。

当前不实现：

- 注册；
- 登录；
- 多用户；
- 权限管理。

---

## 3. 核心对象

Stage 1 只实现：

Journal

暂不实现：

- Inbox
- Insight
- AI
- Plan
- Media

---

## 4. 创建 Journal

用户可以创建一篇 Journal。

创建时可以填写：

- title
- content
- journal_date

其中：

title：

可选。

content：

必填。

journal_date：

必填，但前端自动提供默认值。

---

## 5. journal_date

journal_date 表示：

“用户认为这篇 Journal 属于哪一天。”

它不代表实际创建时间。

例如：

用户在：

2026-10-09

补写：

2026-10-02 的日记。

那么：

journal_date：

2026-10-02

created_at：

2026-10-09 实际创建时间。

---

## 6. 默认日期规则

新建 Journal 时：

前端自动计算默认 journal_date。

规则：

04:00 ～ 23:59：

默认当天。

00:00 ～ 03:59：

默认前一天。

例如：

2026-10-03 01:30

新建 Journal。

默认：

journal_date = 2026-10-02

但是用户始终可以手动修改 journal_date。

Stage 1 暂时不提供：

“用户自定义换日时间”。

换日时间直接固定为：

04:00。

---

## 7. 同一天允许多篇 Journal

journal_date 不是唯一值。

同一天可以存在：

0 篇
1 篇
多篇

Journal。

真正唯一标识 Journal 的字段是：

id。

数据库不得设置：

journal_date UNIQUE。

---

## 8. 创建时查看当天已有 Journal

用户在新建 Journal 时选择 journal_date。

前端应查询：

该日期是否已经存在 Journal。

如果存在：

显示当天已有 Journal。

例如：

2026-10-02 已有 2 篇记录：

- 2026-10-02
- 广州动物园复盘

用户可以：

1. 打开已有 Journal；
2. 或继续创建新的 Journal。

系统不得强制“一天只能写一篇”。

---

## 9. Title 规则

数据库中的 title：

允许为空。

如果用户输入了 title：

UI 显示用户输入的 title。

如果 title 为空：

UI 使用 journal_date 生成默认显示标题。

例如：

2026-10-02

如果同一天存在多篇无标题 Journal：

UI 可以显示：

2026-10-02
2026-10-02 (2)
2026-10-02 (3)

`(2)`、`(3)`：

仅属于 UI 显示。

不得写入数据库 title 字段。

---

## 10. Journal 列表

用户可以查看已经保存的 Journal。

默认排序：

journal_date DESC

同一天内部：

created_at DESC

也就是：

日期新的记录优先显示。

同一天中：

后创建的记录优先显示。

---

## 11. Journal 详情

用户可以根据 id：

打开某一篇 Journal。

查看：

- title
- content
- journal_date
- created_at
- updated_at

---

## 12. 修改 Journal

用户可以修改：

- title
- content
- journal_date

修改以后：

updated_at 自动改变。

created_at 永远保持原始创建时间。

---

## 13. 删除 Journal

Stage 1 使用：

硬删除。

用户删除 Journal 后：

记录直接从 PostgreSQL 删除。

Stage 1 不实现：

- 回收箱；
- deleted_at；
- 30 天恢复。

这些进入后续阶段。

---

## 14. Journal 数据字段

| 字段 | 含义 | 规则 |
|---|---|---|
| id | Journal 唯一标识 | Primary Key |
| title | 用户自定义标题 | Nullable |
| content | Journal 正文 | Required |
| journal_date | Journal 所属日期 | Required，不唯一 |
| created_at | 实际创建时间 | 系统生成 |
| updated_at | 最后修改时间 | 系统维护 |

journal_date：

建立普通数据库索引。

不得建立 UNIQUE。

---

## 15. Stage 1 不开发的功能

以下功能明确不属于 Stage 1：

- Inbox
- Insight
- AI
- Journal 合并
- 回收箱
- 图片
- 标签
- 全文搜索
- 语义搜索
- 用户注册
- 登录
- 权限
- 云服务器
- Android
- Windows App
- 多端同步
- Offline-first
- E2EE
- LangChain
- LangGraph
- Redis
- 微服务
- Repository Layer
- 完整品牌 UI
- 复杂动画

---

## 16. 已记录但暂缓的需求

### Journal Merge

未来需要支持：

同日期 Journal 合并。

以及：

不同日期 Journal 合并。

但是 Stage 1 不实现。

未来实现前需要重新决定：

- 合并后的 journal_date；
- 合并后的 title；
- content 如何组合；
- 原 Journal 是否删除；
- 是否支持撤销；
- 是否支持多篇批量合并。

当前不得为了 Merge 提前增加数据库字段。

---

## 17. 功能验收标准

Stage 1 完成时必须满足：

### Web

- 本地 Web 可以正常打开。

### Create

- 可以填写 Journal；
- title 可以留空；
- journal_date 自动提供默认值；
- 可以手动修改 journal_date；
- 可以保存 Journal。

### Date

- 04:00 前默认前一天；
- 04:00 后默认当天；
- 同一天允许多篇 Journal；
- 选择日期时可以看到当天已有 Journal。

### Display

- title 不为空时显示 title；
- title 为空时显示日期；
- 同一天多篇无标题 Journal 可以通过 `(2)`、`(3)` 区分。

### Read

- 可以查看 Journal 列表；
- 可以打开单篇 Journal。

### Update

- 可以修改 title；
- 可以修改 content；
- 可以修改 journal_date；
- updated_at 正确更新；
- created_at 不改变。

### Delete

- 可以删除 Journal；
- 删除后数据库中记录不存在。

### Persistence

- 关闭网页；
- 重新打开；
- Journal 仍然存在。

---

## 18. 技术验收标准

Stage 1 完成时：

- React 可以正常运行；
- TypeScript 正常使用；
- Vite 正常运行；
- React 能调用 FastAPI；
- REST API 可以正常工作；
- FastAPI `/docs` 可以查看 API；
- Pydantic 完成请求验证；
- SQLAlchemy 完成 ORM 操作；
- psycopg 正常连接 PostgreSQL；
- PostgreSQL 正常持久化数据；
- Alembic Migration 可以创建 journals 表；
- pytest 核心 API 测试通过；
- PostgreSQL 可以通过 Docker Compose 启动；
- `.env` 不进入 Git。

---

## 19. 学习验收标准

Stage 1 完成以后，开发者至少能够用自己的语言解释：

- React 是什么；
- Component 是什么；
- State 是什么；
- State 和数据库数据有什么区别；
- HTTP 是什么；
- REST API 是什么；
- FastAPI 做什么；
- Router 做什么；
- Pydantic 做什么；
- Service 做什么；
- SQLAlchemy 做什么；
- psycopg 做什么；
- PostgreSQL 做什么；
- Alembic 做什么；
- Migration 是什么；
- 一篇 Journal 从 React 到 PostgreSQL 经历了什么。

不要求：

脱离 AI 独立写完整项目。

要求：

能够理解主要结构为什么存在。