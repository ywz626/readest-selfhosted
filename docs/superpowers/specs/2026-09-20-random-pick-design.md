# 随机选书（Random Pick）设计规格

- 日期：2026-09-20
- 状态：已确认，待实现
- 适用范围：`apps/readest-app`（自托管分支，Windows / Android 为主测平台）
- 视觉原型：`.superpowers/brainstorm/1789887001-58789/content/`（`intro.html`、`visual-style.html`、`layout.html`）

## 1. 背景与目标

自托管用户的书架规模常达数百本，收藏远多于阅读，选书时容易陷入决策困难。现有书架只有搜索、排序、分组，没有任何「帮我选一本」的能力。

目标：在书架页提供一个「随机选书」入口，以封面滚轮动画随机抽出一本书，并给出结果卡片供用户一键开始阅读。随机前可对候选池做筛选（分组白名单 / 分组黑名单 / 排除指定书籍），筛选状态持久化。

成功标准：

- 从书架打开随机选书弹窗不超过 1 次点击。
- 可在弹窗内把候选池从全库收窄到任意分组组合，并实时看到候选数量。
- 抽出结果后 1 次点击即可进入阅读器。
- 同一会话内不会重复抽到同一本书，直到候选池被抽空。
- 筛选状态在应用重启后保持。

### 非目标（本次不做）

- 不按阅读状态过滤（未读完 / 在读 / 已读）—— 交互澄清时用户明确未选择这些维度。
- 不做跨设备同步筛选规则（与 `libraryGroupBy` 一致，属设备本地偏好）。
- 不做抽签历史、统计或推荐算法（纯均匀随机）。
- 不重构 `GroupingModal`。
- 不支持批量粘贴书籍 hash 作为排除项。

## 2. 交互流程

### 2.1 入口

书架顶部工具栏（`LibraryHeader`）动作区新增一个骰子图标按钮，位于「导入书籍」下拉之前，「选择书籍」按钮之后。桌面与移动端均显示。点击后打开随机选书弹窗。

不新增菜单项，不新增快捷键。

### 2.2 弹窗布局

桌面端左右两栏；移动端（`appService?.isMobile || window.innerWidth <= 640`）改为上下堆叠，筛选面板折叠为可展开抽屉。

```
┌────────────────────────────────────────────────────────────┐
│ 随机选书                                              ✕    │
├──────────────────┬─────────────────────────────────────────┤
│ 只在以下分组中随机 │                                         │
│  [chip] [chip] +  │          [ 封面滚轮 stage ]              │
│                  │               │ 指针                    │
│ 排除以下分组       │                                         │
│  [chip] [chip] +  │                                         │
│                  │  候选池 173 本（已排除 155 本）           │
│ 排除的书籍 · 3     │              [跳过动画] [开始随机]        │
│  《…》        ✕    │                                         │
│  + 搜索并排除书籍   │                                         │
│                  │                                         │
│ 本次会话不重复  ●开 │                                         │
│                  │                                         │
│ 恢复默认           │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

抽出结果后，右栏覆盖结果卡片：

```
┌──────────────────────────────────────────┐
│  ✦ 抽中了                                 │
│  [封面]  书名                             │
│          作者                             │
│          分组 · 格式 · 进度 / 阅读状态      │
│          [开始阅读]  [再抽一次]            │
└──────────────────────────────────────────┘
```

### 2.3 交互要点

- 两个分组选择区互相独立，**不是**二选一模式。
  - **白名单** `includeGroups`：为空表示不限制（全库）；非空时只在匹配分组内抽。
  - **黑名单** `excludeGroups`：在白名单结果之上再剔除，优先级更高。
  - 两者同时命中同一分组时，黑名单生效（该分组被排除）。
- 分组匹配为**层级前缀**语义：选中 `文学` 覆盖 `文学` 与 `文学/小说`。
- 每个分组条目显示其书目数；勾选变化即时刷新「候选池 N 本」。
- 所有规则变更自动持久化（debounce 300ms），下次打开弹窗沿用。
- 「恢复默认」清空白名单、黑名单、排除书籍，但保留 `avoidRepeats` / `skipAnimation` 开关状态。
- 滚轮动画期间可点击「跳过动画」或直接点击舞台，立即跳到终点。
- 候选池为 0：禁用「开始随机」，提示「当前筛选没有可选书籍」。
- 候选池为 1：跳过动画，直接出结果。
- 会话内候选全部抽完：提示「候选池里的书都已经抽过了」，并提供「重置已抽记录」。
- 结果卡片中「开始阅读」打开书籍并关闭弹窗；「再抽一次」回到滚轮并重新抽（当前结果计入已抽）。

## 3. 数据模型

### 3.1 规则

```ts
// src/types/settings.ts
export interface RandomPickRules {
  /** 分组全路径白名单，空数组表示全库 */
  includeGroups: string[];
  /** 分组全路径黑名单，在白名单结果之上剔除 */
  excludeGroups: string[];
  /** 被排除书籍的 hash */
  excludeBooks: string[];
  /** 本次会话内不重复抽同一本书 */
  avoidRepeats: boolean;
  /** 跳过滚轮动画 */
  skipAnimation: boolean;
}
```

在 `SystemSettings` 上新增可选字段：

```ts
/** 随机选书的候选池筛选规则。设备本地偏好，不参与设置同步。 */
randomPickRules?: RandomPickRules;
```

默认值置于 `src/services/constants.ts`，并挂到 `DEFAULT_SYSTEM_SETTINGS`：

```ts
export const DEFAULT_RANDOM_PICK_RULES: RandomPickRules = {
  includeGroups: [],
  excludeGroups: [],
  excludeBooks: [],
  avoidRepeats: true,
  skipAnimation: false,
};
```

**为什么不放进 `SETTINGS_WHITELIST`**：该规则是设备局部偏好，跨设备同步会带来「在 A 设备排除的分组在 B 设备也被排除」的意外。`libraryGroupBy`、`librarySortBy` 同样未纳入白名单，保持一致。

**为什么用分组全路径而不是 groupId**：路径可读、便于排查；层级前缀匹配天然成立；`groupId` 本身就是 `md5Fingerprint(groupName)`，两者信息等价。分组被重命名后旧路径失效，规则条目静默失配（不报错，只是不再命中），可接受。

### 3.2 会话状态

```ts
// src/store/randomPickStore.ts
interface RandomPickState {
  /** 本次会话已抽中的书籍 hash */
  pickedHashes: Set<string>;
  /** 是否正在播放滚轮动画 */
  isSpinning: boolean;
  /** 本次会话已抽数量 */
  pickCount: number;

