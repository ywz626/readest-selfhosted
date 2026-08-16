# Readest · 自托管版

> 本仓库基于上游 [Readest](https://github.com/readest/readest) 改造而来的**自托管（Self-hosted）版本**，用于私有化部署云同步服务，非官方发布。

> ⚠️ **平台声明**：本自托管版仅在 **Windows / Android** 上做过测试，**macOS / Linux / iOS 未经测试，不保证运行结果**。如在其他平台使用，请自行验证。

> 🎯 **适用人群**：本自托管版主要面向**拥有闲置服务器、有一定动手能力**的用户。如果你**资金充裕**、希望获得官方维护与稳定体验，请优先考虑官方订阅计划。

## 与官方版的主要区别

- **自行部署服务端**：云同步不再依赖 Readest 官方服务器 / Supabase，而是使用本仓库内置的 `readest-sync-server`（Go 单二进制，SQLite + 本地磁盘），数据存储在自己掌控的服务器上。
- **服务端地址运行时输入**：客户端安装包内置自托管模式，用户首次登录时在应用内填写自己的同步服务端地址即可，无需自行编译。
- **主要解锁能力：云同步空间**：官方版「云同步空间」受订阅计划 / 配额限制；自托管模式下不受 Stripe / IAP 付费配额限制，可自由使用云端同步与存储。

请阅读 [自托管部署指南](#自托管部署指南) 获取服务端部署与客户端打包的完整步骤。

## 自托管部署指南

自托管版需要**两个组成部分**配合使用：**同步服务端**（`readest-sync-server`）和**客户端**（Tauri 打包的 Readest 应用）。

### 1. 部署同步服务端

服务端在 `readest-sync-server/` 目录，是一个零外部依赖的 Go 单二进制（默认 SQLite + 本地磁盘）。参考其 [README](./readest-sync-server/README.md) 与部署脚本 `deploy.sh`。

**Docker Compose 一键部署：**

```bash
cd readest-sync-server
cp .env.example .env
# 编辑 .env：至少填写 AUTH_CODE（登录码）与 JWT_SECRET
docker compose up -d --build
```

默认即可运行，访问 `http://localhost:8080`。如需生产部署（PostgreSQL + MinIO），见 `readest-sync-server/README.md`。

**本地（不用 Docker）快速启动：**

```bash
cd readest-sync-server
go mod tidy
AUTH_CODE=changeme JWT_SECRET=$(openssl rand -hex 32) go run .
```

> 服务端为独立实现，不包含 Readest 客户端源代码。部署时请确保服务器域名开启 HTTPS，并能在客户端访问到。

### 2. 打包客户端安装包（Tauri）

客户端安装包内置自托管模式，**无需为每个用户单独配置服务端地址**——用户首次登录时在应用内填写自己的地址即可。确认依赖与构建工具已就绪后，在 `apps/readest-app/` 下执行：

```bash
cd apps/readest-app
# 首次：复制并编辑 .env.server，确保 NEXT_PUBLIC_SELFHOSTED=1（见 build-server 脚本）
cp .env.server.example .env.server

pnpm install
pnpm build-tauri        # 用 .env.tauri 构建前端
pnpm tauri build        # 打包桌面安装包（Windows / macOS / Linux）
```

> 自托管环境要求 `NEXT_PUBLIC_SELFHOSTED=1` 参与构建（见 `build-server` 脚本），否则自托管逻辑不会生效。打包产物输出到 `src-tauri/target/release/bundle/`。

各平台产物参考：
- **Windows**：`.msi` / `.exe`（NSIS）
- **macOS**：`.dmg` / `.app`
- **Linux**：`.AppImage` / `.deb` / `.rpm`

### 3. 使用（分发 / 用户侧）


**用户**安装客户端后：
1. 打开应用进入登录界面，先填写自己的**同步服务端地址**（如 `https://sync.example.com`），地址会保存在本地，无需重复填写。
2. 再输入部署服务端时设置的 **`AUTH_CODE` 登录码**，即可登录并开始云同步。

数据（书籍、标注、进度、配置）与书籍文件均存储在你自己的服务器上，不受订阅配额限制。

## License

本仓库基于上游 Readest 的自托管改造，仍以 [GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html) v3（或更高版本）分发。详见 [LICENSE](LICENSE) 文件。
