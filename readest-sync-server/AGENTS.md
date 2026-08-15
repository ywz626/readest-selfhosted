# readest-sync-server

> Readest 自建云同步服务端（Go 单二进制）。兼容 Readest 客户端 API，自用零依赖（SQLite + 本地磁盘），开源可切换 PostgreSQL / S3(MinIO)。

## 0. 基本要求

- 使用中文回复。思考和推理过程也使用中文。
- 先判断用户意图，再决定是回答、排查还是实施。
- 只做用户明确要求的事；不顺手扩范围、不借机重构。
- 先搜索现有实现，再做修改；先验证结果，再结束。
- 本项目是 **Readest 客户端的兼容服务端，非官方实现**。任何对外发布/文档都须声明「非官方、与 Readest 原作者无关」，并遵守 AGPL-3.0 义务（若对外提供联网使用的修改版客户端，须开源该改动）。

---

## 1. 意图路由

| 用户表述 | 默认动作 |
|---|---|
| “解释 / 分析 / 对比 / 怎么做” | 只研究并回答，不改文件 |
| “查一下 / 看看 / 排查 / 定位” | 先搜索代码、配置、日志，再给结论 |
| “实现 / 添加 / 修改 / 修复” | 先找同类实现与边界，再做最小改动 |
| “重构 / 优化 / 清理” | 先评估收益、风险、影响范围，再分步执行 |

如果需求有歧义：

1. 先用搜索和阅读把歧义压到最小。
2. 仍不清楚时，采用**最简单且最保守**的解释继续。
3. 只有在会明显影响结果时，才补问一个最小必要问题。

---

## 2. Harness Engineering 执行协议

每次开始前，先在心里确认四件事：

1. **目标**：用户真正要什么。
2. **约束**：不能做什么、必须遵守什么。
3. **范围**：会影响哪些模块、层级、配置或接口。
4. **验证**：完成后如何证明真的生效。

默认工作流：**理解 → 搜索 → 决策 → 实施 → 验证 → 交付**

### 搜索规则

- 至少先看 2~3 处相似实现，再决定写法。
- 先看入口、调用链、配置、测试，再改代码。
- 涉及库 / 框架 / API 时，优先看官方文档或权威资料。
- 仓库是第一事实来源；仓库没有的信息，不要当成既定事实。
- **API 契约以客户端源码为准**：同步/存储协议对齐 `apps/readest-app/src/libs/{sync,storage,replicaSyncClient}.ts` 与 `apps/readest-app/src/types/{book,replica}.ts`。改协议字段前必须先比对这两个文件，禁止臆造字段。

### 修改规则

- 优先复用现有实现、现有依赖、现有工具。
- 优先“无聊但可靠”的方案，不追求花哨抽象。
- Bugfix 只修问题本身，不顺带重构。
- 非必要不新增文件、不新增依赖、不改公共接口。
- 一条路径连续尝试最多 2 次；第 3 次必须换思路或停下说明。
- **存储改动走接口**：handler 只能依赖 `store.MetadataStore` / `store.FileStore` 接口，不得直接 import 具体实现（sqlite/postgres/s3）。新增存储能力先扩接口再实现。
- **后端选择由环境变量决定**：`METADATA_BACKEND`（sqlite|postgres）、`STORAGE_KIND`（local|s3）。禁止在代码里硬编码后端种类，切换后端只改 `.env`。

### 验证规则

修改后按任务相关性至少完成：

- 诊断无新增错误（`go vet ./...`）
- 构建通过（`go build ./...`）
- 测试通过（`go test ./...`）
- 功能被实际执行过，而不是“看代码觉得可以”

交付时只说明：**改了什么、改在哪、如何验证、是否还有前置问题/风险**。

---

## 3. 项目速览

### 技术栈

