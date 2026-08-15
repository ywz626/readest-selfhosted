# Readest 自建云同步服务端 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现一个兼容 Readest 客户端的自建云同步服务端（Go 单二进制），支持「写死一个码登录 + 书籍/标注/配置/统计的跨设备增量同步 + 书籍文件云存储 + AI 翻译与 TTS 代理」，自用阶段零外部依赖（SQLite + 本地磁盘），并预留 PostgreSQL / S3(MinIO) 可插拔后端以便开源。

**架构：** Go HTTP 服务，所有端点挂在 `/api` 前缀下（客户端 `getAPIBaseUrl()` 返回 `<base>/api`）。存储通过接口抽象：`MetadataStore`（SQLite 默认 / Postgres 可选）与 `FileStore`（本地磁盘默认 / S3 可选）。登录不依赖 Supabase：客户端改为调用自建 `/api/auth` 拿 JWT，服务端校验写死的码并签发带 `plan:"pro"` 的 JWT。同步协议严格对齐客户端既有契约（见下文「API 契约」）。

**技术栈：** Go 1.22+，`net/http`（或 `chi` 路由），`github.com/golang-jwt/jwt/v5`，`modernc.org/sqlite`（纯 Go SQLite，零 CGO），`github.com/google/uuid`，可选 `github.com/jackc/pgx/v5`（Postgres）、`github.com/minio/minio-go/v7`（S3/MinIO）。测试用标准 `testing` + `net/http/httptest`。

---

## 范围与子系统拆分

本计划覆盖一个完整可运行的服务端 + 客户端最小改动。拆分为以下可独立测试的子计划，每个任务结束都有可运行/可测的交付物：

1. **服务端脚手架与配置**（任务 1-3）
2. **认证：写死码登录 + JWT**（任务 4-6）
3. **存储抽象层**（任务 7-10）
4. **同步 API：`/sync` 与 `/sync/replicas`、`/sync/replica-keys`**（任务 11-16）
5. **文件存储 API：`/storage/*`**（任务 17-20）
6. **代理类端点：翻译 + TTS + 元数据**（任务 21-23）
7. **客户端改动**（任务 24-27）
8. **端到端联调与文档**（任务 28-30）

---

## API 契约（必须严格对齐，来自源码 reverse）

### 通用
- 所有请求（除 `/auth`）需在头带 `Authorization: Bearer <jwt>`。
- 错误响应体：`{ "error": "message", "code": "AUTH|QUOTA_EXCEEDED|CLOCK_SKEW|VALIDATION|SERVER" }`。
- 状态码约定：`401/403`→AUTH，`402/507`→QUOTA_EXCEEDED，`409`→CLOCK_SKEW，`413/422`→VALIDATION，`>=500`→SERVER。

### 认证
- `POST /api/auth`  body: `{ "code": "<string>" }`
  - 成功：`{ "access_token": "<jwt>", "token_type": "bearer" }`
  - 失败：`401 { "error": "invalid code" }`
- JWT payload（HS256）：`{ "sub": "owner", "plan": "pro", "exp": <unix秒，+10年> }`
- 客户端 `getSubscriptionPlan` 用 `jwtDecode` 读 `plan` 字段决定是否限配额；`plan:"pro"` 即不限。

### 同步主接口 `/api/sync`
来自 `apps/readest-app/src/libs/sync.ts`：
- `GET /api/sync?since=<epochMs>&type=<books|configs|notes|stats>&book=<hash>&meta_hash=<hash>&limit=<n>`
  - 响应：`{ "books": BookRecord[]|null, "notes": BookNoteRecord[]|null, "configs": BookConfigRecord[]|null, "statBooks": StatBookRecord[]|null, "statPages": StatPageRecord[]|null }`
  - `since` 为 epoch 毫秒；增量返回 `updated_at > since` 且未删除的记录（`deleted_at` 非 null 表示已删，仍需下发以便客户端清理）。
  - `type=books` 时按 `synced_at`(ISO) 升序分页，`limit` 控制每页，`since` 对应 `synced_at` 游标；末尾 tie-completion（同 `synced_at` 全部返回）。
- `POST /api/sync`  body: `{ "books"?: Partial<BookRecord>[], "notes"?: Partial<BookNoteRecord>[], "configs"?: Partial<BookConfigRecord>[], "statBooks"?: StatBookRecord[], "statPages"?: StatPageRecord[] }`
  - 语义：last-writer-wins（服务端用请求里的 `updated_at` 比较）。
  - 成功：`200/201`，返回相同结构的当前服务端状态（用于回写 `synced_at` 等）。

`BookDataRecord`（`apps/readest-app/src/types/book.ts:567`）：
```
{ id: string; book_hash: string; meta_hash?: string; user_id: string;
  updated_at: number|null; deleted_at: number|null; synced_at?: string|null;
  uploaded_at?: string|null; ...业务字段 }
```
服务端需为每条 book 记录维护 `synced_at`（ISO 字符串，写入时 `now()`），用于分页游标。

### Replica 接口 `/api/sync/replicas` 与 `/api/sync/replica-keys`
来自 `apps/readest-app/src/libs/replicaSyncClient.ts` 与 `apps/readest-app/src/types/replica.ts:27`：
- `ReplicaRow`：`{ user_id, kind, replica_id, fields_jsonb: Record<string, {v,t,s}>, manifest_jsonb: {files:[{filename,byteSize,partialMd5}],schemaVersion} | null, deleted_at_ts: Hlc|null, reincarnation: string|null, updated_at_ts: Hlc, schema_version: number }`
- `Hlc`：字符串，形如 `"0000000000064-00000000-dev-a"`（逻辑时钟，`since` 游标用它）。
- `GET /api/sync/replicas?kind=<kind>&since=<Hlc|null>` → `{ "rows": ReplicaRow[] }`；`404` 视为空 `[]`。
- `POST /api/sync/replicas` body `{ "rows": ReplicaRow[] }` → `{ "rows": ReplicaRow[] }`（回显服务端落库后的行）。
- `POST /api/sync/replicas` body `{ "cursors": [{kind, since}] }` → `{ "results": [{kind, rows: ReplicaRow[]}] }`（批量拉取）。
- `GET /api/sync/replica-keys` → `{ "rows": [{ saltId, alg, salt, createdAt }] }`
- `POST /api/sync/replica-keys` body `{ "alg": "<string>" }` → `{ "row": { saltId, alg, salt, createdAt } }`
- `DELETE /api/sync/replica-keys` → `204`（清空该用户所有 salt 与加密信封）。

### 文件存储 `/api/storage/*`
来自 `apps/readest-app/src/libs/storage.ts`：
- `POST /api/storage/upload` body `{ fileName, fileSize, bookHash?, replicaKind?, replicaId?, temp?, media? }` → `{ "uploadUrl": "<presigned或本地PUT URL>", "downloadUrl"?: "<string>" }`
  - 客户端拿到 `uploadUrl` 后用 `PUT` 上传文件本体（本地磁盘后端直接返回本服务的 `PUT /api/storage/blob/<key>` 地址）。
- `GET /api/storage/download?fileKey=<userId>/<path>` → `{ "downloadUrl": "<URL>" }`（单文件）。
- `POST /api/storage/download` body `{ "fileKeys": ["<userId>/<path>", ...] }` → `{ "downloadUrls": { "<userId>/<path>": "<URL>" } }`（批量）。
- `GET /api/storage/list?page&pageSize&sortBy&sortOrder&bookHash&search` → `{ "files": FileRecord[], "total", "page", "pageSize", "totalPages" }`
  - `FileRecord`: `{ file_key, file_size, book_hash|null, replica_kind|null, replica_id|null, created_at, updated_at|null }`
- `DELETE /api/storage/delete?fileKey=<userId>/<path>` → `200`
- `GET /api/storage/stats` → `{ "totalFiles", "totalSize", "usage", "quota", "usagePercentage", "byBookHash": [{bookHash|null,fileCount,totalSize}] }`
  - 自建服务端对自用 `quota` 设一个很大的值（如 `1<<60`），`usagePercentage` 据此计算。
- `DELETE /api/storage/purge` body `{ "fileKeys": [...] }` → `{ "success":[], "failed":[{fileKey,error}], "deletedCount", "failedCount" }`

### 代理端点
- `POST /api/deepl/translate` body `{ text: string[], source_lang?, target_lang, use_cache? }`，带 `Authorization: Bearer <jwt>`（复用同一 JWT）→ 转发到配置的 DeepL endpoint（或返回 mock）；成功返回 `{ "translations": [{ text, daily_usage? }] }`。
- `POST /api/yandex-translate?endpoint=session|translate` → 转发到 `https://translate.yandex.net/api/v1/tr.json/translate`（免费，公开 endpoint）。
- `GET|POST /api/tts/edge` → Microsoft Edge TTS 代理（免费，无密钥）。`GET` 列可用 voices；`POST` 接收 SSML/文本与 voice 参数，流式返回音频。
- `GET /api/metadata/search?q=<isbn/title>` → 可选，转发到 Google Books / Open Library，返回书籍元数据。

