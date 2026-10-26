# 上游合并记录：v0.12.10（123 个提交）

- 合并方向：`remote/main`（readest/readest，`80f137eda` → `f846ee62e`）→ 自托管分支 `master`
- 合并提交：`6db6001a6`
- 合并前备份分支：`backup/master-before-v0.12.10`（指向 `058acdd10`）
- 版本：`apps/readest-app/package.json` 0.12.8 → **0.12.10**
- 规模：791 个文件变更，+58,145 / −6,942

---

## 一、阅读器

- **EPUB 打开路径并行化**，打开更快（#6406）
- **章节加载拆分**，减少滑动卡顿（#6266）
- **段落模式（Paragraph Mode）支持选中、高亮、查词**（#6258）
- 引号对话高亮（#6376）
- 段落模式支持脚注链接（#6365）
- **PDF / CBZ / 固定版式书籍支持翻页动画**（#6246）、Push 动画（#6251）
- 修复 PDF/CBZ 向后卷页只前进几个像素的问题（#6250）
- 宽幅漫画页缓存 + 独立跨页，支持流式漫画中查找（#6276 / #6273）
- 图片密集章节在分页模式下不再冻结（#6229）
- 分页模式下整页图片不再溢出栏宽（#6252）
- **支持导入并渲染 HTML 文件**（#6281）
- 每次翻页更新「剩余章数」（#6447）
- 修正剩余时间排序与章节时长估算（#6319）
- 新增「下拉书签手势」设置（#6278）
- 图片查看器点按隐藏控件（#6183）
- 书籍转为 RTL 时滑块保持镜像（#6168）
- 封面/页眉切边与圆角适配（#6263 / #6429）
- 外部链接跳转前弹确认（#6254）
- 修复 style 标签属性在样式转换中被丢弃（#6270）
- EPUB 播放 OPF 清单未声明的内嵌媒体（#6245）
- M4B 有声书在 moov 位于音频之后时正确读取章节（#6327）
- TTS：非英文书不被 en-US 文档语言抢走音色（#6247）、启动探测加边界 + 过滤 Apple 系统音色（#6345）
- 注释工具栏按已启用操作自动定尺（#6338）、高亮圆角帽留在本页（#6182）、调整高亮时清理拖动前选区（#6357）

## 二、书架 / 书库 ★ 本次最大改动

- **可配置书架（configurable bookshelves，#6329）**：书架成为可命名、可排序、可设置筛选/分组/布局/封面的实体，并作为新的同步复制类型持久化。`Bookshelf.tsx` 被整体重写为
  `definitions → ownership → results → sections` 管线，渲染交给新的 `BookshelfStream`。
- **列表视图显示书籍标签 + 「Tag Books」操作**（#6334）
- 电子墨水屏分页与书架同步改进（#6330）
- 导入书籍时跳过隐藏子目录（#6453）
- 导入时不再把书籍文件复制到自身（#6403）
- 防止滚动条初始化造成的布局跳动（#6336）
- 大书库首次同步进度增量持久化（OPDS，#6237）

## 三、同步 · 云

- **新增 `bookshelf` 复制类型**（配合可配置书架）；推送按 100 行分批，并支持按 kind / 按行降级重试，单条坏数据不再卡死整个推送队列
- 书籍同步开关关闭时拒绝云端上传（#6446）
- 首次打开书籍时推送已有笔记（#6404）
- 应用恢复前台时刷新阅读进度（#6332）
- WebDAV：保留原始错误并上报「同步不完整」（#6311）；失败重试不再推进配置状态（#6310）
- OneDrive：不再创建 Graph 现在会拒绝的文件夹（#6451）
- 同步写入前置条件文档改为与 provider 无关（#6455）

## 四、有声书 / Audiobookshelf / OPDS

- Audiobookshelf：支持离线下载、在浏览器里导入 ABS zip（#6267）
- Audiobookshelf：电子书-only 书籍的阅读进度同步（#6264）
- 通过 loopback 媒体代理串流，自签名 ABS 服务器也能播放（#6268）
- OPDS 目录串流播放有声书，新增 BookOrbit 连接器（#6301）
- BookOrbit 音频走 loopback 媒体代理（#6308）