| 类别 | 版本 / 选型 |
|---|---|
| 语言 | Go 1.22+ |
| HTTP | 标准库 `net/http` 或 `github.com/go-chi/chi/v5` |
| JWT | `github.com/golang-jwt/jwt/v5`（HS256） |
| SQLite | `modernc.org/sqlite`（纯 Go，CGO 关闭） |
| PostgreSQL | `github.com/jackc/pgx/v5`（可选） |
| S3/MinIO | `github.com/minio/minio-go/v7`（可选） |
| 配置 | 环境变量 + `.env`（`github.com/joho/godotenv`） |
| 测试 | 标准 `testing` + `net/http/httptest` |

### 常用命令

```bash
cd readest-sync-server

go build ./...
go vet ./...
go test ./...
go test ./internal/sync/ -run TestPullSince -v

# 本地运行（sqlite + 本地磁盘）
cp .env.example .env   # 改 AUTH_CODE / JWT_SECRET
go run .

# Docker 一键部署
docker compose up -d --build                              # 默认 sqlite + local
docker compose --profile postgres --profile minio up -d   # 启用 PostgreSQL + MinIO
```

### 运行信息

- 服务前缀：所有 API 挂在 `/api` 下（客户端 `getAPIBaseUrl()` 返回 `<base>/api`）。
- 登录：`POST /api/auth` 用写死的码换 JWT（见 `internal/auth`）。
- 同步主接口：`/api/sync`、`/api/sync/replicas`、`/api/sync/replica-keys`。
- 文件存储：`/api/storage/*`、`/api/storage/blob/{key}`。
- 代理：`/api/deepl/translate`、`/api/yandex-translate`、`/api/tts/edge`、`/api/metadata/search`。
- 默认端口：`LISTEN_ADDR`（默认 `:8080`）。

### 本地环境

- 运行时数据默认在 `./data/`（`data/readest.db` + `data/files/`），Docker 下为卷挂载。
- `JWT_SECRET` 必须固定（用 `openssl rand -hex 32` 生成），否则重启后旧 token 失效需重登。
- `AUTH_CODE` 为登录用的一次性码，多台设备共用同一个。

---

## 4. 仓库与任务协作约束

### Git

- 遵循 Conventional Commits，提交信息使用中文。
- 未被明确要求时，不要主动提交。
- 禁止在提交信息中添加 `Co-Authored-By`。
- 涉及客户端 fork 改动（见第 7 节）须在提交信息注明 AGPL 影响。

### 任务计划

- 实现计划位于 `docs/superpowers/plans/2026-08-15-readest-selfhosted-sync.md`，按任务（Task）编号推进。
- 每完成一个任务内的「步骤」，跑对应测试确认绿，再 commit 该任务。
- 不要跳过任务间的依赖（如未实现 `auth` 就去写 `/sync` 路由）。

---

## 5. 项目结构与实现边界

### 分层结构

| 层 | 位置 | 责任 |
|---|---|---|
| 路由装配 | `main.go` | 读取配置、创建 store、注册路由、挂中间件 |
| Handler | `internal/{sync,storage,proxy}/*.go` | 解析请求、调 store、组装响应；不含存储具体逻辑 |
| 存储接口 | `internal/store/{metadata,filestore}.go` | 定义 `MetadataStore` / `FileStore` 接口与工厂 |
| 存储实现 | `internal/store/{sqlite,postgres,localdisk,s3}.go` | 接口的具体实现 |
| 鉴权 | `internal/auth/*.go` + `internal/middleware/*.go` | 码校验、JWT 签发/校验、Bearer 注入 `user_id` |

### 模块关系

```text
main.go
  ├─ auth.Service ──────────► JWT 签发/校验
  ├─ middleware.RequireAuth ─► 解析 Bearer → context.user_id
  ├─ store.NewMetadataStore ─► sqlite | postgres   (由 METADATA_BACKEND 决定)
  ├─ store.NewFileStore ─────► localdisk | s3       (由 STORAGE_KIND 决定)
  └─ Handlers (sync/storage/proxy) ──► 仅依赖 store 接口 + context.user_id
```

### 关键原则