---

## 文件结构

```
readest-sync-server/                 # 新建独立 Go module（不放入 readest 仓库根，避免混淆）
├── go.mod
├── main.go                          # 启动、路由装配、配置加载
├── config.yaml / config.go          # 配置：监听端口、auth code、JWT secret、存储后端选择、各代理 endpoint
├── internal/
│   ├── auth/
│   │   ├── auth.go                  # AuthService：校验 code、签发/校验 JWT
│   │   └── auth_test.go
│   ├── store/
│   │   ├── metadata.go              # MetadataStore 接口 + 工厂
│   │   ├── sqlite.go                # SQLite 实现（默认）
│   │   ├── sqlite_test.go
│   │   ├── postgres.go              # Postgres 实现（开源生产用，占位+实现）
│   │   ├── postgres_test.go
│   │   ├── filestore.go             # FileStore 接口 + 工厂
│   │   ├── localdisk.go             # 本地磁盘实现（默认）
│   │   ├── localdisk_test.go
│   │   ├── s3.go                    # S3/MinIO 实现（可选）
│   │   └── s3_test.go
│   ├── sync/
│   │   ├── sync.go                  # /sync 路由 handler
│   │   ├── sync_test.go
│   │   ├── replica.go               # /sync/replicas + /sync/replica-keys handler
│   │   ├── replica_test.go
│   │   └── model.go                 # BookRecord/ReplicaRow 等类型与转换
│   ├── storage/
│   │   ├── storage.go               # /storage/* 路由 handler（含 presign/本地 PUT）
│   │   ├── storage_test.go
│   │   └── blob.go                  # PUT/GET blob 的实际读写（本地磁盘或 S3）
│   ├── proxy/
│   │   ├── translate.go             # /deepl/translate + /yandex-translate
│   │   ├── translate_test.go
│   │   ├── tts.go                   # /tts/edge
│   │   ├── tts_test.go
│   │   └── metadata.go              # /metadata/search（可选）
│   └── middleware/
│       ├── auth.go                  # Bearer 解析 + 注入 user_id（sub）
│       └── auth_test.go
├── data/                            # 运行时：SQLite 文件 + 上传文件目录（gitignore，Docker 卷挂载）
├── Dockerfile                       # 多阶段构建，CGO_ENABLED=0
├── docker-compose.yml               # 默认 sqlite+local；postgres/minio 用 profiles 按需启用
├── .dockerignore
├── .env.example                     # 所有配置项（含 sqlite/local 与 postgres/s3 两种组合注释）
└── README.md                        # 部署、配置、客户端改法、开源声明

客户端改动（在 readest 仓库内，任务 17 实施）：
├── apps/readest-app/src/services/selfhostedAuth.ts        # 新增：登录 fetch + JWT sub 解析
├── apps/readest-app/src/utils/supabase.ts                # 加 SELFHOSTED 开关
├── apps/readest-app/src/utils/access.ts                 # getAccessToken/getUserID/validateUserAndToken 改走自建 token
├── apps/readest-app/src/helpers/auth.ts                 # handleAuthCallback 自建分支
├── apps/readest-app/src/app/auth/components/EmailPasswordAuth.tsx  # 登录码输入替代邮箱密码
└── apps/readest-app/.env.example                        # NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_SELFHOSTED
```

设计要点：
- 所有 handler 不直接依赖具体存储实现，只依赖 `MetadataStore` / `FileStore` 接口 → 自用(SQLite+磁盘)与开源(Postgres+S3)切换只改配置。
- `middleware/auth.go` 统一解析 JWT，把 `sub`（用户标识）注入 `context`，下游 handler 用 `userID` 隔离数据。

---

## 任务列表

### 任务 1：Go module 脚手架与配置

**文件：**
- 创建：`readest-sync-server/go.mod`
- 创建：`readest-sync-server/config.go`
- 创建：`readest-sync-server/main.go`（最小可启动）
- 创建：`readest-sync-server/data/.gitkeep`
- 创建：`readest-sync-server/.gitignore`

- [ ] **步骤 1：初始化 module 与最小 main**

`go.mod`：
```
module readestsync

go 1.22

require (
	github.com/golang-jwt/jwt/v5 v5.2.1
	modernc.org/sqlite v1.29.0
)
```

`config.go`：所有配置**运行时从环境变量读取**（支持 `.env` 文件，用 `github.com/joho/godotenv`），不依赖编译期或 yaml 文件。Docker 部署时由 `docker-compose` 把 `.env` 注入容器。后端选择靠两个枚举变量，用户无需改代码：
- `METADATA_BACKEND`：`sqlite`（默认，单文件零依赖）或 `postgres`
- `STORAGE_KIND`：`local`（默认，本地磁盘）或 `s3`（MinIO/S3/R2）

```go
package main

type Config struct {
	ListenAddr      string
	AuthCode        string
	JWTSecret       string
	MetadataBackend string // "sqlite" | "postgres"
	MetadataDSN     string // sqlite 文件路径 或 postgres URL
	StorageKind     string // "local" | "s3"
	LocalRoot       string
	S3Endpoint      string
	S3Bucket        string
	S3AccessKey     string
	S3SecretKey     string
	S3Region        string
	S3UsePathStyle  bool // MinIO 需要 true
	QuotaBytes      int64
}

func LoadConfig() Config {
	godotenv.Load() // 可选 .env，不存在则忽略
	get := func(key, def string) string {
		if v := os.Getenv(key); v != "" { return v }
		return def
	}
	cfg := Config{
		ListenAddr:      get("LISTEN_ADDR", ":8080"),
		AuthCode:        get("AUTH_CODE", "changeme"),
		JWTSecret:       get("JWT_SECRET", ""),
		MetadataBackend: get("METADATA_BACKEND", "sqlite"),
		MetadataDSN:     get("METADATA_DSN", "file:./data/readest.db"),
		StorageKind:     get("STORAGE_KIND", "local"),
		LocalRoot:       get("LOCAL_ROOT", "./data/files"),
		S3Endpoint:      get("S3_ENDPOINT", ""),
		S3Bucket:        get("S3_BUCKET", ""),
		S3AccessKey:     get("S3_ACCESS_KEY", ""),
		S3SecretKey:     get("S3_SECRET_KEY", ""),
		S3Region:        get("S3_REGION", "us-east-1"),
		S3UsePathStyle:  get("S3_USE_PATH_STYLE", "false") == "true",
	}
	if cfg.JWTSecret == "" {
		cfg.JWTSecret = randomHex(32) // 启动时生成并打印警告：每次重启 token 失效
	}
	if cfg.QuotaBytes == 0 {
		cfg.QuotaBytes = 1 << 60
	}
	return cfg
}
```

> 注意：`AUTH_CODE` 与 `JWT_SECRET` 必须由用户在 `.env` 中设置（至少 `JWT_SECRET` 要固定，否则重启后旧 token 失效需重新登录）。`docker-compose` 默认从 `.env` 读取并传给容器。

`main.go`：
```go
package main

func main() {
	cfg := LoadConfig("config.yaml")
	_ = cfg
	// TODO(任务末): 装配路由后 http.ListenAndServe
}
```

- [ ] **步骤 2：运行验证编译通过**

运行：`cd readest-sync-server && go build ./...`
预期：编译成功，无报错。

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/go.mod readest-sync-server/config.go readest-sync-server/main.go readest-sync-server/.gitignore
git commit -m "chore: scaffold Go module and config for Readest sync server"
```
（注：本计划在 readest 仓库内新增 `readest-sync-server/` 子目录；若希望独立仓库，后续可拆分。）

---

### 任务 2：路由装配骨架（先返回 501）

**文件：**
- 修改：`readest-sync-server/main.go`

- [ ] **步骤 1：用标准库 mux 装配所有路由路径，handler 先返回 501**

```go
package main

import (
	"net/http"
	"github.com/go-chi/chi/v5" // 若不想引入，可用 net/http ServeMux；此处用 chi 便于路径参数
)

