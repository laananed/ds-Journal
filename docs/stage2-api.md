# SeekJournal — Stage 2 API Contract

> 2026-10-07。产品依据 `stage2.md`，架构依据 `stage2-architecture.md`。
> 这是 Lead 为已确认功能制定的开发契约，尚未实现。P1/P2/P3 分支必须确认并同步文档后才实现；其余契约可独立开发。
> Stage 1.5 仍使用原六字段与数组响应，只修请求验证；Stage 2 明确改变列表响应、添加只读字段和软删除语义，前后端必须配套更新。

## 1. 通用约定

Base path `/api`。JSON；日期 `YYYY-MM-DD`，时间为带时区 ISO 8601。
类型标识为 `journal | inbox | insight`；跨类型唯一身份是 **(type, id)**，三张表的 id 不要求全局唯一。
类型复数路由固定 `/journals`、`/inboxes`、`/insights`。

- 成功：GET/PATCH/恢复 200；创建 201；删除 204 且响应体为空。
- 请求值非法：FastAPI/Pydantic 标准 422，不创建复杂错误码体系。
- 不存在或普通入口访问软删除对象：404。
- 非空 Folder 删除、Daily 创建冲突：409，使用简单 `{"detail":"..."}`。
- 数据库失败：rollback，向上抛异常；不伪装为 404 或成功。
- 额外/系统字段沿用 ignore；客户端不能设 id、display_title、created_at、updated_at、deleted_at。
- 系统维护字段的“忽略”不等于允许修改；PATCH 仅白名单业务字段更新。
- 所有 POST/PATCH 中实际提交的 title/content 遵循产品的 80/50,000、非空白正文和原样保存；输出不套新请求限制，以便读取历史 Journal。
- PATCH 省略字段表示不变；显式 `title=null` 对 Journal/Insight 表示清空；Inbox 空标题 P1 待定。显式 `content=null`、日期 null 非法；`folder_id=null` 表示移出 Folder。
- 空 PATCH/仅忽略字段：有效对象 200 原值，不写库；不存在或软删除 404。相同值不改变 updated_at。

## 2. 文件响应与分页

所有完整文件响应共有：

| 字段 | 类型 | 含义 |
|---|---|---|
| type | string enum | journal / inbox / insight，只读 |
| id | integer | 类型内 ID，只读 |
| title | string / null | 数据库原始标题，不含自动生成值 |
| display_title | string | 展示与内部链接匹配使用的只读标题 |
| content | string | 原始完整 Markdown |
| folder_id | integer / null | 唯一 Folder；null 为无 Folder |
| created_at / updated_at | datetime | 原创建/内容修改时间 |
| deleted_at | datetime / null | 删除时间；普通响应必须为 null |

Journal 另有 `journal_date: date`；Inbox 另有 `inbox_date: date, is_daily: boolean`；Insight 没有所属日期。
Inbox 日期/Daily 身份在创建时确定，不在 PATCH 可改字段中。Folder 关系变化属于文件修改。
Stage 1.5 的编号仍不进 API；Stage 2 添加的是 **只读 display_title**，不是将生成编号写入 title。
生成编号的删除/改名稳定性依 `stage2.md` P3，不能由 API 开发者决定。

通用列表响应（包括按日期、Folder、Search、Trash、链接候选）：

```json
{
  "items": [],
  "page": 1,
  "page_size": 20,
  "total": 0,
  "has_next": false
}
```

请求 `page` 为整数且 >=1，默认 1。**page_size 固定 20，不提供客户端自定义参数**。
total 是所有筛选条件生效后的总数；has_next 根据全局总数计算。
无匹配或超出最后页时 200 + 空 items；超范围请求保留请求页码，前端根据 total 再取最近有效页，total=0 时第 1 页。
列表暂时返回完整 content，便于复用现有契约与预览；若实际传输成为问题，另行规划摘要投影，不改保存值。
候选解析使用下面的轻量 Candidate，不返回全部正文。

## 3. Journal