- Handler 不直接依赖具体存储实现，只依赖 `MetadataStore` / `FileStore` 接口。
- `middleware.UserID(r)` 是唯一获取当前用户的入口，下游禁止自行解析 token。
- 所有写操作必须把 `user_id` 强制为当前登录用户（防越权：客户端传来的 `user_id` 字段一律忽略，用服务端 `context` 值）。
- 增量同步游标语义：
  - `/sync` 的 `since` 为 epoch 毫秒；`type=books` 按 `synced_at`（ISO）升序分页并做末尾 tie-completion。
  - `/sync/replicas` 的 `since` 为 HLC 字符串（如 `0000000000064-00000000-dev-a`），字符串字典序即时间序，可直接比较。
- last-writer-wins 用请求里的 `updated_at` / `updated_at_ts` 比较后再写，不无条件覆盖。

### 核心模型（对齐客户端 `src/types`）

- `BookDataRecord`：`id, book_hash, meta_hash?, user_id, updated_at, deleted_at, synced_at?`（`apps/readest-app/src/types/book.ts:567`）。
- `ReplicaRow`：`user_id, kind, replica_id, fields_jsonb, manifest_jsonb, deleted_at_ts, reincarnation, updated_at_ts, schema_version`（`apps/readest-app/src/types/replica.ts:27`）。
- `Hlc`：字符串品牌类型，格式见上。

---

## 6. Go 开发规范

### 代码风格

- 使用 `gofmt` / `goimports` 统一格式。
- 公共类型 / 函数 / 接口写 GoDoc 注释（中文或英文均可，简洁明确）。
- 错误用 `fmt.Errorf("...: %w", err)` 包装，保留链路；禁止空 `catch` 等价物（空 `if err != nil {}`）。
- 日志用标准 `log/slog`，包含上下文（user_id、key、kind），避免空泛描述。

### 测试

- 每个 handler / store 实现配对 `*_test.go`。
- 用 `net/http/httptest` 做 handler 集成测试；用 `:memory:` SQLite 做 store 测试。
- 测试要覆盖：401（无 token）、200（带 token）、越权（用户 A 访问用户 B 的 key 返回 403/404）、增量游标边界。
- 禁止通过删除/禁用测试让结果“变绿”。

### 依赖

- 新增第三方依赖前先确认仓库未提供等价实现。
- `modernc.org/sqlite` 须配合 `CGO_ENABLED=0` 构建（Dockerfile 已设），禁止引入需 CGO 的 sqlite 驱动。
- S3/Postgres 为可选依赖，仅在 `STORAGE_KIND=s3` / `METADATA_BACKEND=postgres` 路径 import，避免默认构建拖入重依赖（可用 build tag 或惰性 import）。

---

## 7. 数据与业务约束

### 鉴权

- 登录码在 `AUTH_CODE` 中写死；任何用户用同一码登录后 `sub` 固定为 `owner`（自用场景多设备共享同一份同步数据）。
- JWT payload：`{ sub: "owner", plan: "pro", exp: now+10y }`。`plan:"pro"` 使客户端不限制配额（绕过官方免费版空间限制）。
- 客户端 `getSubscriptionPlan` 用 `jwtDecode` 仅解码不验签；服务端 `/sync`、`/storage` 必须自验签名并校验 `sub`。
- 禁止把 `AUTH_CODE` / `JWT_SECRET` 提交进仓库；只进 `.env`（已 gitignore）。

### 配额

- 自建服务端 `quota` 由 `QUOTA_BYTES` 决定，默认 `1<<60`（近乎无限）。`usagePercentage = usage/quota*100`。
- 不实现官方付费套餐逻辑；`plan` 恒为 `pro`。

### 存储后端切换

- `METADATA_BACKEND=sqlite`：DSN 形如 `file:./data/readest.db`。
- `METADATA_BACKEND=postgres`：DSN 为 `postgres://user:pass@host:5432/db?sslmode=disable`，schema 由 `postgres.go` 内 `CREATE TABLE IF NOT EXISTS` 初始化。
- `STORAGE_KIND=local`：文件落在 `LOCAL_ROOT/<user_id>/...`。
- `STORAGE_KIND=s3`：填 `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY/S3_REGION`，MinIO 须 `S3_USE_PATH_STYLE=true`。
- 切换后端**只改 `.env`**，不动代码、不动 `docker-compose.yml`（compose 用 `profiles` 按需起 postgres/minio）。