func main() {
	cfg := LoadConfig("config.yaml")
	r := chi.NewRouter()
	r.Post("/api/auth", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/sync", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/sync", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/sync/replicas", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/sync/replicas", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/sync/replica-keys", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/sync/replica-keys", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Delete("/api/sync/replica-keys", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/storage/upload", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/storage/download", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/storage/download", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/storage/list", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Delete("/api/storage/delete", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/storage/stats", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Delete("/api/storage/purge", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/deepl/translate", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Post("/api/yandex-translate", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.HandleFunc("/api/tts/edge", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })
	r.Get("/api/metadata/search", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "not implemented", 501) })

	_ = http.ListenAndServe(cfg.ListenAddr, r)
}
```
（若用 chi，需在 go.mod 增加 `github.com/go-chi/chi/v5 v5.0.12`。也可用标准库 `http.ServeMux` + `HandleFunc` 去掉该依赖，路径查询参数自行解析。）

- [ ] **步骤 2：运行验证启动并 curl 任一路径返回 501**

运行：`cd readest-sync-server && go run . &` 然后 `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/sync`
预期：输出 `501`。

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/main.go go.mod
git commit -m "chore: wire all API routes returning 501 placeholder"
```

---

### 任务 3：数据存储接口与 SQLite schema

**文件：**
- 创建：`readest-sync-server/internal/store/metadata.go`
- 创建：`readest-sync-server/internal/store/sqlite.go`
- 创建：`readest-sync-server/internal/store/sqlite_test.go`
- 创建：`readest-sync-server/internal/store/filestore.go`
- 创建：`readest-sync-server/internal/store/localdisk.go`
- 创建：`readest-sync-server/internal/store/localdisk_test.go`

- [ ] **步骤 1：定义 MetadataStore 与 FileStore 接口（先不实现）**

`metadata.go`：
```go
package store

import "context"

type BookRow struct {
	ID        string
	UserID    string
	BookHash  string
	MetaHash  string
	UpdatedAt *int64  // epoch ms
	DeletedAt *int64
	SyncedAt  string  // ISO
	Data      []byte  // JSON of full BookRecord
}

type ReplicaRow struct {
	UserID       string
	Kind         string
	ReplicaID    string
	FieldsJSONB  []byte
	ManifestJSONB []byte
	DeletedAtTS  *string // Hlc
	Reincarnation *string
	UpdatedAtTS  string  // Hlc
	SchemaVersion int
}

type StatBookRow struct { UserID string; BookHash string; Title string; Authors string; UpdatedAtMs *int64; DeletedAt *int64 }
type StatPageRow struct { UserID string; BookHash string; Page int; StartTime int64; Duration int64; TotalPages int; UpdatedAtMs *int64; DeletedAt *int64 }

type MetadataStore interface {
	UpsertBook(ctx context.Context, b BookRow) error
	PullBooks(ctx context.Context, userID string, sinceISO string, limit int) ([]BookRow, error)
	UpsertNote(ctx context.Context, userID, data []byte) error
	PullNotes(ctx context.Context, userID string, sinceMs int64) ([][]byte, error)
	UpsertConfig(ctx context.Context, userID, data []byte) error
	PullConfigs(ctx context.Context, userID string, sinceMs int64) ([][]byte, error)
	UpsertStatBooks(ctx context.Context, rows []StatBookRow) error
	PullStatBooks(ctx context.Context, userID string, sinceMs int64) ([]StatBookRow, error)
	UpsertStatPages(ctx context.Context, rows []StatPageRow) error
	PullStatPages(ctx context.Context, userID string, sinceMs int64) ([]StatPageRow, error)
	UpsertReplica(ctx context.Context, r ReplicaRow) error
	PullReplicas(ctx context.Context, userID, kind string, sinceHlc *string) ([]ReplicaRow, error)
	PullReplicasBatch(ctx context.Context, userID string, cursors []ReplicaCursor) (map[string][]ReplicaRow, error)
	UpsertReplicaKey(ctx context.Context, userID, alg, saltID, salt string) error
	ListReplicaKeys(ctx context.Context, userID string) ([]ReplicaKeyRow, error)
	DeleteReplicaKeys(ctx context.Context, userID string) error
}
```

`filestore.go`：
```go
package store

import "io"

type FileStore interface {
	Put(ctx context.Context, key string, r io.Reader, size int64) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	// PresignedURL returns a URL the client can PUT/GET directly (for S3). For local, returns a local blob route.
	UploadURL(key string) string
	DownloadURL(key string) string
	List(prefix string) ([]FileMeta, error)
}

type FileMeta struct {
	Key        string
	Size       int64
	BookHash   *string
	UpdatedAt  string
}

type ReplicaCursor struct { Kind string; Since *string }
type ReplicaKeyRow struct { SaltID string; Alg string; Salt string; CreatedAt string }
```

- [ ] **步骤 2：写失败的 SQLite 测试**

`sqlite_test.go`：
```go
package store

import (
	"context"
	"testing"
)

func TestSqliteUpsertPullBook(t *testing.T) {
	s, err := NewSqliteStore(":memory:")
	if err != nil { t.Fatal(err) }
	ctx := context.Background()
	now := int64(1000)
	b := BookRow{ID: "1", UserID: "owner", BookHash: "h1", UpdatedAt: &now, SyncedAt: "2024-01-01T00:00:00Z", Data: []byte(`{"id":"1"}`)}
	if err := s.UpsertBook(ctx, b); err != nil { t.Fatal(err) }
	rows, err := s.PullBooks(ctx, "owner", "", 100)
	if err != nil { t.Fatal(err) }
	if len(rows) != 1 { t.Fatalf("want 1 got %d", len(rows)) }
}
```

`localdisk_test.go`：
```go
package store

import (
	"bytes"
	"context"
	"io"
	"testing"
)

func TestLocalDiskPutGet(t *testing.T) {
	fs, err := NewLocalDiskStore(t.TempDir())
	if err != nil { t.Fatal(err) }
	ctx := context.Background()
	if err := fs.Put(ctx, "owner/books/h1.epub", bytes.NewReader([]byte("hello")), 5); err != nil { t.Fatal(err) }
	rc, err := fs.Get(ctx, "owner/books/h1.epub")
	if err != nil { t.Fatal(err) }
	defer rc.Close()
	data, _ := io.ReadAll(rc)
	if string(data) != "hello" { t.Fatalf("got %q", data) }
}
```

- [ ] **步骤 3：运行测试确认失败**

运行：`cd readest-sync-server && go test ./internal/store/`
预期：编译失败（`NewSqliteStore` / `NewLocalDiskStore` 未定义）。

- [ ] **步骤 4：实现 SQLite 与本地磁盘存储**

`sqlite.go` 关键实现（CREATE TABLE + UpsertBook + PullBooks 按 synced_at 升序分页，含 tie-completion）：
```go
func NewSqliteStore(dsn string) (*SqliteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil { return nil, err }
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS books (
			id TEXT, user_id TEXT, book_hash TEXT, meta_hash TEXT,
			updated_at INTEGER, deleted_at INTEGER, synced_at TEXT, data TEXT,
			PRIMARY KEY (user_id, book_hash)
		);
		CREATE TABLE IF NOT EXISTS notes (user_id TEXT, note_id TEXT, updated_at INTEGER, deleted_at INTEGER, data TEXT, PRIMARY KEY(user_id, note_id));
		CREATE TABLE IF NOT EXISTS configs (user_id TEXT, config_id TEXT, updated_at INTEGER, data TEXT, PRIMARY KEY(user_id, config_id));
		CREATE TABLE IF NOT EXISTS stat_books (user_id TEXT, book_hash TEXT, title TEXT, authors TEXT, updated_at_ms INTEGER, deleted_at INTEGER, PRIMARY KEY(user_id, book_hash));
		CREATE TABLE IF NOT EXISTS stat_pages (user_id TEXT, book_hash TEXT, page INTEGER, start_time INTEGER, duration INTEGER, total_pages INTEGER, updated_at_ms INTEGER, deleted_at INTEGER, PRIMARY KEY(user_id, book_hash, page));
		CREATE TABLE IF NOT EXISTS replicas (user_id TEXT, kind TEXT, replica_id TEXT, fields_jsonb TEXT, manifest_jsonb TEXT, deleted_at_ts TEXT, reincarnation TEXT, updated_at_ts TEXT, schema_version INTEGER, PRIMARY KEY(user_id, kind, replica_id));
		CREATE TABLE IF NOT EXISTS replica_keys (user_id TEXT, salt_id TEXT, alg TEXT, salt TEXT, created_at TEXT, PRIMARY KEY(user_id, salt_id));
	`)
	if err != nil { return nil, err }
	return &SqliteStore{db: db}, nil
}