  markPicked: (hash: string) => void;
  setSpinning: (spinning: boolean) => void;
  resetPicked: () => void;
}
```

会话状态**不持久化**：应用退出即清空。这符合「本次会话内不重复」的决策，也避免长期黑名单把用户永久锁在一个越缩越小的池子里。

## 4. 模块划分

```
src/types/settings.ts                                  (改) RandomPickRules + SystemSettings 字段
src/services/constants.ts                              (改) DEFAULT_RANDOM_PICK_RULES
src/app/library/utils/randomPickUtils.ts               (新) 纯逻辑
src/store/randomPickStore.ts                           (新) 会话状态
src/app/library/components/randompick/
  ├── RandomPickDialog.tsx                             (新) 弹窗外壳 + 编排
  ├── RandomPickFilters.tsx                            (新) 筛选面板
  ├── GroupMultiPicker.tsx                             (新) 分组层级多选器
  ├── CoverCarousel.tsx                                (新) 封面滚轮
  └── RandomPickResultCard.tsx                         (新) 结果卡片
src/app/library/components/LibraryHeader.tsx           (改) 入口按钮 + onOpenRandomPick
src/app/library/page.tsx                               (改) state + ModalPortal 渲染 + openBook 接线
```

### 4.1 纯逻辑：`randomPickUtils.ts`

无 React、无副作用、随机源可注入，便于确定性测试。

```ts
export interface CandidatePool {
  /** 最终候选池 */
  pool: Book[];
  /** 全库（未删除）书籍总数 */
  total: number;
  /** 被规则排除的数量，= total - pool.length */
  excluded: number;
}

/** 分组层级匹配：path 等于 groups 中任一项，或是其子层级 */
export function groupMatches(path: string, groups: readonly string[]): boolean;

/** 过滤非法/缺失值，补默认值。用于读取历史 settings */
export function normalizeRandomPickRules(raw: unknown): RandomPickRules;

/** 由书籍列表与规则构造候选池。入参 books 应为已剔除 deletedAt 的列表 */
export function buildCandidatePool(
  books: readonly Book[],
  rules: RandomPickRules,
): CandidatePool;

export interface PickOutcome {
  book: Book | null;
  reason?: 'empty-pool' | 'exhausted';
}

/**
 * 均匀随机抽一本。
 * @param pickedHashes 需要排除的已抽 hash（调用方按 avoidRepeats 决定是否传空集）
 * @param rng 随机源，默认 Math.random，测试注入固定序列
 */