| Method | Endpoint | 请求/行为 |
|---|---|---|
| POST | `/api/journals` | content、journal_date 必填；title 可省略/null，folder_id 可省略/null；201 完整 Journal |
| GET | `/api/journals` | 可选 journal_date、folder_id、page；200 分页有效 Journal |
| GET | `/api/journals/{id}` | 200 完整有效 Journal；不存在/已删除 404 |
| PATCH | `/api/journals/{id}` | 仅 title、content、journal_date、folder_id；200 完整有效 Journal |
| DELETE | `/api/journals/{id}` | 软删除，设置 deleted_at，显式保留 updated_at；204 空体 |

排序 `journal_date DESC, created_at DESC, id DESC`；原两级排序不变，id 仅打破并列。
journal_date 筛选也分页。新建时“当天已有记录”使用 total 展示真实数量，可翻页，不用 items.length 冒充总数。
无标题 display_title 在该日期完整编号空间计算后再筛选、分页；不能用页内位置编号。
重复 DELETE 已软删除对象返回 404，不改原 deleted_at。

## 4. Inbox 与 Daily

| Method | Endpoint | 请求/行为 |
|---|---|---|
| POST | `/api/inboxes` | content、inbox_date 必填；title 省略时为该日期；is_daily 默认 false；folder_id 可省略/null |
| GET | `/api/inboxes` | 可选 inbox_date、folder_id、page；仅有效对象，`created_at DESC, id DESC` |
| GET | `/api/inboxes/daily` | 必填 inbox_date；只查询 Daily 身份，无自动创建 |
| GET | `/api/inboxes/{id}` | 200 有效 Inbox；不存在/已删除 404 |
| PATCH | `/api/inboxes/{id}` | 仅 title、content、folder_id |
| DELETE | `/api/inboxes/{id}` | 软删除；204 空体；不改 updated_at |

前端明确发送按本机 04:00 算出的 inbox_date，后端不从服务器 UTC 猜业务日期。
Daily 保存同样调用 POST，`is_daily=true`。改名后仍按身份字段查询，不按 title 匹配。
静态 `/daily` 在动态 `/{id}` 路由前注册；合法日期无 Daily 时不是路径 404。

**P1 边界**：非空用户标题和省略默认标题已确定；显式 null/空字符串/纯空白标题的保存与回退分支暂不冻结，不写“必须非空”或“必然允许清空”的实现。

**P2 建议契约（须产品确认）**：

```json
{
  "state": "missing",
  "id": null,
  "file": null
}
```

state 为 missing/active/trashed；active 返回 id 与完整有效 file；trashed 仅返回 id、file=null，正文通过回收箱详情获取。
这样 GET 不写库；当 Daily 已在回收箱时，引导恢复，重复 Daily POST 返回 409。
日期内并发保存/双标签创建靠数据库唯一约束兜底，409 后重新查询，不自动覆盖正文。
若产品选择“删除后可新建 Daily”，需改此契约、唯一性范围与恢复冲突规则；不得仅改索引。

## 5. Insight

| Method | Endpoint | 请求/行为 |
|---|---|---|
| POST | `/api/insights` | content 必填；title 可省略/null，folder_id 可省略/null；201 |
| GET | `/api/insights` | 可选 folder_id、page；有效对象，`updated_at DESC, id DESC` |
| GET | `/api/insights/{id}` | 有效详情；200/404 |
| PATCH | `/api/insights/{id}` | 仅 title、content、folder_id；200/404 |
| DELETE | `/api/insights/{id}` | 软删除；204/404，不改 updated_at |

不接收 journal_date、来源 Journal、AI 状态等字段。

## 6. Folder

Folder 对象只有 `id: integer, name: string`，无需为其增加历史时间线。
Lead 的最小参数校验：name trim 后 1～80 个码点，保存 trim 后名称；不要求名称唯一，页面以 id 操作。