func (s *SqliteStore) UpsertBook(ctx context.Context, b BookRow) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO books (id,user_id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id,book_hash) DO UPDATE SET
			id=excluded.id, meta_hash=excluded.meta_hash, updated_at=excluded.updated_at,
			deleted_at=excluded.deleted_at, synced_at=excluded.synced_at, data=excluded.data`,
		b.ID, b.UserID, b.BookHash, b.MetaHash, b.UpdatedAt, b.DeletedAt, b.SyncedAt, string(b.Data))
	return err
}

func (s *SqliteStore) PullBooks(ctx context.Context, userID, sinceISO string, limit int) ([]BookRow, error) {
	// 分页：synced_at > sinceISO 升序；末尾 tie-completion（同 synced_at 全取）
	since := sinceISO
	if since == "" { since = "0001-01-01T00:00:00Z" }
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books
		WHERE user_id=? AND synced_at > ? ORDER BY synced_at ASC LIMIT ?`, userID, since, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []BookRow
	for rows.Next() {
		var b BookRow
		var data string
		if err := rows.Scan(&b.ID, &b.BookHash, &b.MetaHash, &b.UpdatedAt, &b.DeletedAt, &b.SyncedAt, &data); err != nil { return nil, err }
		b.Data = []byte(data); b.UserID = userID
		out = append(out, b)
	}
	// tie-completion: 取最后一页末尾 synced_at 的所有并列行
	if len(out) > 0 {
		tail := out[len(out)-1].SyncedAt
		tie, err := s.db.QueryContext(ctx, `SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books WHERE user_id=? AND synced_at=?`, userID, tail)
		if err != nil { return nil, err }
		defer tie.Close()
		for tie.Next() {
			var b BookRow; var data string
			tie.Scan(&b.ID, &b.BookHash, &b.MetaHash, &b.UpdatedAt, &b.DeletedAt, &b.SyncedAt, &data)
			b.Data = []byte(data); b.UserID = userID
			// 去重
			dup := false
			for _, e := range out { if e.BookHash == b.BookHash { dup = true; break } }
			if !dup { out = append(out, b) }
		}
	}
	return out, nil
}
```
其余接口（notes/configs/stats/replicas/replica_keys）按同样 upsert + 按游标 pull 模式实现（last-writer-wins 用 `updated_at`/`updated_at_ts` 比较后再写）。

`localdisk.go`：
```go
func NewLocalDiskStore(root string) (*LocalDiskStore, error) {
	if err := os.MkdirAll(root, 0o755); err != nil { return nil, err }
	return &LocalDiskStore{root: root}, nil
}
func (f *LocalDiskStore) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	p := filepath.Join(f.root, filepath.Clean(key))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil { return err }
	out, err := os.Create(p); if err != nil { return err }
	defer out.Close()
	_, err = io.Copy(out, r); return err
}
// Get/Delete 类似；UploadURL/DownloadURL 返回相对本服务的 /api/storage/blob/<key>
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd readest-sync-server && go test ./internal/store/`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add readest-sync-server/internal/store/
git commit -m "feat: implement MetadataStore (SQLite) and FileStore (local disk)"
```

---

### 任务 4：认证服务（写死码 + JWT 签发）

**文件：**
- 创建：`readest-sync-server/internal/auth/auth.go`
- 创建：`readest-sync-server/internal/auth/auth_test.go`

- [ ] **步骤 1：写失败测试**

`auth_test.go`：
```go
package auth

import "testing"

func TestIssueAndVerify(t *testing.T) {
	svc := NewService("secret123", "topsecret")
	tok, err := svc.IssueToken("owner")
	if err != nil { t.Fatal(err) }
	claims, err := svc.VerifyToken(tok)
	if err != nil { t.Fatal(err) }
	if claims.Subject != "owner" { t.Fatalf("sub=%s", claims.Subject) }
	if claims.Plan != "pro" { t.Fatalf("plan=%s", claims.Plan) }
}

func TestCheckCode(t *testing.T) {
	svc := NewService("secret123", "topsecret")
	if !svc.CheckCode("topsecret") { t.Fatal("valid code rejected") }
	if svc.CheckCode("wrong") { t.Fatal("invalid code accepted") }
}
```

- [ ] **步骤 2：运行确认失败**

运行：`cd readest-sync-server && go test ./internal/auth/`
预期：编译失败（`NewService` 未定义）。

- [ ] **步骤 3：实现**

`auth.go`：
```go
package auth

import (
	"errors"
	"time"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	jwt.RegisteredClaims
	Plan string `json:"plan"`
}

type Service struct {
	jwtSecret []byte
	authCode  string
}

func NewService(authCode, jwtSecret string) *Service {
	return &Service{authCode: authCode, jwtSecret: []byte(jwtSecret)}
}

func (s *Service) CheckCode(code string) bool { return code == s.authCode }

func (s *Service) IssueToken(sub string) (string, error) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * 365 * 24 * time.Hour)),
		},
		Plan: "pro",
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *Service) VerifyToken(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok { return nil, errors.New("unexpected alg") }
		return s.jwtSecret, nil
	})
	if err != nil { return nil, err }
	c, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid { return nil, errors.New("invalid token") }
	return c, nil
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd readest-sync-server && go test ./internal/auth/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/auth/
git commit -m "feat: auth service with static code check and JWT issue/verify"
```

---

### 任务 5：Auth 中间件（Bearer 解析 + user_id 注入）

**文件：**
- 创建：`readest-sync-server/internal/middleware/auth.go`
- 创建：`readest-sync-server/internal/middleware/auth_test.go`

- [ ] **步骤 1：写失败测试**

`auth_test.go`：
```go
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"readestsync/internal/auth"
)

func TestRequireAuth(t *testing.T) {
	svc := auth.NewService("code", "secret")
	valid, _ := svc.IssueToken("owner")
	handler := RequireAuth(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := r.Context().Value(userKey{}).(string)
		w.Write([]byte(uid))
	}))
	// 无 token → 401
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != 401 { t.Fatalf("no token should 401, got %d", rec.Code) }
	// 有 token → 200 + owner
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+valid)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req)
	if rec2.Code != 200 || rec2.Body.String() != "owner" { t.Fatalf("got %d %q", rec2.Code, rec2.Body.String()) }
}
```

- [ ] **步骤 2：运行确认失败**

运行：`cd readest-sync-server && go test ./internal/middleware/`
预期：编译失败。

- [ ] **步骤 3：实现中间件**

`auth.go`：
```go
package middleware

import (
	"context"
	"net/http"
	"strings"
	"readestsync/internal/auth"
)

type ctxKey struct{}

var userKey ctxKey = struct{}{}

func RequireAuth(svc *auth.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		if !strings.HasPrefix(raw, "Bearer ") { http.Error(w, `{"error":"missing token"}`, 401); return }
		claims, err := svc.VerifyToken(strings.TrimPrefix(raw, "Bearer "))
		if err != nil { http.Error(w, `{"error":"invalid token"}`, 401); return }
		ctx := context.WithValue(r.Context(), userKey{}, claims.Subject)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func UserID(r *http.Request) string {
	if v, ok := r.Context().Value(userKey{}).(string); ok { return v }
	return ""
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd readest-sync-server && go test ./internal/middleware/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/middleware/
git commit -m "feat: Bearer auth middleware injecting user_id into context"
```

---

### 任务 6：实现 `/api/auth` 登录端点

**文件：**
- 修改：`readest-sync-server/main.go`（接入 auth 路由）
- 修改：`readest-sync-server/internal/auth/auth.go` 增加 `Login` handler 函数（或新建 `internal/auth/handler.go`）

- [ ] **步骤 1：写失败测试（httptest 调 /api/auth）**

新建 `readest-sync-server/internal/auth/handler_test.go`：
```go
package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthHandler(t *testing.T) {
	svc := NewService("code", "secret")
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { LoginHandler(svc, w, r) })

	// 正确码
	body, _ := json.Marshal(map[string]string{"code": "code"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body)))
	if rec.Code != 200 { t.Fatalf("want 200 got %d", rec.Code) }
	var resp struct{ AccessToken string `json:"access_token"` }
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.AccessToken == "" { t.Fatal("empty token") }

	// 错误码
	body2, _ := json.Marshal(map[string]string{"code": "x"})
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body2)))
	if rec2.Code != 401 { t.Fatalf("want 401 got %d", rec2.Code) }
}
```

- [ ] **步骤 2：运行确认失败**

运行：`cd readest-sync-server && go test ./internal/auth/ -run TestAuthHandler`
预期：编译失败（`LoginHandler` 未定义）。

- [ ] **步骤 3：实现 LoginHandler**

```go
func LoginHandler(svc *Service, w http.ResponseWriter, r *http.Request) {
	var req struct{ Code string `json:"code"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad request"}`, 400); return
	}
	if !svc.CheckCode(req.Code) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401); w.Write([]byte(`{"error":"invalid code"}`)); return
	}
	tok, err := svc.IssueToken("owner")
	if err != nil { http.Error(w, `{"error":"internal"}`, 500); return }
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"access_token": tok, "token_type": "bearer"})
}
```

- [ ] **步骤 4：接到 main.go 路由（替换占位）**

`main.go` 中：
```go
r.Post("/api/auth", func(w http.ResponseWriter, r *http.Request) { auth.LoginHandler(authSvc, w, r) })
```
其中 `authSvc` 在 main 中 `auth.NewService(cfg.AuthCode, cfg.JWTSecret)` 创建。

- [ ] **步骤 5：运行集成验证**

运行：`cd readest-sync-server && go run . &`
`curl -s -X POST http://localhost:8080/api/auth -d '{"code":"changeme"}'`
预期：返回 `{"access_token":"...","token_type":"bearer"}`。

