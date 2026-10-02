# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 2 产物）。

当前只包含一个最小 FastAPI 应用和一个存活检查接口。

## 环境要求

- Python 3.12（使用 `py -3.12` 启动）

## 创建虚拟环境

在 `backend/` 目录下执行：

```powershell
py -3.12 -m venv .venv
```

## 安装依赖

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

依赖的实际安装版本记录在 `requirements.txt`，由虚拟环境的 `pip freeze` 生成。

运行命令请始终使用 `.venv\Scripts\python.exe`，不要使用全局 pip。

## 启动

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 应用地址：http://127.0.0.1:8000
- 交互式文档：http://127.0.0.1:8000/docs

## 验证

另开一个终端：

```powershell
curl.exe -i http://127.0.0.1:8000/api/health
```

期望结果：

- HTTP `200 OK`
- `Content-Type: application/json`
- 响应体：`{"status":"ok"}`

`/api/health` 只表示应用可以响应 HTTP 请求，不检查数据库。

## 停止

在运行 uvicorn 的终端按 `Ctrl+C`。

## 当前范围

本 Task 只创建最小 FastAPI 应用：

```text
backend/
├── app/
│   ├── __init__.py
│   └── main.py
├── requirements.txt
└── README.md
```

已实现：

- `GET /api/health`

尚未实现：Journal CRUD、数据库连接、Alembic Migration、CORS、认证、pytest，以及前端调用。