## 五、Android

- **arm64 APK 从 90MB 减到 57MB**（#6368）——同时移除了 `public/vendor` 下 pdfjs/simplecc/jieba 的重复拷贝，`@pdfjs` 改为指向真实包
- Android Auto：浏览并恢复书籍（#6285）、冷启动 EPUB 在媒体服务中播放（#6341）
- 电子墨水设备识别：iReader、厂商 prop 上报 SoC 厂商的情况（#6293 / #6392）
- **修复启动时页面加载死锁导致应用冻结**（#6240）
- TTS 媒体控制可唤起应用（#6370）、媒体键恢复 TTS（#6452）
- 可配置的书架桌面小组件（#6430）、小组件配置改进（#6440）
- 长按链接附近可选中文本（#6248）

## 六、Windows / macOS / iOS / Linux

- **Windows 10：绘制缺失的窗口边框**（#6399）
- Windows 10：去掉破碎的原生阴影（#6362）
- macOS：书库页保留红绿灯按钮、导航不再跳动（#6253）；注释导出可保存到磁盘（#6260）
- iOS：CarPlay 最近书籍 + 场景切换修复（#6339）；原生 idle timer 保持屏幕常亮（#6261）；原生触摸转发恢复跨页选择（#6255）
- Linux：现在仅 CEF，移除 WebKitGTK 假设（#6218）；启动缺 X11 display 时给出说明（#6302）

## 七、设置 / UI

- 字体面板按「字体承担的角色」重组（#6325）
- 设置页重开恢复滚动位置（#6389）
- **反转鼠标滚轮翻页 + 隐藏电子墨水屏书架按钮**（#6448）
- 底部抽屉手势与设置滚动更顺滑（#6335）
- 移动端阅读菜单对齐、对话框关闭改进（#6314）
- 侧栏打开时切换按钮不再移位（#6435）
- 侧栏笔记时间戳每分钟刷新（#6324）

## 八、词典 / 翻译

- 词典查询 Unicode 规范化 + 拉丁变音折叠（#6320）
- 查词自动播放发音（#6280）
- 翻译弹窗解码 HTML 实体（#6317）
- 按书记住翻译源语言（#6300）
- WordLens：繁体中文提示 + 英→阿拉伯语包（#6303）
- 即时词典关闭时把选区交还（#6272）

## 九、其他

- Readwise：导出书签及其笔记（#6294）
- 备份：恢复书库行被删的孤立书籍（#6405）
- 备份：保持屏幕常亮、批量 zip 处理移到 Rust（#6299）
- 遥测开关关闭时停止 PostHog 上报（#6434）
- 安全加固：电子书内容与代理信任边界（#6343）
- Web：以文本方式读取的二进制文件正确解码（#6402）
- 支付：退款时撤销 Stripe 一次性购买（#6436）；跨计费商解析用户计划（#6228）；Play 取消时间存为时间戳（#6342）
- **Docker：minio 镜像改从 quay.io 拉取**（#6196）
- Nix / Docker 构建修复（#6379 / #6282 / #6274）
- Koreader 插件：后台同步、分组下载、书库管理（#6321）；已同步的高亮删除不再复现（#6322）；Android 同步 / 拉取 ANR / 重新扫描（#6364）；登录态过期提示（#6445）；同步位置无法解析时不崩溃（#6441）
- TXT：识别用「两」或大写数字编号的中文章节（#6172）
- CI / 依赖批量升级

---

## 十、自托管改造的合并后校验

以下锚点在合并后逐项确认仍然存在：