- [ ] **步骤 6：Commit**

```bash
git add readest-sync-server/internal/auth/ readest-sync-server/main.go
git commit -m "feat: implement /api/auth login endpoint"
```

---

### 任务 7：同步主接口 `/api/sync`（GET 拉取）

**文件：**
- 创建：`readest-sync-server/internal/sync/model.go`
- 创建：`readest-sync-server/internal/sync/sync.go`
- 创建：`readest-sync-server/internal/sync/sync_test.go`

- [ ] **步骤 1：定义响应模型与写失败测试**

`sync_test.go`（用 httptest + 内存 SQLite + 中间件注入）：
```go
package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"readestsync/internal/auth"
	"readestsync/internal/store"
)

func TestPullSince(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	now := int64(1000)
	ms.UpsertBook(context.Background(), store.BookRow{ID:"1",UserID:"owner",BookHash:"h1",UpdatedAt:&now,SyncedAt:"2024-01-01T00:00:01Z",Data:[]byte(`{"id":"1","book_hash":"h1"}`)})
	h := NewSyncHandler(ms)
	// 模拟已认证请求
	svc := auth.NewService("c","s")
	tok,_ := svc.IssueToken("owner")
	req := httptest.NewRequest("GET", "/api/sync?since=0&type=books", nil)
	req.Header.Set("Authorization","Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 { t.Fatalf("got %d", rec.Code) }
	var resp struct{ Books []json.RawMessage `json:"books"` }
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Books) != 1 { t.Fatalf("want 1 book got %d", len(resp.Books)) }
}
```

- [ ] **步骤 2：运行确认失败**

运行：`cd readest-sync-server && go test ./internal/sync/ -run TestPullSince`
预期：编译失败。

- [ ] **步骤 3：实现 model.go 与 sync.go GET**

`model.go`：定义 `SyncResult`、`BookRecord`（含额外服务端字段）、`StatBookRecord`、`StatPageRecord`，与客户端 `src/libs/sync.ts` 结构对齐。

`sync.go` 关键 GET 逻辑：
```go
func (h *SyncHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet: h.pull(w, r)
	case http.MethodPost: h.push(w, r)
	default: http.Error(w, "", 405)
	}
}

func (h *SyncHandler) pull(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	sinceMs, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	typ := r.URL.Query().Get("type")
	switch typ {
	case "books", "":
		rows, _ := h.ms.PullBooks(r.Context(), uid, isoFromMs(sinceMs), 1000)
		out := &SyncResult{Books: make([]json.RawMessage,0)}
		for _, b := range rows { out.Books = append(out.Books, json.RawMessage(b.Data)) }
		writeJSON(w, out)
	case "notes":
		rows, _ := h.ms.PullNotes(r.Context(), uid, sinceMs)
		out := &SyncResult{Notes: rawToNotes(rows)}
		writeJSON(w, out)
	case "configs":
		rows, _ := h.ms.PullConfigs(r.Context(), uid, sinceMs)
		out := &SyncResult{Configs: rawToConfigs(rows)}
		writeJSON(w, out)
	case "stats":
		sb, _ := h.ms.PullStatBooks(r.Context(), uid, sinceMs)
		sp, _ := h.ms.PullStatPages(r.Context(), uid, sinceMs)
		writeJSON(w, &SyncResult{StatBooks: sb, StatPages: sp})
	}
}
```
（`isoFromMs` 把 epoch ms 转 ISO；`writeJSON` 设 `Content-Type: application/json`。）

- [ ] **步骤 4：运行确认通过**

运行：`cd readest-sync-server && go test ./internal/sync/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/sync/
git commit -m "feat: implement GET /api/sync pull with incremental cursor"
```

---

### 任务 8：同步主接口 `/api/sync`（POST 推送）

**文件：**
- 修改：`readest-sync-server/internal/sync/sync.go`
- 修改：`readest-sync-server/internal/sync/sync_test.go`

- [ ] **步骤 1：写推送测试**

`sync_test.go` 增加：
```go
func TestPushBooks(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c","s"); tok,_ := svc.IssueToken("owner")
	body := `{"books":[{"id":"1","book_hash":"h1","user_id":"owner","updated_at":1000}]}`
	req := httptest.NewRequest("POST","/api/sync", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization","Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 { t.Fatalf("got %d", rec.Code) }
	// 再拉一次应拿到
	req2 := httptest.NewRequest("GET","/api/sync?since=0&type=books", nil)
	req2.Header.Set("Authorization","Bearer "+tok)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != 200 { t.Fatal("pull failed") }
}
```

- [ ] **步骤 2：运行确认失败（push 未实现）**

运行：`cd readest-sync-server && go test ./internal/sync/ -run TestPushBooks`
预期：push 返回 501 或 405（当前只实现了 GET 的 200/405）。

- [ ] **步骤 3：实现 push**

`push` 逻辑：解析 body 的 `books/notes/configs/statBooks/statPages`，对每条按 `user_id` 强制为当前 `uid`（防越权），用 `updated_at` 比较做 last-writer-wins（仅当新值更新或旧值不存在才写），写入 `synced_at = now()`。返回写入后的当前状态。

```go
func (h *SyncHandler) push(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var payload struct {
		Books     []json.RawMessage `json:"books"`
		Notes     []json.RawMessage `json:"notes"`
		Configs   []json.RawMessage `json:"configs"`
		StatBooks []store.StatBookRow `json:"statBooks"`
		StatPages []store.StatPageRow `json:"statPages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"error":"bad request"}`, 400); return
	}
	ctx := r.Context()
	for _, raw := range payload.Books {
		var b store.BookRow
		json.Unmarshal(raw, &b)
		b.UserID = uid
		if b.SyncedAt == "" { b.SyncedAt = time.Now().UTC().Format(time.RFC3339) }
		h.ms.UpsertBook(ctx, b)
	}
	for _, raw := range payload.Notes { var n store.NoteRow; json.Unmarshal(raw, &n); n.UserID = uid; h.ms.UpsertNote(ctx, uid, raw) }
	for _, raw := range payload.Configs { h.ms.UpsertConfig(ctx, uid, raw) }
	if len(payload.StatBooks) > 0 { h.ms.UpsertStatBooks(ctx, payload.StatBooks) }
	if len(payload.StatPages) > 0 { h.ms.UpsertStatPages(ctx, payload.StatPages) }
	writeJSON(w, map[string]string{})
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd readest-sync-server && go test ./internal/sync/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/sync/
git commit -m "feat: implement POST /api/sync push with last-writer-wins"
```

---

### 任务 9：Replica 接口 `/api/sync/replicas` 与 `/api/sync/replica-keys`

**文件：**
- 创建：`readest-sync-server/internal/sync/replica.go`
- 创建：`readest-sync-server/internal/sync/replica_test.go`

- [ ] **步骤 1：写失败测试（push/pull/replica-keys）**

`replica_test.go`：覆盖 POST rows 回显、GET since、POST cursors 批量、GET/POST/DELETE replica-keys。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 replica.go**

关键：
- `GET /replicas?kind=&since=`：调 `ms.PullReplicas(uid, kind, &since)`；`404`→`[]`。
- `POST /replicas`：若 body 有 `rows` → 逐条 `UpsertReplica`（按 `updated_at_ts` HLC 比较 last-writer-wins），返回 `{rows: 落库后行}`；若 body 有 `cursors` → `PullReplicasBatch`，返回 `{results:[{kind,rows}]}`。
- `GET /replica-keys` → `ListReplicaKeys`；`POST` → `UpsertReplicaKey`（生成随机 `saltID` 与 `salt`）；`DELETE` → `DeleteReplicaKeys`。
- HLC 比较：字符串按字典序比较即可（客户端 HLC 格式保证字典序即时间序）。

- [ ] **步骤 4：运行确认通过**

运行：`cd readest-sync-server && go test ./internal/sync/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/sync/replica.go readest-sync-server/internal/sync/replica_test.go
git commit -m "feat: implement /sync/replicas and /sync/replica-keys"
```

---

### 任务 10：装配 sync 路由到 main + 用中间件保护

**文件：**
- 修改：`readest-sync-server/main.go`

- [ ] **步骤 1：在 main 中创建 store 与 handler，并用 RequireAuth 包裹受保护路由**

```go
ms, _ := store.NewSqliteStore(cfg.MetadataDSN) // 或 Postgres（任务 13）
fs, _ := store.NewLocalDiskStore(cfg.LocalRoot)
authSvc := auth.NewService(cfg.AuthCode, cfg.JWTSecret)
syncH := sync.NewSyncHandler(ms)
replicaH := sync.NewReplicaHandler(ms)
storageH := storage.NewStorageHandler(ms, fs)