export function pickRandomBook(
  pool: readonly Book[],
  pickedHashes: ReadonlySet<string>,
  rng?: () => number,
): PickOutcome;

export interface CarouselTrack {
  /** 轨道上的书籍，末位固定为 target */
  books: Book[];
  /** target 在轨道中的下标，= books.length - 1 */
  targetIndex: number;
  /** 终点位移的随机抖动比例，取值 ±0.35，让停位不总是像素级相同 */
  jitter: number;
}

/** 构造滚轮轨道。length 默认 36 */
export function buildCarouselTrack(
  pool: readonly Book[],
  target: Book,
  rng?: () => number,
  length?: number,
): CarouselTrack;
```

**`buildCandidatePool` 规则顺序**

1. `included` = `includeGroups` 为空 ? `books` : `books.filter(b => groupMatches(b.groupName ?? '', includeGroups))`
2. 剔除 `b.groupName` 命中 `excludeGroups` 的项
3. 剔除 `b.hash ∈ excludeBooks` 的项

注意：`groupName` 为 `undefined` 或 `''`（未分组）的书籍，在白名单非空时**不会**入选，但不会因为黑名单非空而被误伤（空路径不匹配任何非空分组项）。

**`buildCarouselTrack` 约束**

- `length < 2` 时按 2 处理。
- 末位固定 `target`。
- 前 `length - 1` 位从 `pool` 中不重复随机取；池不足时允许重复填充，但**绝不提前放入 target**（除非 `pool.length === 1`，此时整条轨道都是 target）。
- `jitter = (rng() * 0.7 - 0.35)`。

### 4.2 会话状态：`randomPickStore.ts`

标准 zustand `create`，与 `libraryStore` 同风格。`pickedHashes` 使用不可变更新（新建 `Set`），保证订阅者正确重渲染。

### 4.3 `CoverCarousel.tsx`

```ts
interface CoverCarouselProps {
  track: CarouselTrack;
  /** 轨道已就绪、开始播放动画 */
  spinning: boolean;
  /** 跳过动画（规则开关或用户点击） */
  skipAnimation: boolean;
  /** 单张封面卡片宽度（px），由容器宽度推导 */
  cardWidth: number;
  /** 动画结束或被跳过 */
  onSettled: () => void;
}
```

实现要点：

- 外层 `relative overflow-hidden`，左右各一个渐隐遮罩；中央一条绝对定位的竖向指针线。
- 内层 `flex` + `transform: translateX(...)`，`transition: transform 2200ms cubic-bezier(0.15, 0.85, 0.2, 1)`。
- 终点位移：`targetIndex * (cardWidth + GAP) - (containerWidth / 2 - cardWidth / 2)`，再加上 `jitter * cardWidth`。
- `skipAnimation` 为真时 `transitionDuration: 0s`，在 `useEffect` 里直接结算。
- 用 `onTransitionEnd` 触发 `onSettled`，并增加一个 `transitionDuration + 200ms` 的 `setTimeout` 兜底（避免 transition 被浏览器合并/中断时不回调）。
- 卡片宽度由容器宽度推导：`cardWidth = clamp(containerWidth / 7, 48, 72)`，通过 `ResizeObserver` 跟随窗口尺寸变化。
- 卡片渲染复用 `src/components/BookCover.tsx`，自动获得缩略图、隐藏封面设置与文字兜底封面，无需新写封面逻辑。
- 离中心越远的封面缩放越小、透明度越低，营造透视感（纯 CSS，按索引距离计算 inline style）。
- 抽奖前展示一条静态的占位轨道（由候选池随机生成、不做动画），作为视觉预览。

### 4.4 `GroupMultiPicker.tsx`

这是一个「选择一个分组」的单选器，由 `RandomPickFilters` 在点击「+ 添加分组」时以浮层形式打开。选中某个分组后回调 `onSelect(groupName)`，由调用方决定把该路径加入白名单还是黑名单，并关闭浮层。

- 层级导航复用 `GroupingModal` 的模式：`currentPath` state + `getGroupsByParent(currentPath)` + `getBreadcrumbs(currentPath)`，面包屑可点击回退。
- 每行显示分组名（末段）、书目数、以及「已选中」勾号。
- 分组书目数通过遍历 `visibleLibrary` 统计 `groupMatches(book.groupName, [group.name])` 得出，结果做 `useMemo` 缓存。
- **刻意不与 `GroupingModal` 抽取公共组件**：`GroupingModal` 承担单选 + 创建 + 重命名 + 移出分组，语义与多选浏览不同，硬抽公共组件的耦合成本高于此处约 40 行的导航逻辑重复。

### 4.5 `RandomPickFilters.tsx`

- 白名单区 / 黑名单区各渲染为 chip 列表 + 「+ 添加分组」按钮（打开 `GroupMultiPicker` 弹层）。
- 已选分组 chip 支持点 `✕` 移除。
- 「排除的书籍」区：当前排除项列成列表（书名 + `✕`），底部「+ 搜索并排除书籍」打开一个带搜索框的浮层。搜索复用 `../utils/libraryUtils.ts` 已导出的 `createBookFilter(queryTerm)`，与书架搜索保持完全一致的匹配范围（标题、作者、格式、分组、标签、描述、Calibre 自定义列）。结果按 `formatTitle(book.title)` 排序，最多渲染 50 条。点击条目标记为排除，已在排除列表中的条目显示为勾选态，再次点击取消排除。
- 「本次会话不重复」开关。
- 「跳过动画」开关。
- 「恢复默认」按钮。
- 规则变更通过 `onChange(patch: Partial<RandomPickRules>)` 冒泡给 `RandomPickDialog`。

### 4.6 `RandomPickDialog.tsx`

```ts
interface RandomPickDialogProps {
  onClose: () => void;
  onOpenBook: (book: Book) => void;
}
```

职责：

1. 读取 `useLibraryStore().visibleLibrary` 与 `getGroups()`。
2. 本地维护 `rules` state，初始化自 `settings.randomPickRules`（经 `normalizeRandomPickRules` 兜底）。
3. 规则变更后 debounce 300ms 写回设置：`setSettings(next)` + `await saveSettings(envConfig, next)`。
4. `useMemo` 计算 `candidatePool`。
5. 「开始随机」：
   - `pickRandomBook(pool, rules.avoidRepeats ? pickedHashes : EMPTY_HASH_SET)`，其中 `EMPTY_HASH_SET` 是模块级 `new Set<string>()` 常量，避免每次渲染新建实例。
   - 失败按 `reason` 给出对应提示文案
   - 成功则 `buildCarouselTrack` → `setSpinning(true)` → 动画结束 `onSettled` → 展示结果卡片、`markPicked(target.hash)`、`setSpinning(false)`
6. 「再抽一次」「跳过动画」「重置已抽记录」「开始阅读」的接线。
7. 挂载在 `ModalPortal` 内；点击遮罩关闭。

### 4.7 接线改动

`LibraryHeader.tsx`：

- props 新增 `onOpenRandomPick: () => void`。
- 在 `searchTarget !== 'text'` 分支的动作区内、`ImportMenu` 下拉之前插入按钮，图标使用 `react-icons/fa` 的 `FaDice`（已确认该导出存在），带 `aria-label={_('Random Pick')}` 与 `title`。

`library/page.tsx`：

- `LibraryPageContent` 内新增 `const [showRandomPick, setShowRandomPick] = useState(false)`。
- 向 `<LibraryHeader>` 传 `onOpenRandomPick={() => setShowRandomPick(true)}`。
- 页面内渲染：
  ```tsx
  {showRandomPick && (
    <ModalPortal>
      <RandomPickDialog onClose={() => setShowRandomPick(false)} onOpenBook={...} />
    </ModalPortal>
  )}
  ```
- 页面**新增**一个 `useOpenBook({ setLoading, handleBookDownload })` 实例取得 `openBook`（书架页原本没有，它只存在于 `Bookshelf` / `BookshelfItem` 内部），再以 `onOpenBook` 注入弹窗；弹窗调用后由页面先关闭弹窗再打开书籍。这样弹窗 API 保持纯粹，同时复用了按需下载与失效文件清理的既有逻辑。

## 5. i18n

英文原文即 key，直接写在代码里，随后运行 `pnpm i18n:extract`。中文译文补入 `public/locales/zh-CN/translation.json`。

新增 key 清单：

| key | 中文译文 |
| --- | --- |
| `Random Pick` | 随机选书 |
| `Only pick from these groups` | 只在以下分组中随机 |
| `Exclude these groups` | 排除以下分组 |
| `Add Group` | 添加分组 |
| `No Groups` | 暂无分组 |
| `All Books` | 全部书籍 |
| `Excluded Books` | 排除的书籍 |
| `Search and exclude books` | 搜索并排除书籍 |
| `No books match` | 没有匹配的书籍 |
| `Avoid repeats in this session` | 本次会话不重复 |
| `Skip Animation` | 跳过动画 |
| `Candidate Pool` | 候选池 |
| `{{count}} Book(s)` | {{count}} 本 |
| `{{count}} excluded` | 已排除 {{count}} 本 |
| `No books match the current filters` | 当前筛选没有可选书籍 |
| `All candidate books have been picked` | 候选池里的书都已经抽过了 |
| `Reset Picked` | 重置已抽记录 |
| `Picked this session` | 本次已抽 |
| `Pick Result` | 抽中了 |
| `Spin Again` | 再抽一次 |
| `Start Reading` | 开始阅读 |
| `Restore Defaults` | 恢复默认 |
| `Random Pick Book` | 随机一本书 |

带数量的文案统一使用 `_('{{count}} Book(s)', { count })` 形式，与仓库现有用法一致。

## 6. 测试

### 6.1 纯函数单测 —— `src/__tests__/utils/random-pick-utils.test.ts`

覆盖：

- `groupMatches`：精确匹配、子层级匹配、`/` 边界（`文学` 不匹配 `文学史`）、空路径、空列表。
- `normalizeRandomPickRules`：`undefined`、缺字段、类型错误、多余字段。
- `buildCandidatePool`：
  - 空规则 = 全库
  - 仅白名单
  - 仅黑名单
  - 白黑名单叠加（黑名单优先）
  - 白黑名单同时命中同一分组 → 排除
  - 未分组书籍在白名单非空时被排除
  - 书目排除
  - 空池
  - `total` / `excluded` 计数正确
- `pickRandomBook`：
  - 注入固定 `rng` 的确定性断言（均匀落在预期下标）
  - 排除已抽
  - 池被抽空 → `reason: 'exhausted'`
  - 空池 → `reason: 'empty-pool'`
- `buildCarouselTrack`：
  - 末位恒为 target
  - 池大于轨道长度时不重复
  - 池不足时允许重复但不提前出现 target
  - 池只有 1 本时整条轨道都是它
  - `jitter` 落在 `[-0.35, 0.35]`

### 6.2 组件测试 —— `src/__tests__/components/RandomPickDialog.test.tsx`

参照 `src/__tests__/components/BookCover.test.tsx` 的 provider / store mock 模式。覆盖：

- 候选池为 0 时「开始随机」禁用
- 候选池为 1 时点击后直接出现结果卡片（不经过动画等待）
- 空 `pickedHashes` 时正常出结果；用固定 `Math.random` mock 保证确定性
- 会话内抽完 → 展示耗尽提示
- 「开始阅读」调用传入的 `onOpenBook` 并携带正确的书

动画在测试中使用 `skipAnimation` 规则或 fake timers 跳过，不对 2.2 秒 transition 做真实等待。

### 6.3 质量门

- `pnpm lint`（`tsc --noEmit` + `biome lint`）通过
- 新增测试与既有测试全绿
- 手动在 Tauri 桌面端验证一次完整流程（打开 → 筛选 → 抽奖 → 跳过动画 → 打开阅读器）

## 7. 打包

在 `apps/readest-app` 下执行：

```bash
pnpm build-server-win-x64-64bit
```

该脚本展开为 `dotenv -e .env.tauri.local -e .env.server -- tauri build --target x86_64-pc-windows-msvc --bundles nsis`，其中 `beforeBuildCommand` 会带上 `.env.server` 与 `.env.tauri.local` 执行 `next build --webpack`，因此自托管标识 `NEXT_PUBLIC_SELFHOSTED=1` 会参与构建。

产物路径：

```
apps/readest-app/src-tauri/target/release/bundle/nsis/*_x64-setup.exe
```

前置检查（实现时执行）：确认 `.env.tauri.local` 与 `.env.server` 存在；确认第一次构建前 `pnpm install` 已完成。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 大量封面同时渲染导致卡顿 | 轨道长度固定 36 张；`BookCover` 本身 memo 且懒加载；离中心远的卡片降低渲染细节 |
| `onTransitionEnd` 未触发导致流程卡死 | `setTimeout` 兜底结算 |
| 分组数量极多时筛选面板过长 | 面板内可滚动；分组浏览采用层级导航而非平铺全量列表 |
| 老版本设置无 `randomPickRules` | `normalizeRandomPickRules` 统一兜底 |
| 规则写回 settings 过于频繁 | debounce 300ms |
| 分组重命名后规则失配 | 静默失配（不命中即不生效），用户重新勾选即可 |