| Method | Endpoint | 结果 |
|---|---|---|
| POST | `/api/folders` | `{ "name":"项目思考" }`；201 Folder |
| GET | `/api/folders` | 200 Folder 数组，`id ASC`；不是内容文件卡片列表，无强制分页 |
| PATCH | `/api/folders/{id}` | name 可省略；200 Folder；空更新不写；不存在 404 |
| GET | `/api/folders/{id}/files` | page；200 三类有效文件统一分页，Folder 不存在 404 |
| DELETE | `/api/folders/{id}` | 真空 204；不存在 404；任一有效/已删除文件仍引用则 409 |

Folder 内容排序 `updated_at DESC, type 顺序, id DESC`，与跨类型搜索保持一致。
文件移入/移出使用对应文件的 PATCH folder_id，不新增移动接口。
POST/PATCH 指定不存在 Folder 返回 404，整个写入回滚，不留下其他字段的半截更新。
数据库 FK 使用 RESTRICT/NO ACTION；删除 Folder 不级联删除文件，不 SET NULL。

## 7. Trash

| Method | Endpoint | 结果 |
|---|---|---|
| GET | `/api/trash` | 可选 type（all/journal/inbox/insight）、page；仅已删除文件，全局分页 |
| GET | `/api/trash/{type}/{id}` | 200 完整已删除文件；未删除/不存在 404；只读 |
| POST | `/api/trash/{type}/{id}/restore` | 无业务请求体；200 恢复后的完整有效文件 |
| DELETE | `/api/trash/{type}/{id}` | 单条永久删除，仅已删除文件；204 空体 |

type 路径只接受单数 journal/inbox/insight，非法类型 422。
排序 `deleted_at DESC, type 顺序, id DESC`。
恢复清空 deleted_at，不改变其他原有字段/时间/Folder；对有效对象重复恢复 404。
有效文件不得借用 Trash DELETE 直接永久删除；回收箱不存在 PATCH 或 Folder 修改接口。
详情页中的确认文案区分“移入回收箱，可以恢复”和“永久删除，无法恢复”。
P2 若采用推荐约束，恢复 Daily 不产生同日身份冲突；否则先明确恢复冲突契约。

## 8. Search

`GET /api/search?q=AI%20培训&type=all&page=1`

q 可省略，空白时返回空分页；type 默认 all，仅接受 all/journal/inbox/insight。
对 q 按连续空白分词；每词 `(title 命中 OR content 命中)`，各词 AND；英文不分大小写，中文子串；参数化 SQL 并转义 LIKE `%/_/转义符`。
排除 deleted_at 非空。排序 `updated_at DESC, type 顺序, id DESC`；分页在合并三类结果之后执行。
不搜索 display_title、folder 名称、日期字段，不返回相关性分值。
200 通用分页文件响应；无结果 total=0。没有独立搜索索引或数据库迁移。

## 9. Link resolution

`GET /api/links/resolve?title=2026-10-07%20(2)&page=1`

title 必填非空字符串，URL 编码保留其完整文本；按 display_title 精确等值匹配有效文件。
200 分页候选，字段：type、id、title、display_title、journal_date（仅 Journal）、created_at。
按类型固定顺序、id DESC 排序；解析的是完整匹配集合，total 不能等于当前页长度。

total=1 时前端打开候选的普通详情；>1 显示选择列表并能翻页；=0 显示“找不到目标”。
这不是搜索接口，不能用模糊 search 代替精确标题解析。
不创建链接关系，不写目标 id 到正文，不自动创建文件；代码文本、未闭合 `[[` 不触发解析。
Folder、分页、回收箱、Search 返回的 Journal display_title 必须使用同一编号定义。

## 10. 保留与变更检查

`GET /api/health` 保持 `{"status":"ok"}`，仍不代表数据库或业务验收通过。
Stage 1 GET 数组测试在 S2-T02 配套改为分页 envelope，原排序/日期/404/字段不被篡改等测试意图必须保留。
Stage 1 硬删除测试在 S2-T02 改为软删除断言；原单条影响范围、错误回滚、204 空响应覆盖继续保留，物理消失断言转由 S2-T09 永久删除测试覆盖。
未列出的接口、查询参数、系统字段可修改性，不由 Developer 顺手补齐。