| 项目 | 位置 | 状态 |
| --- | --- | --- |
| 应用标识 | `tauri.conf.json`：`Readest 自托管` / `readest-sh` / `com.ywz626.readest.sh` | 保留 |
| 自托管构建 env | `beforeBuildCommand` 带 `-e .env.server` | 保留 |
| 自托管总开关 | `.env.server`：`NEXT_PUBLIC_SELFHOSTED=1` | 保留 |
| 禁用官方更新 | `helpers/updater.ts`、`nativeAppService.ts`、`AboutWindow.tsx` 的 `SELFHOSTED` 门控 | 保留 |
| 服务端地址运行时输入 | `services/selfhostedServerUrl.ts`（8 处引用） | 保留 |
| 书架置顶 | `Book.pinnedAt` + `settings.libraryPinnedGroups`（同步白名单内）+ 服务端 metadata 时钟映射 | 保留 |
| 随机选书 | `components/randompick/`、`store/randomPickStore.ts`、`LibraryHeader.onOpenRandomPick` | 保留 |
| Android 命名空间 | `gen/android` → `com.ywz626.readest.sh` | 保留 |
| 类型检查 | `npx tsc --noEmit` | 通过，无错误 |

---

## 十一、服务端（`readest-sync-server`）

**结论：Go 同步服务端无需改代码即可兼容本次客户端更新。**

依据：

1. 新引入的 `bookshelf` 复制类型走的是既有的 `/api/sync/replicas` 契约。该接口在 Go 侧是**完全按 kind 透传**的
   （`internal/sync/replica.go` 不校验 kind，`replicas` 表 `kind TEXT` 无 CHECK 约束），新 kind 直接落库。
2. 本次上游在客户端侧只动了 `libs/replicaSchemas.ts`（+11 行，新增 `bookshelf` 的 KindSpec）和
   `types/replica.ts`（+3 行，`MAX_PUSH_BATCH` 迁移），**没有新增端点、没有改动 payload 结构**。
3. 客户端批量拉取期望 `{ results: [{ kind, rows }] }`，与 Go 侧 `PullReplicasBatch` 的输出一致。
4. 推送成功的判定只看 HTTP 是否成功，不依赖响应回显（`flushBatch` 里 `await client.push(...)` 成功即视为已推送），
   因此 Go 侧回显行为不影响新逻辑。
5. 客户端 `unsupportedKinds` 依赖服务端返回 `UNKNOWN_KIND` 错误码降级；Go 侧从不返回该码，该降级分支不会触发，属无害。

### 唯一需要动的服务端事项

- `readest-sync-server/docker-compose.yml`：`minio/minio:latest` → **`quay.io/minio/minio:latest`**。
  Docker Hub 已下架 minio 镜像，`docker compose --profile minio` 会拉取失败；已对齐上游 #6196 的改动。

### 不影响本项目的上游改动

- 上游新增的 `docker/volumes/db/migrations/023_replica_bookshelf.sql`（把 `bookshelf` 加进 Supabase 的
  `replicas.kind` 白名单）只作用于**官方 Supabase 自托管方案**（`docker/` 目录），与 Go 服务端无关。
  本次合并已把该文件带入仓库，但不需要执行。

---

## 十二、打包

### 构建命令（脚本已内置自托管 env）

```bash
cd apps/readest-app
pnpm build-server-win-x64-64bit   # Windows x64 + NSIS
pnpm build-server-android          # Android APK（尾部含 adb install，无设备会非零退出，构建已完成）
```

产物位置：
- Windows：`apps/readest-app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`
- Android：`apps/readest-app/src-tauri/gen/android/app/build/outputs/apk/universal/release/`

### 打包前必须解除的环境障碍

1. **必须 `unset NODE_OPTIONS`**。会话环境注入了
   `NODE_OPTIONS=--require=.../WorkBuddy/.../node-language-shim.cjs`，
   会被 Next.js 构建 worker 继承并导致 `next build` 在 `Running next.config.mjs` 之后**无限卡死**
   （CPU 不增长、无输出）。清除后构建立刻继续。
2. **需要足够空闲内存**。本机 24 GB 物理内存当时只剩约 2.9 GB 可用、可提交内存仅约 234 MB，
   表现为 `RangeError: Array buffer allocation failed`（Node）乃至
   `memory allocation of 302 bytes failed`（Rust CLI）。这是环境问题，不是代码问题。

### 本次打包状态

未完成——在上述内存耗尽状态下构建被中断。清理内存（关闭浏览器 / Steam / KOOK 等占内存程序，或重启）后重新执行上面的命令即可。