r.Post("/api/auth", func(w http.ResponseWriter, r *http.Request){ auth.LoginHandler(authSvc, w, r) })
r.Group(func(r chi.Router) {
	r.Use(func(next http.Handler) http.Handler { return middleware.RequireAuth(authSvc, next) })
	r.Get("/api/sync", syncH.ServeHTTP)
	r.Post("/api/sync", syncH.ServeHTTP)
	r.Get("/api/sync/replicas", replicaH.ServeHTTP)
	r.Post("/api/sync/replicas", replicaH.ServeHTTP)
	r.Get("/api/sync/replica-keys", replicaH.KeysGet)
	r.Post("/api/sync/replica-keys", replicaH.KeysPost)
	r.Delete("/api/sync/replica-keys", replicaH.KeysDelete)
	// storage 路由（任务 17）
})
```

- [ ] **步骤 2：运行验证受保护路由 401 / 带 token 200**

`curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/sync` → `401`
带 token → `200`。

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/main.go
git commit -m "feat: wire sync routes behind auth middleware"
```

---

### 任务 11：文件存储 API `/storage/*`（upload/list/stats/delete/purge）

**文件：**
- 创建：`readest-sync-server/internal/storage/storage.go`
- 创建：`readest-sync-server/internal/storage/storage_test.go`

- [ ] **步骤 1：写失败测试（upload 返回 uploadUrl，list 返回结构，stats 返回 quota）**

`storage_test.go`：用内存 SQLite + 本地 temp 目录，验证：
- POST upload 返回 `uploadUrl` 非空
- GET list 返回 `files` 数组与 `totalPages`
- GET stats 返回 `quota = cfg.QuotaBytes`
- DELETE delete 返回 200

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 storage.go**

关键点：
- `upload`：生成 `key = <uid>/<bookHash或replica>/<fileName>`，返回 `uploadUrl = fs.UploadURL(key)`（本地即 `/api/storage/blob/<key>`），可选 `downloadUrl`。
- `download`：单文件 `GET ?fileKey=` → `fs.DownloadURL`；批量 `POST {fileKeys}` → map。
- `list`：按查询参数分页（`page/pageSize/sortBy/sortOrder/bookHash/search`），调 `fs.List(uid + "/")` 后在内存过滤排序（自用规模足够；开源可下移 SQL/S3 list）。
- `stats`：`quota = cfg.QuotaBytes`，`usage = sum(file_size)`，`usagePercentage = usage/quota*100`。
- `delete` / `purge`：调 `fs.Delete`，返回成功/失败列表。

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/storage/
git commit -m "feat: implement /storage upload/list/stats/delete/purge"
```

---

### 任务 12：Blob 实际读写路由（本地 PUT/GET）

**文件：**
- 创建：`readest-sync-server/internal/storage/blob.go`
- 修改：`readest-sync-server/main.go`（注册 `/api/storage/blob/{key}`）

- [ ] **步骤 1：写失败测试（PUT 后 GET 拿到相同内容，且 key 隔离用户前缀）**

`blob_test.go`：用 httptest 模拟 PUT `/api/storage/blob/owner/books/h1.epub` 后 GET 同 key。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 blob.go**

```go
func (h *StorageHandler) BlobPut(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key") // 形如 owner/books/h1.epub
	uid := middleware.UserID(r)
	if !strings.HasPrefix(key, uid+"/") { http.Error(w, `{"error":"forbidden"}`, 403); return }
	if err := h.fs.Put(r.Context(), key, r.Body, r.ContentLength); err != nil {
		http.Error(w, `{"error":"put failed"}`, 500); return
	}
	w.WriteHeader(200)
}
func (h *StorageHandler) BlobGet(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	uid := middleware.UserID(r)
	if !strings.HasPrefix(key, uid+"/") { http.Error(w, "", 403); return }
	rc, err := h.fs.Get(r.Context(), key)
	if err != nil { http.Error(w, "", 404); return }
	defer rc.Close()
	io.Copy(w, rc)
}
```

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/storage/blob.go readest-sync-server/main.go
git commit -m "feat: implement blob PUT/GET with user-prefix isolation"
```

---

### 任务 13：Postgres 与 S3 后端（开源生产用）

**文件：**
- 创建：`readest-sync-server/internal/store/postgres.go`
- 创建：`readest-sync-server/internal/store/postgres_test.go`
- 创建：`readest-sync-server/internal/store/s3.go`
- 创建：`readest-sync-server/internal/store/s3_test.go`
- 修改：`readest-sync-server/internal/store/metadata.go` / `filestore.go`（增加工厂函数按配置选择）

- [ ] **步骤 1：写失败测试（Postgres 接口一致、S3 Put/Get）**

用接口断言：`var _ store.MetadataStore = (*PostgresStore)(nil)`，以及用 minio 容器或 mock 验证 S3。若本地无 Postgres/MinIO，至少做编译级断言 + 用接口 fakes 测试 handler 不依赖具体实现。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 PostgresStore（与 SQLite 同接口，SQL 改为 Postgres 语法 + pgx）与 S3Store（minio-go，PresignedURL 返回真实预签名 URL）**

- [ ] **步骤 4：增加工厂**

```go
func NewMetadataStore(cfg Config) (MetadataStore, error) {
	switch cfg.MetadataBackend {
	case "postgres":
		return NewPostgresStore(cfg.MetadataDSN)
	case "sqlite", "":
		dsn := cfg.MetadataDSN
		return NewSqliteStore(strings.TrimPrefix(dsn, "file:"))
	default:
		return nil, fmt.Errorf("unknown METADATA_BACKEND=%q", cfg.MetadataBackend)
	}
}
func NewFileStore(cfg Config) (FileStore, error) {
	switch cfg.StorageKind {
	case "s3":
		return NewS3Store(cfg)
	case "local", "":
		return NewLocalDiskStore(cfg.LocalRoot)
	default:
		return nil, fmt.Errorf("unknown STORAGE_KIND=%q", cfg.StorageKind)
	}
}
```

- [ ] **步骤 5：运行全部测试**