### 安全

- 所有 `/api/*`（除 `/api/auth`）必须过 `middleware.RequireAuth`。
- `localdisk` 的 `key` 必须校验 `strings.HasPrefix(key, userID+"/")`，禁止跨用户路径遍历。
- 上传文件名服务端校验（参考客户端 `replicaSchemas.ts:validateFilename`），禁止 `../` 等路径注入。
- 错误响应体统一：`{ "error": "message", "code": "AUTH|QUOTA_EXCEEDED|CLOCK_SKEW|VALIDATION|SERVER" }`。

---

## 8. 客户端 fork 改动约定（独立仓库 / 分支）

> 客户端代码在 `apps/readest-app/`，**不在本服务端仓库**。以下约束适用于你修改客户端以连本服务端时。

- 引入 `NEXT_PUBLIC_SELFHOSTED=1` 开关：开启走自建 `/api/auth`，关闭保持官方 Supabase 逻辑，不破坏原构建。
- 改动文件：`src/services/selfhostedAuth.ts`（新增）、`src/utils/supabase.ts`、`src/utils/access.ts`、`src/helpers/auth.ts`、`src/app/auth/components/EmailPasswordAuth.tsx`。
- `getAccessToken` / `getUserID` 统一从 `localStorage['token']` 读；`getUserID` 由 JWT `sub` 派生，不依赖服务端返回 user 对象。
- 客户端改动遵守 AGPL-3.0：若对外发布联网使用的修改版，须开源该改动，并在 README 声明非官方。

---

## 9. 文档规范

### 存放位置

- 服务端文档统一放在 `readest-sync-server/` 内：`README.md`（部署/配置/客户端改法/开源声明）、`docs/`（计划、设计）。
- 计划文件：`docs/superpowers/plans/2026-08-15-readest-selfhosted-sync.md`。

### 新增文档时

1. 先确认属于服务端还是客户端 fork。
2. 服务端 → `readest-sync-server/` 下；计划类 → `docs/superpowers/plans/`。
3. API 契约变更必须同步更新计划文件与 `internal` 层类型定义，并保持与客户端 `src/libs/*.ts` 对齐。

---

## 10. 硬约束

以下规则违反即停止：

- 禁止擅自扩大需求、追加功能、顺手优化无关代码。
- 禁止提交无法编译的代码（`go build ./...` 必须通过）。
- 禁止通过删除 / 禁用测试来让结果“变绿”。
- 禁止把密钥（`AUTH_CODE` / `JWT_SECRET` / `S3_SECRET_KEY`）写入仓库或文档示例明文（`.env.example` 只放占位符）。
- 禁止在 handler 中直接 import `sqlite` / `postgres` / `s3` 具体实现（破坏可插拔性）。
- 禁止忽略 `user_id` 隔离：任何写入都必须以 `context` 中的 `user_id` 为准。
- 禁止对未读代码、未跑命令、未看结果的内容做确定性判断。
- 未执行验证时，不得声称“已验证”。
- 禁止宣称本项目为官方 Readest 产品或与作者存在隶属关系。

---

## 11. 完成定义

只有同时满足以下条件，任务才算完成：

- 用户请求范围已覆盖
- 修改与仓库现有模式一致（接口隔离、环境变量驱动后端）
- 相关诊断 / 构建 / 测试已通过，或已明确说明存量问题
- API 契约与客户端 `src/libs/*.ts` / `src/types/*.ts` 对齐
- 功能已实际验证，并能给出证据

交付检查清单：

- [ ] `go build ./...` 通过
- [ ] `go vet ./...` 无新增错误
- [ ] `go test ./...` 通过
- [ ] 如适用，新增功能已有测试（含 401 / 越权 / 游标边界）
- [ ] 符合 `gofmt` 与现有代码风格
- [ ] 已完成实际验证（本地 `go run` 或 Docker 起服务并 curl）
- [ ] 密钥未泄露进仓库
- [ ] 仅在用户明确要求时提交 Git commit
