# Readest 自建云同步服务端（非官方）

> ⚠️ **独立实现，与 Readest 原作者无关。** 本项目是一个兼容 [Readest](https://readest.com) 客户端同步 API 的**自建服务端**，不包含 Readest 客户端的任何源代码，亦未使用其商标。Readest 客户端为 AGPL-3.0，若你修改并对外发布联网使用的客户端，须遵守 AGPL 义务（见下文「客户端改动」）。

一个零外部依赖（默认 SQLite + 本地磁盘）的 Go 单二进制同步服务端，用于自用跨设备同步：

- 「写死一个码」登录 + JWT（`plan:pro` 不限配额）
- 书籍 / 标注 / 配置 / 统计的增量同步（对齐官方 `/api/sync`、`/api/sync/replicas` 契约）
- 书籍文件云存储（`/api/storage/*`）
- AI 翻译代理（DeepL / Yandex）、Edge TTS 朗读代理、Open Library 元数据搜索

后端可插拔：**SQLite ↔ PostgreSQL**，**本地磁盘 ↔ S3/MinIO**，切换**仅改环境变量**，无需改代码。

---

## 一键部署（Docker Compose）

```bash
cd readest-sync-server
cp .env.example .env
# 编辑 .env：至少填写 AUTH_CODE 与 JWT_SECRET
docker compose up -d --build
```

默认组合（`sqlite` + `local`）即可运行，访问 `http://localhost:8080`。

### 生产部署（PostgreSQL + MinIO）

编辑 `.env` 同时启用两个后端（需配套）：

```ini
METADATA_BACKEND=postgres
METADATA_DSN=postgres://readest:readest@postgres:5432/readest?sslmode=disable
STORAGE_KIND=s3
S3_ENDPOINT=http://minio:9000
S3_BUCKET=readest
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=us-east-1
S3_USE_PATH_STYLE=true
```

然后启动对应服务：

```bash
docker compose --profile postgres --profile minio up -d --build
```

> compose 通过 `env_file: .env` 注入变量；是否启动 postgres/minio 由 `--profile` 决定，后端类型仍由 `.env` 的 `METADATA_BACKEND`/`STORAGE_KIND` 决定，二者需配套。

---

## 本地快速启动（不用 Docker）

```bash
cd readest-sync-server
go mod tidy
AUTH_CODE=changeme JWT_SECRET=$(openssl rand -hex 32) go run .
```

`OPENSSL` 不可用也可用任意 32 字节十六进制串。

---

## 客户端改动（让自建服务端真正可用）

在 `apps/readest-app/` 开启自建模式：复制 `.env.server.example` 为 `.env.server`，设 `NEXT_PUBLIC_SELFHOSTED=1` 并配置 `NEXT_PUBLIC_API_BASE_URL`（指向本服务端，如 `https://sync.example.com`），然后 `pnpm dev-server` / `build-server` / `start-server` 启动。客户端会：

- 用邮箱/密码框作为「登录码」调用 `POST /api/auth` 拿 JWT；
- token 存 `localStorage['token']`，`sub` 作为用户标识；
- 同步/存储/代理请求自动带上 `Authorization: Bearer <jwt>`；
- 不依赖 Supabase（官方 Supabase 路径在 `NEXT_PUBLIC_SELFHOSTED != 1` 时完整保留）。

涉及文件：`src/services/selfhostedAuth.ts`、`src/utils/supabase.ts`、`src/utils/access.ts`、`src/helpers/auth.ts`、`src/app/auth/components/EmailPasswordAuth.tsx`。

---

## API 契约摘要

除 `/api/auth` 外，所有端点需在头带 `Authorization: Bearer <jwt>`。

| 端点 | 说明 |
|------|------|
| `POST /api/auth` | `{code}` → `{access_token, token_type}` |
| `GET/POST /api/sync` | 增量拉取 / 推送（books/notes/configs/stats） |
| `GET/POST /api/sync/replicas` | replica 拉取 / 推送 / 批量游标 |
| `GET/POST/DELETE /api/sync/replica-keys` | 加密 salt 信封管理 |
| `POST /api/storage/upload` | 申请上传 URL |
| `GET/POST /api/storage/download` | 单文件 / 批量下载 URL |
| `GET/DELETE /api/storage/list` `/stats` `/delete` `/purge` | 文件管理 |
| `PUT/GET /api/storage/blob/*` | 实际上传/下载文件本体 |
| `POST /api/deepl/translate` | DeepL 翻译（含 mock 降级） |
| `POST /api/yandex-translate` | Yandex 免费翻译 |
| `GET/POST /api/tts/edge` | Edge TTS 朗读（列 voices / 合成音频） |
| `GET /api/metadata/search` | Open Library 元数据搜索 |

错误响应体：`{ "error": "...", "code": "AUTH|QUOTA_EXCEEDED|CLOCK_SKEW|VALIDATION|SERVER" }`。

---

## 构建

```bash
go build -o readest-sync .   # CGO 已关闭，modernc/sqlite 纯 Go，镜像可移植
```

---

## 许可证

本项目以 **AGPL-3.0** 发布。服务端为独立实现，不含 Readest 原代码。若你修改客户端并对外提供联网服务，须按 AGPL-3.0 开源你的修改。详见 `LICENSE` 与 `NOTICE`。