运行：`cd readest-sync-server && go test ./...`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add readest-sync-server/internal/store/
git commit -m "feat: add Postgres and S3 backends with factory selection"
```

---

### 任务 14：翻译代理 `/api/deepl/translate` 与 `/api/yandex-translate`

**文件：**
- 创建：`readest-sync-server/internal/proxy/translate.go`
- 创建：`readest-sync-server/internal/proxy/translate_test.go`

- [ ] **步骤 1：写失败测试（deepl 转发、yandex 转发结构正确）**

用 `httptest` 起一个 fake upstream，验证 handler 把请求正确转发并返回预期 JSON 形状 `{translations:[{text}]}`。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 translate.go**

- `/deepl/translate`：若配置了 `DEEPL_API_KEY` + endpoint，转发 `POST` 到 DeepL，透传 `text/source_lang/target_lang`，把响应 `translations` 原样返回；若未配置，返回 mock（如逐行回显或简单说明），保证客户端不报错。
- `/yandex-translate?endpoint=session|translate`：转发到 `https://translate.yandex.net/api/v1/tr.json/translate`，免费无需密钥。

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/proxy/translate.go readest-sync-server/internal/proxy/translate_test.go
git commit -m "feat: translation proxy (DeepL + Yandex)"
```

---

### 任务 15：TTS 代理 `/api/tts/edge`

**文件：**
- 创建：`readest-sync-server/internal/proxy/tts.go`
- 创建：`readest-sync-server/internal/proxy/tts_test.go`

- [ ] **步骤 1：写失败测试（GET 列 voices 返回 JSON 数组；POST 转发返回音频 content-type）**

用 fake upstream 模拟 Edge TTS websocket/HTTP，验证 handler 把 SSML/文本转成 Edge TTS 请求并返回 `audio/*`。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 tts.go**

Edge TTS 免费无密钥，但官方用 WebSocket。最简实现：依赖一个轻量 Edge TTS 库（如 `github.com/AlfredoRamos/edge-tts-go` 或自己实现 websocket 握手）。`GET` 返回可用 voice 列表；`POST` 接收 `{text, voice}` 或 SSML，流式返回音频字节。

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add readest-sync-server/internal/proxy/tts.go readest-sync-server/internal/proxy/tts_test.go
git commit -m "feat: Edge TTS proxy /api/tts/edge"
```

---

### 任务 16：元数据搜索代理 `/api/metadata/search`

**文件：**
- 创建：`readest-sync-server/internal/proxy/metadata.go`

- [ ] **步骤 1：实现 GET 转发到 Open Library（免费无需密钥）**

`https://openlibrary.org/search.json?q=<query>`，把相关字段（title/authors/cover）映射成客户端期望结构。

- [ ] **步骤 2：运行集成验证（curl 返回 JSON）**

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/internal/proxy/metadata.go
git commit -m "feat: metadata search proxy via Open Library"
```

---

### 任务 17：客户端改动 — 自建 auth（替换 Supabase 登录）

> 这是让自建服务端真正可用**必须**做的客户端改动（此前计划只写了契约，现补为实际代码任务）。改动集中在 4 个文件，全部位于 `apps/readest-app/`。**AGPL 义务**：若你对外发布联网使用的修改版客户端，须开源本改动（与上游一致 AGPL-3.0）。

**文件：**
- 修改：`apps/readest-app/src/utils/supabase.ts`
- 修改：`apps/readest-app/src/utils/access.ts`（行 154-185）
- 修改：`apps/readest-app/src/helpers/auth.ts`（行 43-91）
- 修改：`apps/readest-app/src/app/auth/components/EmailPasswordAuth.tsx`（行 94 附近）
- 新增：`apps/readest-app/src/services/selfhostedAuth.ts`（自建登录 fetch 封装）

设计：引入一个「自建模式」开关 `NEXT_PUBLIC_SELFHOSTED=1`。开启时全部走自建 `/api/auth`；关闭时保留原 Supabase 逻辑，保证不破坏官方构建。token 存 `localStorage['token']`，user 信息由 JWT `sub` 派生（无需服务端返 user）。

- [ ] **步骤 1：写失败测试（自建模式下 access 函数返回自建 token / 从 JWT 解析 userID）**

新增 `apps/readest-app/src/__tests__/utils/selfhostedAuth.test.ts`：
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// 模拟 JWT（HS256 不验签，只 decode）：sub=owner, plan=pro
const fakeJwt = btoa('{"alg":"HS256","typ":"JWT"}') + '.' +
  btoa(JSON.stringify({ sub: 'owner', plan: 'pro', exp: 9999999999 })) + '.sig';

describe('selfhosted auth', () => {
  beforeEach(() => { localStorage.setItem('token', fakeJwt); });
  afterEach(() => { localStorage.clear(); });

  it('getAccessToken returns stored token', async () => {
    const { getAccessToken } = await import('@/utils/access');
    expect(await getAccessToken()).toBe(fakeJwt);
  });
  it('getUserID derives sub from JWT without supabase', async () => {
    const { getUserID } = await import('@/utils/access');
    expect(await getUserID()).toBe('owner');
  });
  it('getSubscriptionPlan reads plan=pro from token (no quota limit)', async () => {
    const { getSubscriptionPlan } = await import('@/utils/access');
    expect(getSubscriptionPlan(fakeJwt)).toBe('pro');
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd apps/readest-app && pnpm test selfhostedAuth`
预期：FAIL（`@/utils/access` 仍走 supabase，getUserID 不会返回 'owner'）。

- [ ] **步骤 3：新增 `selfhostedAuth.ts` 封装登录 fetch**

```ts
import { getAPIBaseUrl } from '@/services/environment';

export interface SelfhostedLoginResult { access_token: string; token_type: string }

export async function selfhostedLogin(code: string): Promise<SelfhostedLoginResult> {
  const res = await fetch(`${getAPIBaseUrl()}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('invalid code');
  return res.json();
}

// 从 JWT payload 解析 sub（不验签，与服务端 jwtDecode 行为一致）
export function jwtSub(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.sub ?? null;
  } catch { return null; }
}
```

- [ ] **步骤 4：修改 `supabase.ts` 加自建模式守卫**

在文件顶部增加：
```ts
export const SELFHOSTED = process.env['NEXT_PUBLIC_SELFHOSTED'] === '1';
```
并保留原 `supabase` 客户端创建逻辑（仅当 `!SELFHOSTED` 时真正 `createClient`），避免构建期因缺环境变量报错。导出 `SELFHOSTED` 供其他文件判断。

- [ ] **步骤 5：修改 `access.ts`（行 154-185）走自建 token**

将 `getAccessToken` / `getUserID` / `validateUserAndToken` 改为：
```ts
import { SELFHOSTED } from '@/utils/supabase';
import { jwtSub } from '@/services/selfhostedAuth';

export const getAccessToken = async (): Promise<string | null> => {
  return localStorage.getItem('token') ?? null; // web/tauri 统一从 localStorage 读
};
export const getUserID = async (): Promise<string | null> => {
  const t = localStorage.getItem('token');
  return t ? jwtSub(t) : null;
};
export const validateUserAndToken = async (authHeader?: string | null) => {
  if (!authHeader) return {};
  const token = authHeader.replace('Bearer ', '');
  const uid = jwtSub(token);
  if (!uid) return {};
  return { user: { id: uid } as any, token };
};
```
（保留 `supabase.auth` 分支仅在 `!SELFHOSTED` 时使用，避免删除官方路径。）

- [ ] **步骤 6：修改 `helpers/auth.ts` 的 `handleAuthCallback`**

在 `finalizeSession` 内判断 `SELFHOSTED`：自建模式直接 `login(accessToken, { id: jwtSub(accessToken) } as any)` 并 `navigate(next)`，跳过 `supabase.auth.setSession/getUser`。OAuth 相关 `parseOAuthCallbackUrl` 保持不变。

- [ ] **步骤 7：修改 `EmailPasswordAuth.tsx`（行 94 附近）**

将 `supabaseClient.auth.signInWithPassword(...)` 改为：自建模式下调用 `selfhostedLogin(code)`（这里「邮箱/密码」UI 改为「登录码」单输入，或复用密码框作为 code），成功后 `login(res.access_token, { id: jwtSub(res.access_token) })`。需同步调整该组件的 props 与 UI 文案（如把 email 字段改为 code 输入）。官方 Supabase 分支保留。

- [ ] **步骤 8：运行测试确认通过**

运行：`cd apps/readest-app && pnpm test selfhostedAuth`
预期：PASS。同时跑原有 `helpers/auth.test.ts` 确认官方路径未被破坏（mock supabase 仍通过）。

- [ ] **步骤 9：Commit**

```bash
git add apps/readest-app/src/services/selfhostedAuth.ts \
        apps/readest-app/src/utils/supabase.ts \
        apps/readest-app/src/utils/access.ts \
        apps/readest-app/src/helpers/auth.ts \
        apps/readest-app/src/app/auth/components/EmailPasswordAuth.tsx \
        apps/readest-app/src/__tests__/utils/selfhostedAuth.test.ts
git commit -m "feat(client): support selfhosted code-login replacing Supabase auth"
```

---

### 任务 18：端到端联调（用官方客户端或脚本）

**文件：**
- 创建：`readest-sync-server/scripts/e2e_test.sh`（或用 Go 集成测试 `internal/e2e_test.go`）

- [ ] **步骤 1：编写集成测试覆盖完整链路**

用 Go `httptest` 或真实 server + 内存 store，模拟：登录拿 token → push 一本书 → pull 拿到 → upload 文件 → download 拿到 → replica push/pull。

- [ ] **步骤 2：运行**

运行：`cd readest-sync-server && go test ./... -run E2E`
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/internal/e2e_test.go
git commit -m "test: end-to-end sync and storage flow"
```

---

### 任务 19：README、`.env.example` 与开源声明

**文件：**
- 创建：`readest-sync-server/README.md`
- 创建：`readest-sync-server/.env.example`

- [ ] **步骤 1：写 README**

包含：项目简介（明确「非官方、与 Readest 作者无关」）、**一键部署**（Docker Compose 三步走：复制 `.env.example`→`.env`、填 `AUTH_CODE`/`JWT_SECRET`、 `docker compose up -d`）、快速启动（SQLite+本地磁盘）、生产部署（Postgres+S3/MinIO，改 `.env` 的 `METADATA_BACKEND`/`STORAGE_KIND` 即可，无需改代码）、客户端改法、API 契约摘要、许可证。

- [ ] **步骤 2：写 `.env.example`**

覆盖任务 1 `Config` 所有环境变量，含注释说明自用默认与生产两种组合：

```bash
# ── 通用 ──
LISTEN_ADDR=:8080
# 必改：登录用的一次性码（多台设备都用同一个）
AUTH_CODE=changeme
# 必改：JWT 签名密钥，固定值，否则重启后旧 token 失效需重登。用 `openssl rand -hex 32` 生成
JWT_SECRET=replace-with-openssl-rand-hex-32
# 云存储配额（字节），默认巨大；可设小值模拟限制
QUOTA_BYTES=1152921504606846976

# ── 元数据后端 ──
# 自用：sqlite（零依赖，单文件）；生产：postgres
METADATA_BACKEND=sqlite
# sqlite 时填文件路径；postgres 时填 URL
METADATA_DSN=file:./data/readest.db
# POSTGRES_URL=postgres://user:pass@postgres:5432/readest?sslmode=disable

# ── 文件存储后端 ──
# 自用：local（本地磁盘，挂载卷持久化）；生产：s3（MinIO/S3/R2）
STORAGE_KIND=local
LOCAL_ROOT=./data/files
# S3 / MinIO 配置（STORAGE_KIND=s3 时必填）
# S3_ENDPOINT=http://minio:9000
# S3_BUCKET=readest
# S3_ACCESS_KEY=minioadmin
# S3_SECRET_KEY=minioadmin
# S3_REGION=us-east-1
# S3_USE_PATH_STYLE=true   # MinIO 必须 true
```

- [ ] **步骤 3：Commit**

```bash
git add readest-sync-server/README.md readest-sync-server/.env.example
git commit -m "docs: README, .env.example, and open-source disclaimer"
```

---

### 任务 20：Docker 一键部署（Dockerfile + docker-compose + .env）

**文件：**
- 创建：`readest-sync-server/Dockerfile`
- 创建：`readest-sync-server/docker-compose.yml`
- 创建：`readest-sync-server/.dockerignore`
- 修改：`readest-sync-server/README.md`（补充一键部署章节，已在任务 19 步骤 1 提及）

**目标：** 用户只需 `cp .env.example .env` → 编辑 `AUTH_CODE`/`JWT_SECRET` → `docker compose up -d` 即可运行。是否用 PostgreSQL / MinIO **完全由 `.env` 里的 `METADATA_BACKEND` / `STORAGE_KIND` 决定**，compose 通过 `env_file: .env` 把变量注入容器；选 `postgres`/`s3` 时才启动对应服务。

- [ ] **步骤 1：写失败验证（先用纯 local/sqlite 组合能起，postgres 组合因未配置仍跳过）**

在 `.env` 中设 `METADATA_BACKEND=sqlite`、`STORAGE_KIND=local`，运行：
```bash
cd readest-sync-server && docker compose up -d --build
docker compose exec app wget -qO- http://localhost:8080/api/sync   # 期望 401（未带 token）
```
预期：容器起来、端口通、返回 401。

- [ ] **步骤 2：运行确认失败**

若 Dockerfile 未写或构建失败，上一步会报错 → 确认失败。

- [ ] **步骤 3：实现 Dockerfile（多阶段构建，纯 Go 二进制，CGO 关闭以兼容 modernc/sqlite）**

```dockerfile
# 构建阶段
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 关闭 CGO：modernc.org/sqlite 是纯 Go，无需 CGO；保证镜像可移植
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/readest-sync .

# 运行阶段
FROM alpine:3.20
WORKDIR /app
RUN adduser -D -u 10001 appuser
COPY --from=build /out/readest-sync /app/readest-sync
# 运行时数据卷挂载点（sqlite 文件 + 本地文件存储）
VOLUME ["/app/data"]
ENV LISTEN_ADDR=:8080
EXPOSE 8080
# 以非 root 运行
USER appuser
ENTRYPOINT ["/app/readest-sync"]
```

`.dockerignore`：
```
data/
.git/
*.db
.env
```

- [ ] **步骤 4：实现 docker-compose.yml（条件式启动 postgres/minio）**

用 `profiles` 让用户按需启用 PostgreSQL / MinIO：默认只起 `app`（sqlite+local），`docker compose --profile postgres --profile minio up -d` 才带数据库与对象存储；后端类型仍由 `.env` 的 `METADATA_BACKEND`/`STORAGE_KIND` 决定，二者需配套设置（README 中说明）。

```yaml
services:
  app:
    build: .
    env_file: .env            # 读取用户 .env，注入所有变量
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data      # 持久化 sqlite + 本地文件
    restart: unless-stopped
    depends_on:
      - postgres
      - minio

  postgres:
    image: postgres:16-alpine
    profiles: ["postgres"]    # 仅 --profile postgres 时启动
    environment:
      POSTGRES_USER: readest
      POSTGRES_PASSWORD: readest
      POSTGRES_DB: readest
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U readest"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio:
    image: minio/minio:latest
    profiles: ["minio"]       # 仅 --profile minio 时启动
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - miniodata:/data
    ports:
      - "9000:9000"
      - "9001:9001"

volumes:
  pgdata:
  miniodata:
```

> 说明：环境变量全部来自 `.env`（`env_file`），`docker-compose.yml` 不硬编码任何密钥或后端选择。用户改 `.env` 即切换后端，无需改 compose 文件。生产用 `postgres`+`minio` 时，`.env` 需同时设 `METADATA_BACKEND=postgres` + `METADATA_DSN=postgres://readest:readest@postgres:5432/readest?sslmode=disable` 与 `STORAGE_KIND=s3` + `S3_ENDPOINT=http://minio:9000` + `S3_USE_PATH_STYLE=true` 等。

- [ ] **步骤 5：运行确认「postgres+minio」组合可用**

```bash
cd readest-sync-server
# 临时 .env 切到生产组合
sed -i 's/METADATA_BACKEND=sqlite/METADATA_BACKEND=postgres/; s#METADATA_DSN=file:./data/readest.db#METADATA_DSN=postgres://readest:readest@postgres:5432/readest?sslmode=disable/; s/STORAGE_KIND=local/STORAGE_KIND=s3/' .env
docker compose --profile postgres --profile minio up -d --build
```
预期：`app`、`postgres`、`minio` 三个容器均 `healthy/running`，`GET /api/sync` 返回 401（认证中间件工作）。

- [ ] **步骤 6：Commit**

```bash
git add readest-sync-server/Dockerfile readest-sync-server/docker-compose.yml readest-sync-server/.dockerignore
git commit -m "feat: Dockerfile and docker-compose with profile-gated postgres/minio"
```

---

### 任务 21：许可证与法律合规收尾

**文件：**
- 创建：`readest-sync-server/LICENSE`
- 创建：`readest-sync-server/NOTICE`

- [ ] **步骤 1：放置 LICENSE（建议 AGPL-3.0）**

说明本项目是独立实现的服务端，兼容 Readest 客户端 API，不含有 Readest 原代码，与 Readest 原作者无隶属关系。

- [ ] **步骤 2：Commit**

```bash
git add readest-sync-server/LICENSE readest-sync-server/NOTICE
git commit -m "legal: add AGPL-3.0 license and independence notice"
```

---

## 自检

**1. 规格覆盖度：**
- 写死码登录 + JWT → 任务 4/5/6 ✅
- 书籍/标注/配置/统计增量同步 → 任务 7/8（/sync）+ 任务 9（replicas/keys）✅
- 书籍文件云存储 → 任务 11/12（storage + blob）✅
- AI 翻译 → 任务 14 ✅
- AI 朗读 TTS → 任务 15 ✅
- 元数据 → 任务 16 ✅
- 存储可插拔（SQLite/Postgres，本地/S3） → 任务 3/13 ✅
- Docker 一键部署（Dockerfile + compose + .env 驱动后端） → 任务 20 ✅
- 客户端真实代码改动（替换 Supabase 登录为自建码登录） → 任务 17 ✅
- 开源法律合规 → 任务 19/21 ✅

**2. 占位符扫描：** 已避免「TODO」「待定」「补充测试」等。客户端改动（任务 17）原为契约说明，现已升级为**真实代码任务**：含 `selfhostedAuth.ts` 新增、4 个文件的具体修改点（含行号）、失败/通过测试与 commit，不再依赖「另立 PR」。

**3. 类型一致性：**
- `MetadataStore` / `FileStore` 接口在任务 3 定义，任务 7/8/9/11/12 handler 均使用这些接口，任务 13 的 Postgres/S3 实现同接口 → 一致。
- `middleware.UserID(r)` 在任务 5 定义，任务 7-12 均使用 → 一致。
- `auth.Service` 在任务 4 定义，`LoginHandler` 任务 6 加，`RequireAuth` 任务 5 加 → 一致。
- `Config` 在任务 1 定义（运行时读 `.env` 环境变量），任务 10 装配与任务 13 工厂使用其 `METADATA_BACKEND`/`STORAGE_KIND` 等字段 → 一致。
- `BookRow.Data` 为 JSON 字节，任务 7/8 在 store 层与 handler 层之间传递，字段名统一 → 一致。

**4. 风险提示（非阻塞）：**
- `replica` 的 last-writer-wins 用 HLC 字符串字典序比较，已在任务 9 注明前提（客户端 HLC 格式保证字典序=时间序）。
- 客户端实际改动需独立验证（任务 17 仅给出契约），建议在真实设备/网页端用抓包对比官方行为。
- Edge TTS 的 WebSocket 实现依赖第三方库可用性，若不可用则 TTS 代理降级为返回错误（不影响同步主流程）。

---

计划已完成并保存到 `docs/superpowers/plans/2026-08-15-readest-selfhosted-sync.md`。

**两种执行方式：**

1. **子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代
2. **内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
