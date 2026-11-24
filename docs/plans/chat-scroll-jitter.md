# 长会话向上翻历史抖动：复现、量化与实施方案

状态：**待评审（本文档不含产品代码改动）**
基线：`8d40297`（= origin/main），工作分支 `docs/chat-scroll-plan`
测量日期：2026-11-04
范围：`src/web` 聊天时间线（Timeline / ChatMessage / chat-styles / useRoomChat）与相关测试

---

## 0. 结论摘要（TL;DR）

1. **抖动的直接来源不是帧率，而是滚动位置补偿本身。** 在本机隔离实例上，每次“加载更早”插入 50 条消息时，列表会先出现 **一帧 6,850–9,509 px 的内容位移**，随后 9–117 ms 才由 JS 补偿回来；补偿有时**完全没有发生**（桌面 24 次采样中 4 次，移动端 6 次中 0 次但出现 7,470 px 的错误补偿）。补偿之后，Markdown 岛异步挂载、图片/文件卡异步出图、`content-visibility` 重新测量高度，还会制造 **0–24,866 px 的二次漂移**。
2. **1000 条消息全部挂载后，纯滚动仍是 60 fps**（本机 headless Chromium：p50 16.7 ms、p95 16.8 ms、p99 33.3 ms、无长任务）。因此“虚拟滚动”不是当前帧率瓶颈的解，它会**把同一个问题换成“动态高度测量 + prepend 锚定”**，必须显式解决，否则抖动不会消失。
3. **推荐主方案 A（先修锚定与高度稳定性，不引入新依赖）**，分两小步：A2 元素级连续锚定 + 高度预留；A1 用 `overflow-anchor: auto` 做对照实验。**备选方案 C（react-virtuoso）** 只在阶段一后 3k/5k 场景仍不达标，或产品决定给 DOM 设上限时启用。
4. 拒绝方案 D（成熟 IM 框架）：`matrix-react-sdk` 是 **AGPL-3.0-only OR GPL-3.0-only**（与 Apache-2.0 产品不兼容），且要求自建 homeserver；`stream-chat-react` 的许可为 “SEE LICENSE IN LICENSE”（商业许可）并依赖 Stream 托管服务。两者都要替换 MCP 后端，违反“不改协议”的边界。

---

## 1. 复现环境与方法

### 1.1 环境

| 项 | 值 |
| --- | --- |
| 代码 | worktree `/tmp/agentnet-scroll-plan`，`8d40297`，`bun run build:web` 产出 `dist/web` |
| 服务 | `bun src/bun/main.ts`，`PORT=8799`，`DATA_DIR=/tmp/agentnet-scroll-data`（隔离 SQLite），`ENVIRONMENT=test`，`PUBLIC_ORIGIN=http://127.0.0.1:8799` |
| 浏览器 | Playwright 1.64 自带 Chromium，headless，DPR 1 |
| 视口 | 1280×900（桌面）、390×844（移动，`isMobile/hasTouch`） |
| 网络 | 本机回环，无 RTT 注入；所有数据由真实 MCP 工具调用写入 |

> 说明：这是**本机基线**，不是生产基线。绝对值随内容类型、机器性能、浏览器版本变化；结论依赖的是**同一环境下的相对差异**（有/无修复、开/关 `content-visibility`）。

### 1.2 种子数据

三个群聊房间：**1,000 / 3,000 / 5,000** 条消息，同一套内容配比（消息由人类与 Agent 混合发出）：

| 类型 | 比例 | 内容 | 行高特征（实测） |
| --- | --- | --- | --- |
| 纯文本 | ~60% | 1–2 行，或 3 行短段落 | 中位 90 px |
| 中等 Markdown | ~15% | 标题 + 3 条列表 | ~150–220 px |
| 长 Markdown | ~8% | 标题 + 表格 + 代码块 + 引用，约 20 行 | 最大 568 px |
| 图片附件 | ~4% | 512×512 PNG 上传后以 `/f/<id>` 写入正文 | 缩略图约 240 px |
| 文件卡 | ~5% | `.md` 文档 `/f/<id>` | ~72 px |
| 消息式 Task | 每 41 条一个起点 | `network_task_mark` | 摘要行 ~40 px 增量 |
| 时间胶囊 / 系统行 | 自动 | 超过 5 分钟间隔、presence | 32 px |

代码引用：`src/web/features/chat/Timeline.tsx`（时间胶囊 `TIME_GAP`）、`src/web/features/chat/ChatMessage.tsx`（Markdown / 文件卡 / Task 摘要）、`src/contracts/limits.ts`（分页与阈值）。

### 1.3 指标定义

每次“加载更早”都记录一个 **prepend 事件**，取首个可见消息（anchor）作为参照：

| 指标 | 定义 | 期望 |
| --- | --- | --- |
| `preJump` | 计数增加的那一帧，anchor 的 `getBoundingClientRect().top` 相对插入前的变化 | 0（当前 6.8k–9.5k px） |
| `correctionDelayMs` | 从计数增加到 `scrollTop` 首次改变的时间 | ≤1 帧 |
| `correctedDrift` | 补偿后 anchor 相对插入前的位置偏差 | ≤2 px |
| `lateDrift` | 补偿后到 +3 s 之间 anchor 的最大偏移 | ≤2 px |
| `missed` | 计数增加后 3 s 内 `scrollTop` 从未改变（补偿丢失） | 0 |
| `CLS` | `PerformanceObserver('layout-shift')` 中 `hadRecentInput === false` 的 `value` 之和 | ≤0.05 / 次 |
| `longTask` | `PerformanceObserver('longtask')` 最长条目 | <50 ms |
| 帧间隔 | rAF 间隔 p50 / p95 / p99 / max | p95 ≤ 20 ms |
| `S` 不变量 | 滚轮场景下 `anchorTop + scrollTop`，理想恒定 | 单帧变化量 ≤2 px |

滚轮场景用 `S = anchorTop + scrollTop` 是最贴近平滑性的度量：只要 anchor 在视口中的位置与滚动位置之和不变，用户看到的内容就不跳；任何 `ΔS` 都是可见位移。

### 1.4 方法学局限

- headless Chromium 无法确认“某帧是否真的上屏”，`preJump` 是**渲染管线里的错位**，通常至少对应 1 帧可见闪烁；需要在真机上复核（见开放问题 4）。
- 未注入 CPU/网络降速；低端机上 `lateDrift` 的时间窗会更长。
- 三个房间的消息内容由同一生成器产出，横向可比，但不能代表线上真实分布。

---

## 2. 实测基线

### 2.1 首次进入房间（50 条）

| 房间 | 首屏就绪 | `#messages` 子节点 | `scrollHeight` | 行高中位/p95 | 首屏 CLS | 最长任务 |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 450 ms | 598 | 8,286 px | 90 / 568 px | 0.287 | 50 ms |
| 3,000 | 441 ms | 626 | 7,876 px | 90 / 194 px | 0.296 | 0 ms |
| 5,000 | 428 ms | 637 | 8,871 px | 90 / 568 px | 0.397 | 0 ms |
| 390×844 | 402 ms | 598 | 8,830 px | 90 / 634 px | 0.000 | 51 ms |

首屏 CLS 来自骨架屏 → 真实内容；属于既有行为，不是本次抖动的主诉，但会与后续抖动叠加。

### 2.2 桌面 1280×900：连续向上加载（每页 50 条，每次观察 3 s）

**1,000 条房间**

| 起始条数 → 新增后 | `preJump` | 补偿延迟 | `correctedDrift` | `lateDrift` | CLS |
| --- | --- | --- | --- | --- | --- |
| 50 → 100 | 7,381 px | 9 ms | 0.0 px | 32 px | 0.002 |
| 100 → 150 | 8,791 px | 10 ms | 0.5 px | 0 px | 0.000 |
| 150 → 200 | 7,045 px | 16 ms | 456.3 px | 74.1 px | 0.325 |
| 200 → 250 | 7,610 px | 25 ms | −573.8 px | 274 px | 0.454 |
| 250 → 400（级联 3 页） | 8,223 px | 73 ms | **8,703 px** | **15,081 px** | 1.479 |
| 400 → 450 | 8,324 px | 36 ms | 125.6 px | 0 px | 0.449 |
| 450 → 600（级联） | 7,246 px | 101 ms | **6,731.5 px** | **8,682 px** | 1.357 |
| 600 → 更早（级联） | 7,969 px | 117 ms | **8,182.3 px** | **24,866 px** | **2.172** |

**3,000 条房间**

| 起始 → 新增后 | `preJump` | 延迟 | `correctedDrift` | `lateDrift` | CLS |
| --- | --- | --- | --- | --- | --- |
| 50 → 100 | 8,288 px | 14 ms | 4.2 px | 0 px | 0.000 |
| 100 → 150 | 7,258 px | 12 ms | −0.3 px | 274 px | 0.076 |
| 150 → 200 | 8,268 px | 14 ms | 3.1 px | 278 px | 0.537 |
| 200 → 250 | 8,995 px | — | **丢失** | — | 0.369 |
| 300 → 350 | 7,168 px | 62 ms | **6,865.7 px** | **8,116.6 px** | 0.854 |
| 400 → 450 | 8,806 px | — | **丢失** | — | 0.341 |
| 450 → 500 | 7,883 px | 33 ms | 384.3 px | **8,092.4 px** | 0.468 |
| 550 → 600 | 7,261 px | 97 ms | **7,510.9 px** | **23,972.9 px** | **2.036** |

**5,000 条房间**

| 起始 → 新增后 | `preJump` | 延迟 | `correctedDrift` | `lateDrift` | CLS |
| --- | --- | --- | --- | --- | --- |
| 50 → 100 | 8,757 px | 9 ms | −274.3 px | 0 px | 0.344 |
| 100 → 150 | 7,560 px | 11 ms | −0.3 px | 278 px | 0.000 |
| 150 → 200 | 8,279 px | 14 ms | 1,854.1 px | 0 px | 0.354 |
| 200 → 250 | 7,845 px | 16 ms | −589.9 px | 74 px | 0.395 |
| 250 → 300 | 7,936 px | 17 ms | 104.2 px | 4 px | 0.401 |
| 300 → 350 | 7,956 px | — | **丢失** | — | 0.332 |
| 350 → 400 | 7,956 px | 60 ms | −0.3 px | **9,812.3 px** | 0.503 |
| 450 → 500 | 8,415 px | — | **丢失** | — | 0.349 |

**汇总（桌面 24 次预置事件）**

- `preJump`：7,045–8,995 px，**每一次都会发生**。
- 补偿延迟：9–117 ms（1–7 帧）。
- 补偿丢失：**4/24**（1k 0/8、3k 2/8、5k 2/8）。丢失后列表停在错误位置，且因为 `scrollTop` 不再变化，**自动加载也随之停住**（实测 3,000 条房间在 70 次滚动尝试后只加载到 450 条）。
- 补偿成功时仍可能偏 0–1,854 px；出现级联加载时偏差 6,700–8,700 px。
- 每次事件 CLS：0–2.172（桌面），0–3.047（移动端）。

### 2.3 移动端 390×844

| 起始 → 新增后 | `preJump` | 延迟 | `correctedDrift` | `lateDrift` | CLS |
| --- | --- | --- | --- | --- | --- |
| 50 → 100 | 7,887 px | 8 ms | 0 px | 52 px | 0.010 |
| 100 → 150 | 9,509 px | 10 ms | 1 px | 0 px | 0.000 |
| 150 → 200 | 6,899 px | 13 ms | 665 px | 228 px | 0.393 |
| 200 → 350（级联） | 6,850 px | 59 ms | **7,470 px** | **16,537 px** | **3.047** |
| 350 → 400 | 8,701 px | 23 ms | 1,378 px | 52 px | 1.221 |
| 400 → 450 | 8,060 px | 30 ms | −105 px | 0 px | 0.738 |

移动端行高更高（p95 634 px），同样的补偿误差换算成更大的视觉位移。

### 2.4 滚轮上翻（3,000 条房间，已加载 350 条，真实 `mouse.wheel`）

- 9 秒内 `S = anchorTop + scrollTop` 累计漂移 **19,123 px**。
- 单帧最大可见位移 **8,790 px**；>4 px 的跳变帧 **31 帧**。
- 典型事件：计数 350→400 时 `S` 先跳 **+8,137 px**，约 20 ms 后由 `scrollTop` 补回（`ΔS ≈ −110 px`）。用户看到的是“内容整体向下闪一下再回来”。

### 2.5 DOM 规模与纯滚动成本

| 已加载条数 | `#messages` 子节点 | `scrollHeight` | 滚动帧 p99 / max | >50 ms 帧 | 长任务 |
| --- | --- | --- | --- | --- | --- |
| 450 | 5,562 | 73,504 px | 83.4 / 233.3 ms | 3 | 5 个，最长 97 ms |
| 1,000 | 12,668 | 166,630 px | 33.3 / 33.4 ms | 0 | 0 |

结论：**DOM 规模不是当前的主因**；帧成本与滚动位置（哪些行被 `content-visibility` 跳过、哪些在挂载 Markdown）强相关，而不是单调随条数增长。1,000 行仍能 60 fps，但长任务在加载阶段最高到 143 ms。

### 2.6 变体对照（3,000 条房间，6 次加载，运行时注入 CSS）

| 变体 | 补偿结果 | `lateDrift` | CLS | 备注 |
| --- | --- | --- | --- | --- |
| 基线 | 3 次准确、**1 次丢失** | 0–278 px | ≤0.537 | 第 3 次加载 28 行合计改写 3,931.5 px 高度 |
| `overflow-anchor: auto` | 4 次准确、**1 次丢失** | 0 / 274 / **7,944 px** | ≤0.353 | 一帧 `preJump` 不变（程序化滚动抑制了原生锚定） |
| 关闭 `content-visibility` | **6/6 准确** | 0–274 px | ≤0.375 | 高度改写从 3,931 px 降到 4 px |
| `contain-intrinsic-size: none` | 偏差 86–5,106 px | **18,449 px** | **1.524** | 比现状更差，估算值必须保留 |
| `overflow-anchor: auto` + 关闭 CV | 5/6 准确、1 次丢失 | 0–274 px | ≤0.375 | 原生锚定不是稳定解 |

---

## 3. 抖动来源归因

### 3.1 主因：一次性 `scrollHeight` 差值补偿（`Timeline.tsx:242-258`）

```ts
const beforeHeight = element.scrollHeight;
const beforeTop = element.scrollTop;
await onLoadOlder();
requestAnimationFrame(() => {
  next.scrollTop = beforeTop + (next.scrollHeight - beforeHeight);
});
```

三个结构性缺陷：

1. **补偿晚于提交**：`rAF` 在 `await` 之后注册，可能落在 React 提交之后的下一帧。计数已增加、内容已上移，`scrollTop` 还是旧值——这解释了 `preJump` 恒为 7–9k px、`correctionDelayMs` 9–117 ms。
2. **读数可能早于提交**：如果 `rAF` 在 React 提交之前执行，`next.scrollHeight` 仍是旧值，差值为 0——这解释 `missed`（补偿彻底丢失，列表永久停在错误位置）。
3. **读数可能早于高度稳定**：Markdown 岛、图片卡、`content-visibility` 的最终高度都在之后才确定。所以即使补偿“成功”，`lateDrift` 仍可达 24,866 px，并可能把 `scrollTop` 留在顶部 10% 以内，触发**级联加载**（250→400、450→600），进一步放大偏差。

### 3.2 次因 A：Markdown 岛异步挂载（`MarkdownIsland.tsx:82-103`）

`useEffect` 里动态 `import()` 后 `mountMarkdown`，每个可见的 Agent 消息都是一个岛。每次加载较早一页，会新挂载 **72–86 个**岛；消息行从只有气泡内边距的空占位长到 200–568 px。实测中反复出现的 **274 px `lateDrift`** 就来自一行长 Markdown。

### 3.3 次因 B：图片 / 文件卡没有保留尺寸（`MessageFileCard.tsx:252-259`，`chat-message-files-styles.ts:22`）

```css
.msg-file-thumb img { display: block; width: 100%; height: auto; ... }
```

`<img>` 没有 `width`/`height`，也没有 `aspect-ratio`；文件元数据由 `IntersectionObserver`（`rootMargin: 160px`）懒加载。卡片先以“文件行”高度出现，元数据到达后插入缩略图，行高增加约 240 px。`RoomFileItem` 当前也没有宽高字段（`src/web/lib/files-ui.ts:10-24`）。

### 3.4 次因 C：`content-visibility` 的估算误差（`chat-styles.ts:507-510`）

- 只在 ≥200 条时启用（`LIMITS.webLongMessageListThreshold`）。
- 纯文本行估算 180 px，实测中位 90 px；时间/系统行估算 32 px，基本准确。
- 实验：关闭 CV 后 6/6 补偿成功、成批高度改写消失；但 `contain-intrinsic-size: none` 会让情况更糟（late 18,449 px）。结论是**保留 CV，但不要把 `scrollHeight` 当作锚定依据**，并把估算值调到更接近真实的 90–96 px。

### 3.5 次因 D：级联加载与滚动事件耦合（`Timeline.tsx:260-284`）

补偿本身会触发 `scroll` 事件；如果补偿后仍在顶部 10% 区间（`LIMITS.webOlderAutoTopRatio = 0.1`），会立刻再加载一页。级联期间每一页都在不稳定的高度上计算补偿，形成“越翻越飘”。

### 3.6 非主因

- **帧率**：1,000 行纯滚动 60 fps（见 2.5）。
- **`scrollbar-gutter: stable`**：未观测到横向宽度抖动，不是来源。
- **React 重渲染**：`ChatMessage` 已 `memo`（`ChatMessage.tsx:427`），新增行才渲染；长任务主要来自 Markdown 挂载与布局。
- **`overflow-anchor: none` 本身**：关闭它是必要的（否则原生锚定与手动补偿会叠加），但它不是抖动的根因；单纯改回 `auto` 也不能解决（见 2.6）。

---

## 4. 方案矩阵

评分口径：改动面 / 风险 / 性能上限 / 与搜索、置顶、Task、已读、锚点跳转、移动端的兼容性 / bundle 与入口预算 / 测试成本 / 回滚难度。

### A. 保留 DOM 窗口，修锚定与高度稳定性（不虚拟化）

**A1 原生锚定实验**：`overflow-anchor: auto` + 关闭 JS 补偿。
**A2 元素级连续锚定**：记录首个可见消息的 id 与其相对列表顶部的偏移；在 `MutationObserver` + `ResizeObserver` + rAF 中**幂等**校正 `scrollTop`，直到位置稳定（如连续 3 帧误差 ≤2 px 或 1 s 超时）；用户 wheel/touch/keydown 立即让出控制权。

| 维度 | 评估 |
| --- | --- |
| 改动面 | `Timeline.tsx`（锚定与自动加载去抖，约 120 行）、`chat-styles.ts`（估算值/占位）、`chat-message-files-styles.ts`（图片占位）、`MarkdownIsland.tsx`（预加载/占位） |
| 风险 | 中。锚定循环若与“回到底部”pin 逻辑互相拉扯，会出现回弹；需要明确的优先级：**pin > 锚定 > 自动加载** |
| 性能上限 | 不减少 DOM，长会话（>2,000 条）长任务仍会升高；但滚动位置正确性可做到 ≤2 px |
| 兼容性 | 完全兼容。`data-message-id` 仍在 DOM，搜索/置顶/Task/引用跳转不改 |
| bundle | 0 新增；入口 749.14 kB / 上限 972.8 kB 不变 |
| 测试成本 | 低。新增抖动用例；既有 79 处 `#messages .msg` 选择器引用不用改 |
| 回滚 | 极易。改回旧补偿函数或加一个 `LIMITS` 开关即可 |

### B. `@tanstack/react-virtual`

| 维度 | 评估 |
| --- | --- |
| 改动面 | `Timeline.tsx` 重写为虚拟列表；`ChatMessage` 需 `measureElement`；搜索/置顶/Task 的 DOM 反查改为索引 API；约 4 处 `data-message-id` 反查点 |
| 风险 | 高。它**不为聊天设计**：没有 `firstItemIndex`，prepend 必须手动平移 `scrollTop`，与现有“加载更早”逻辑重复；变量高度需自己维护 cache 与估算 |
| 性能上限 | 高（DOM 恒定 ~20–40 行），但动态测量误差会造成轻微跳动 |
| 兼容性 | 破坏。`ChatPage.tsx:425-432`、`ChatMessage.tsx:155-195`、`useChatSearchNavigation.ts:11-17`、`Timeline.tsx:209-225` 都依赖“目标消息在 DOM 里” |
| bundle | wrapper 14.4 kB min / 4.5 kB gzip + `@tanstack/virtual-core` ~28.3 kB min；合计约 43 kB min / ~13 kB gzip（bundlephobia 3.13.12）。放 ChatPage 动态 chunk，不动入口预算 |
| 测试成本 | 高。`pagination.spec.ts` 断言 `toHaveCount(50/100/151)`，79 处 `#messages .msg` 选择器引用需要重写 |
| 回滚 | 中。需要保留双路径一段时间 |

### C. `react-virtuoso`

`firstItemIndex`（prepend 不移动既有索引）、`followOutput`（贴底）、`initialTopMostItemIndex`（跳转）、内置 ResizeObserver 动态测量——**正是聊天场景需要的三件事**。

| 维度 | 评估 |
| --- | --- |
| 改动面 | 同上，但少一层“自己实现 prepend 锚定”；`firstItemIndex` 随已加载更早页数递减即可 |
| 风险 | 中高。主要是 DOM 契约与测试重写；虚拟化后的“跳转到任意消息”需要先确保目标在窗口数据里（现有 anchor window 机制已提供） |
| 性能上限 | 最高。DOM 恒定，长会话内存与布局成本可预期 |
| 兼容性 | 部分破坏：`Ctrl+F`、跨消息选中复制、打印、无障碍树只覆盖窗口；搜索/置顶/Task 需改走 `scrollToIndex` |
| bundle | 4.18.24：MIT、0 runtime 依赖、57.2 kB min / **18.4 kB gzip**（bundlephobia 4.14.0）。放 ChatPage chunk，不影响入口预算 |
| 测试成本 | 高（同 B） |
| 回滚 | 中。建议以运行时开关 + 双路径保留一个迭代 |

### D. 成熟 IM UI / 框架

| 候选 | 许可 | 自托管 | 结论 |
| --- | --- | --- | --- |
| `matrix-react-sdk` 3.114.0 | **AGPL-3.0-only OR GPL-3.0-only** | 需自建 Matrix homeserver + `matrix-js-sdk` | **不可用**：许可与 Apache-2.0 产品不兼容；且等于替换 MCP 后端 |
| `stream-chat-react` 15.0.2 | `SEE LICENSE IN LICENSE`（商业） | 依赖 Stream 托管后端 + `stream-chat` | **不可用**：托管服务 + 商业许可；其内部本身依赖 `react-virtuoso` |
| Sendbird 等 | 商业 | 托管 | **不可用**：同上 |

这些方案解决的是“整套聊天产品”，不是“这一列的滚动”；改造量（数据模型、消息协议、权限、文件、投递回执）远超本项目边界。

### E. 混合：短会话保持现状，长会话虚拟化 / 分段窗口

| 维度 | 评估 |
| --- | --- |
| 改动面 | 阈值 + 双路径（`Timeline` 与 `VirtualTimeline`），约 1.5 倍于 C 的维护成本 |
| 风险 | 中。两套渲染路径的行为差异（滚动、定位、选中、a11y）容易长期漂移 |
| 性能上限 | 与 C 相同（超过阈值后） |
| 兼容性 | 短会话完全不变；长会话同 C |
| bundle | 同 C，但只在长会话时才需要加载（可 `lazy`） |
| 测试成本 | 高（长短两套都要测） |
| 回滚 | 易（阈值调到无穷大） |

**矩阵结论**：A 是唯一能“只修根因、不动契约”的方案；C 是唯一“库级正确抽象”的方案；B 缺少 prepend 语义；D 出局；E 是 C 的灰度外壳。

---

## 5. 推荐方案

### 5.1 主推：A2（元素级连续锚定 + 高度预留），A1 作为对照实验

理由：

1. 实测表明根因是**补偿时机与依据**，不是 DOM 数量。A2 直接对症：用元素位置而不是 `scrollHeight` 差值，且**持续校正**而不是一次性校正。
2. 兼容成本最低：不改 DOM 契约、不改 4 处反查、不改 79 处测试选择器引用、不动入口预算。
3. 可独立验证：阶段 0 的测量夹具能给出“修前失败、修后通过”的硬证据，避免“感觉变好了”。

**A2 的具体机制**

```text
不变量：S = anchorTop + list.scrollTop
  当 anchor 这一行在屏幕上没有被“用户意图”移动时，S 应恒定。
  任何 S 的变化（内容插入、Markdown 挂载、图片出图、CV 重测）都是抖动。

onLoadOlder 前：
  anchorId   = 视口内第一条 .msg[data-message-id]
  expectedS  = anchorTop + list.scrollTop

提交时（useLayoutEffect，DOM 变更后、绘制前，同步执行一次）：
  restore()                       // 消除“一帧 7–9k px”的错位

之后（settle 窗口，最多 1s 或连续 3 帧稳定）：
  MutationObserver(list) → schedule()
  ResizeObserver(list)   → schedule()
  schedule(): rAF 中执行 restore()

restore():
  s = anchorTop + list.scrollTop
  if |s - expectedS| > 2px: list.scrollTop += (expectedS - s)   // 幂等
  // 用户滚动时不“停止校正”，而是把用户的位移计入期望值：
  // wheel / touchmove / keydown 时 expectedS = 当前 s（吸收用户意图）
```

要点：

- **两段式**：`useLayoutEffect` 同步修一次（保证不出现错位帧），settle 循环修之后的高度变化（保证 `lateDrift` 收敛）。
- **幂等**：晚到的 Markdown/图片高度变化会被后续帧继续校正。
- **不读 `scrollHeight`**：`content-visibility` 的估算值不再影响锚定。
- **不跟用户抢**：用户输入时把位移吸收进 `expectedS`，只抵消非用户意图的位移；这样滚轮上翻过程中发生的加载也能被修好（这正是 2.4 的场景）。
- **优先级**：`pinned`（贴底）> 锚定 > 自动加载。贴底时锚定让位，避免回弹。
- **自动加载去抖**：只在“用户产生的滚动”上触发；程序化校正引发的 `scroll` 不计；补偿稳定前不再加载（消除 3.5 的级联）。

### 5.2 备选：C（react-virtuoso）

触发条件（任一）：

- 阶段一完成后，已加载 ≥1,500 条时仍出现 >100 ms 长任务或滚动 p95 >25 ms（低端机/真机基线）；
- 产品决定给 DOM 设硬上限（内存、打印、低端机）；
- 需要支持 10k+ 条的超长会话常驻。

若采用 C，三个难点的处理方式：

1. **变量高度**：`ResizeObserver` 测量 + 以 `message_id` 为键的高度缓存（跨卸载/重挂载复用）；按消息类型给初值（纯文本 96 px、Markdown 240 px、图片 300 px、时间胶囊 32 px）；**虚拟模式下关闭 `content-visibility`**（它和虚拟化的测量职责冲突）。
2. **prepend**：用 `firstItemIndex` 递减，既有项索引不变；锚定以 key 为准，不按索引；`startReached` 触发加载，加载后由 Virtuoso 自行保持视觉位置。
3. **图片**：必须先占位再出图——给 `.msg-file-thumb` 固定 `aspect-ratio`（默认 4/3，`object-fit: cover`），或从文件元数据补 `width/height`（需跨 MCPP Files 契约，见开放问题 3）；`loading="lazy"` + `decoding="async"` 保留。

### 5.3 不推荐现在做 B / D / E

- B：缺少 prepend 语义，等于自己实现 Virtuoso 的 `firstItemIndex`。
- D：许可与后端模型不匹配（见 4.D）。
- E：在 A 尚未验证前引入双路径，维护成本先付、收益不确定；把它作为 C 的灰度外壳即可。

---

## 6. 分阶段实施计划

> 原则：先能测量，再修低风险项，最后才考虑引入依赖。每阶段结束都有可回滚的开关与可执行的验收。

### 阶段 0：可重复的测量夹具（1–2 天）

**改动文件**

- 新增 `scripts/verify-web-scroll.ts`：复用 `scripts/lib/web-test-fixture.ts`，种子 1k/3k/5k 三个房间（内容配比固定），输出 JSON 报告。
- 新增 `tests/e2e/scroll-stability.spec.ts`：断言 `preJump`、`correctedDrift`、`lateDrift`、`missed`、CLS、帧间隔。
- `src/contracts/limits.ts`：新增 `webScrollAnchorTolerancePx: 2`、`webScrollSettleFrames: 3`、`webScrollSettleMs: 1_000`、`webScrollLoadCooldownMs: 250`。
- `package.json`：`test:web:scroll`。

**验收**

- 在 `8d40297` 上运行**必须失败**，并打印本文第 2 节的同类指标（作为“修复前”证据）。
- 报告字段与本文定义一致，便于直接对比。

**回滚**：纯新增文件，删除即可。

### 阶段 1：修锚定与高度稳定性（3–5 天，无新依赖）

**改动文件**

| 文件 | 改动 |
| --- | --- |
| `src/web/features/chat/Timeline.tsx` | 用“元素锚定控制器”替换 `loadOlder` 里的 `scrollHeight` 差值（`:242-258`）；`onScroll`（`:260-284`）区分用户滚动与程序化滚动，加入加载冷却，禁止级联；保留 `pinned` / `forcePinToken` / `scrollResetToken` / 搜索跳转语义 |
| `src/web/chat-styles.ts` | `.messages--long .msg` 的 `contain-intrinsic-size` 180 px → 96 px；确认 `.messages` 的 `overflow-anchor: none`（或按 A1 实验结论调整） |
| `src/web/chat-message-files-styles.ts` | `.msg-file-thumb` 预留 `aspect-ratio: 4 / 3`，`img { object-fit: cover }` |
| `src/web/features/chat/MessageFileCard.tsx` | 缩略图容器先占位再出图；保持 `loading="lazy"` |
| `src/web/features/chat/MarkdownIsland.tsx` | 房间打开时预加载 markdown bundle（`:36-66` 的 `loadMarkdown`）；挂载后主动通知锚定控制器（或依赖 ResizeObserver） |
| `src/contracts/limits.ts` | 删除 5 个从未使用的滚动常量（`webScrollIntentPx`、`webScrollSuppressPinMs`、`webScrollProgrammaticMs`、`webScrollUserIdleMs`、`webScrollAnchorMaxShiftPx`），或把它们接入新控制器 |

**A1 对照实验**（同阶段内，只改 CSS + 一个开关）

- `data-scroll-anchor="native"` 时设 `overflow-anchor: auto` 并关闭 JS 补偿，跑阶段 0 的夹具；只有数据明显更好才采纳。

**验收标准**

| 指标 | 目标 |
| --- | --- |
| 每次 prepend 的 `correctedDrift` | ≤2 px |
| `missed` | 0/24 |
| `lateDrift`（+2 s） | ≤2 px |
| prepend 的 CLS | ≤0.05（目标 0） |
| 滚轮上翻时 `S` 的单帧变化量 | ≤2 px（到顶钳制除外） |
| 帧间隔 | p95 ≤20 ms，无 >50 ms 帧 |
| 级联加载 | 0（一次用户手势 ≤1 页） |
| 既有用例 | `test:protocol`、`test:acceptance`、`test:e2e`（pagination、search-ui、task-dock、chat-*）全绿 |

**测试用例**

- `scroll-stability.spec.ts`：1k/3k/5k × 桌面/移动 × 程序化/滚轮。
- 断言“搜索定位 / 置顶定位 / Task 跳转 / 引用跳转”仍可滚动到目标（既有用例已覆盖，需保持）。
- 断言“回到底部”在加载更早期间不误触发。

**回滚开关**：`LIMITS.webScrollAnchorMode: 'element' | 'delta'`（默认 `element`），一键回到旧行为。

### 阶段 2：虚拟化（条件触发，5–8 天）

只在阶段 1 未达标或产品要求 DOM 上限时执行。

**改动文件**

- `src/web/features/chat/Timeline.tsx` → 拆出 `TimelineDom` / `TimelineVirtual`，用开关选择。
- 新增 `src/web/features/chat/scroll-to-message.ts`：把 4 处 DOM 反查收敛为一个“定位消息”抽象（DOM 模式走 `scrollIntoView`，虚拟模式走 `scrollToIndex` + 确保数据窗口）。
- `ChatPage.tsx:425-432`、`ChatMessage.tsx:155-195`、`useChatSearchNavigation.ts:11-17` 改调抽象。
- `src/contracts/limits.ts`：`webTimelineVirtual`、`webTimelineVirtualThreshold`。
- 测试：改写 `pagination.spec.ts` 的“DOM 条数”断言为“已加载条数 / 可见窗口条数”两类断言。

**验收标准**

- 阶段 1 的所有指标保持。
- 已加载 5,000 条时：DOM 节点 ≤2,000，滚动 p95 ≤20 ms，无 >50 ms 帧。
- 跳转到任意消息（搜索/置顶/Task/引用）成功率 100%。
- 移动端单栏、输入法、回到底部、未读水位不受影响。

**回滚开关**：URL `?timeline=dom` + `LIMITS.webTimelineVirtual=false`（运行时读取，无需重新发版即可灰度）。

### 阶段 3：收尾（1–2 天）

- 删除旧补偿路径与开关（或保留一个迭代）。
- 用阶段 0 的夹具固化数字到 `reports/`。
- 更新 `docs/code-index.md` / 相关计划文档。

---

## 7. 不做的事

- 不引入托管 IM 服务（Stream / Sendbird / Matrix homeserver）。
- 不改 MCP / 服务端协议，不新增服务端字段（图片宽高若需要，另立 issue 评估 MCPP Files 契约）。
- 不动权限、凭据、幂等、outbox、已读水位语义。
- 不做与滚动无关的重构（不顺手改视觉、不改 composer、不重排样式文件）。
- 不为了“看起来更快”而关闭 `content-visibility`（实测 `contain-intrinsic-size: none` 更差）。

---

## 8. 风险与开放问题

### 8.1 需要用户决策

1. **是否接受新依赖？** 主推 A 不需要；备选 C 需要 `react-virtuoso`（MIT、0 runtime deps、**18.4 kB gzip**）。当前入口 749.14 kB / 上限 972.8 kB（余量 223.66 kB），放在 ChatPage 动态 chunk 不影响入口预算。
2. **是否接受长会话只渲染窗口？** 代价：浏览器 `Ctrl+F` 找不到窗口外消息、跨消息选中复制受限、打印不完整、无障碍树只覆盖窗口。若不可接受，只能走 A。
3. **图片尺寸从哪来？** 统一 4:3 裁切占位（无协议改动，可能裁掉图片边缘）vs 补 `width/height` 元数据（跨 MCPP Files 契约，需要另立服务端议题）。
4. **“抖动”具体指什么？** 本报告量化的是**位置跳变**（内容瞬间位移 7–9k px、偶发永久错位）。如果用户指的是**掉帧/卡顿**，需要在真机（尤其低端 Android）复测，结论可能偏向阶段 2。
5. **原生锚定是否可依赖？** 实测在“程序化 `scrollTop = 0` 后立即 prepend”时 Chrome 未补偿；真实滚轮场景下是否补偿需 A1 实验确认。Safari / Firefox 的 `overflow-anchor` 支持差异也要实测（Safari 目前不保证支持）。

### 8.2 已知风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 锚定循环与贴底互抢 | 回底后向上抖动/回弹 | 明确优先级，贴底时禁用锚定；用阶段 0 夹具回归 |
| 用户滚轮与校正竞争 | 手指/滚轮被“拽住” | 用户输入时把位移吸收进 `expectedS`，只抵消非用户意图的位移（见 5.1） |
| `content-visibility` 的估算值仍不精确 | 滚动条长度轻微变化 | 估算值改为 96 px；不参与锚定计算 |
| 级联加载仍可能发生 | 一次手势加载多页 | 用户手势单页 + 冷却窗口 |
| 虚拟化后 `aria-live` 播报被截断 | 无障碍退化 | 阶段 2 单独评估播报策略 |
| 测试夹具依赖本机性能 | 指标波动导致 flaky | 断言只针对 `preJump`/`drift`/`missed` 这类确定性指标；帧率仅记录不门禁 |

### 8.3 待确认的代码事实（评审时请一并确认）

- `.messages` 的 `overflow-anchor: none`（`chat-styles.ts:484`）与手动补偿、贴底冻结是同一次改动引入的（`cf203fa`）；换成 `auto` 是否会与“贴底滚动”冲突，需要在 A1 实验中验证。
- `LIMITS` 中 5 个滚动常量（`webScrollIntentPx` 等）目前**无任何引用**，属于历史遗留；阶段 1 一并清理。
- 现有 `webOlderAutoTopRatio = 0.1` 在超长会话里会过早触发加载（可滚动范围 16 万 px 时，10% 是 1.6 万 px）；阶段 1 可评估改为“距顶部固定像素”或“距顶部 1 屏”。

---

## 9. 附录：测量脚本要点

```text
startTestServer() → 种子 human + agent + group room
upload PNG × 8 / MD × 2
for i in 1..N: network_message_send（8 并发；Markdown 由 agent 发，保证走 MarkdownIsland）
每 41 条 network_task_mark

Playwright：
  addInitScript: localStorage token + PerformanceObserver(layout-shift, longtask) + rAF 采样
  goto /c/<roomId> → 等待 50 条 → addStyleTag(变体) → 等待 2.5 s
  loop: 记录 anchor(id/top)、scrollTop、scrollHeight、count → scrollTop = 0 → rAF 采样 3 s
  输出：preJump / delay / correctedDrift / lateDrift / missed / CLS / longTask / 帧间隔

滚轮场景：
  mouse.wheel(0, -300) × 45 → 每帧记录 (anchor top, scrollTop)
  计算 S = top + scrollTop 的逐帧差分
```

原始输出（三个房间 + 移动端 + 变体 + 滚轮）保留在本次测量的会话记录中，可按上述脚本复现。

---

## 10. 一句话结论

**先把“加载更早”的滚动补偿从“一次性的 `scrollHeight` 差值”改成“元素锚定的连续幂等校正”，并给图片/Markdown 行预留高度；虚拟化是下一步的选项，而不是第一步的解。**

---

## 11. 实施记录（C）

- **依赖**：`react-virtuoso@4.18.24`（MIT，0 runtime deps）。主时间线默认 `TimelineVirtual`；`TimelineDom` 保留一个迭代。
- **包体**：ChatPage 动态 chunk 从 66.00 kB gzip / 197.99 kB raw 增至 90.24 kB gzip / 267.70 kB raw（+24.24 kB gzip / +69.71 kB raw）。入口仍为 749,212 B（gzip 240.29 kB），未受影响。
- **5k 实测**（`E2E_VIRTUAL_MESSAGES=5000`，本机 Chromium）：已加载 5,000 条时 DOM 节点 175 个、挂载消息 15 条；帧间隔 p50 16.7 ms、p95 16.8 ms、max 16.8 ms、>50 ms 长帧 0。加载全部 5,000 条耗时 12.8 s（含 100 次分页）。
- **prepend 漂移**：加载更早时锚点瞬时最大位移 8 px，校正后 0 px，最终锚点回到 ≤2 px；`missed=false`。
- **回滚开关**：URL `?timeline=dom` 优先于 `LIMITS.webTimelineVirtual`；置 `false` 需重新构建，属于发版级回滚。DOM 路径保留 `#messages` 全量渲染与 `scrollHeight` 差值补偿，并有独立 e2e 覆盖。
- **已知边界**：浏览器 `Ctrl+F`、跨消息选中复制、打印与无障碍树只覆盖当前挂载窗口；帧率数据来自本机，低端 Android 需真机复测。

---

## 12. 贴底抖动修复（2026-11-04）

### 12.1 复现

隔离实例（Bun + 临时 SQLite，Playwright Chromium，1280×720）中创建 direct Agent 会话，
消息由 Agent 发出以走 Markdown 岛，混排长 Markdown 表格/代码块、图片文件卡、`.md`
文件卡与消息式 Task；另建 80 条轻内容会话用于“已加载窗口滚到底部”场景。
`scrollTop` / `scrollHeight` / `gap` 同时按 rAF（绘制前）与 `setTimeout(0)`（绘制后）
采样，回退一律相对“历史最高 `scrollTop`”计算。

- **入口（240 条富内容，5/5 复现）**：从 `#messages` 出现的第一帧开始采样。基线
  `a0586b7` 在首屏可见阶段 `scrollTop` 相对峰值回退 **197 px**，绘制后 `gap` 最大
  **1,470 px**；可见阶段出现过 `data-virt-at-bottom` 从 `true` 翻回 `false`。
- **到达底部（80 条轻内容，5/5 复现）**：用户上翻阅读时 Agent 发来一条中等高度的
  Markdown 消息（14 行表格 + 10 条列表），该消息尚未挂载（高度仍是估算值）；一次
  滚轮把窗口拖到底。以页面内第一帧 `gap≤2` 为到达起点，之后 500 ms 内基线绘制后
  `gap` 最大 **74 px**、可见回退 **76 px**。
- 此前记录中的 `806→90` 与 `215 px` 方向描述不可按原文复现（215 px 只在另一种
  “到达瞬间恰好收到追加”的时序下出现过，且方向写反），已删除，不再作为基线。
- **旧实现的成因**：`handleAtBottom` / `rangeChanged` 一到底就 `revealWhenSettled`，
  把估算高度阶段的回退直接画给用户；`totalListHeightChanged` 只排 rAF 校正，
  `ResizeObserver` 也只排 rAF，校正发生在绘制之后；方向判断把任何近期输入都当成
  “用户离开底部”，向下滚动到达时高度一变就取消 pinned，校正被跳过。

### 12.2 改法

`src/web/features/chat/TimelineVirtual.tsx`：

- **入口 settle**：`atBottom` / `rangeChanged` / 挂载兜底只启动 `watchInitialReveal`，
  不再一到底就显示。隐藏期间逐帧同步贴底，连续 `webTimelineRevealStableFrames = 3`
  帧高度不变且 `gap≤2` 才 reveal；没有异步正文时最多等
  `webTimelineRevealMaxWaitMs = 300 ms`，超时必须显示，不能白屏。reveal 前再同步
  贴一次真实底部。
- **正文 pending 门控**：`body-pending.ts` 提供时间线级计数器，只统计当前挂载窗口
  中正文未就绪的消息。`MarkdownIsland` 在挂载的 layout effect 里登记，Markdown 岛
  同步挂载完成（或失败回退）后释放；`watchInitialReveal` 要求 `pending===0` 且高度
  稳定才 reveal。有 pending 时隐藏上限放宽到
  `webTimelineRevealPendingMaxWaitMs = 2 s`，避免资源挂住时长期白屏；超时后仍按
  原有同步贴底显示。计数器随 Virtuoso 卸载释放，不累计整段历史。
- **提交后贴底**：父级 `useLayoutEffect`（依赖 `items` / `pinned` / `ready`）在
  `pinned`、非 anchor/恢复窗口且 `gap>2` 时于绘制前写 `scrollTop = scrollHeight`，
  覆盖 Virtuoso 在本组件提交后按旧锚点写回、`totalListHeightChanged` 晚于绘制的
  路径。入口 reveal 后的 300 ms 内不执行：这段窗口由 `watchInitialReveal` 的同步
  贴底与 ResizeObserver 负责，额外写入会触发新的 range 测量，把尚未测高的图片卡
  提前画出来。没有引入全容器 MutationObserver。
- **同步校正**：`handleTotalListHeightChanged` 在 `pinned`、非 anchor/恢复窗口且
  `gap>2` 时同步贴底；item list 的 `ResizeObserver` 同样在绘制前校正（rAF 仍作为
  合并兜底），图片 `load` 捕获后下一帧再按真实高度贴一次。校正优先调用 Virtuoso 的
  `autoscrollToBottom()` 更新其内部滚动状态，再兜底写 `scrollTop = scrollHeight`。
  Virtuoso 可能在同帧末尾按旧锚点把 `scrollTop` 写回，因此一次高度变化后最多重试
  8 帧，直到 `gap≤2`；预算有限，不会退化成旧的无限 MutationObserver 互抢。
- **方向化贴底**：只有近期“向上”手势（滚轮 `deltaY<0`、PageUp/ArrowUp/Home、
  触摸/指针按原语义）才在 `atBottom=false` 时取消 pinned；向下滚轮会清除向上意图。
  向下手势一旦落到 `gap≤2` 就立即 `setPin(true)`，不等 Virtuoso 的 `atBottom` 回调；
  超高消息测量可能持续数百毫秒。到达瞬间还用“刚在底部 + 正在向下滚”的短窗口
  继续校正，reveal 后 500 ms 内保留贴底宽限，让首轮图片/Markdown 长高也能同一帧校正。
  搜索/引用/Task 跳转后的 600 ms 内禁止入口 settle 贴底，避免把定位拉回底部。
- `initialSettled` 只在 reveal 时置位，避免隐藏期 `scrollTop=0` 触发 `onScroll`
  的“到顶即取消贴底”，把入口校正挡掉。
- 保留 `followOutput` 对新数据的跟随、anchor/search/restoring 抑制与
  `?timeline=dom` 回滚路径；已读水位语义不变。

### 12.3 A/B 实测

同夹具、同内容，本机 headless Chromium。基线为 `a0586b7` 的只读 worktree
（`/tmp/agentnet-baseline-a0586b7`，独立 `dist/web` 与隔离服务），测试用 HEAD 的
同一份 e2e，通过 `E2E_BASE_URL` 指向基线服务。

| 场景 | 基线 `a0586b7` | 修复后 |
| --- | --- | --- |
| 入口 `maxBackward`（相对峰值，5 次） | **197 px**（5/5 >20） | **0 px**（5/5） |
| 入口绘制后 `maxGap` | **1,470 px** | **0 px** |
| 到达底部可见回退（5 次） | **76 px**（5/5 >20） | **0 px**（5/5） |
| 到达底部绘制后 `maxGap` | **74 px** | **0 px** |
| 到底静止 2 s `scrollTop` range / `scroll` 事件 | 0 px / 0 | **0 px / 0** |
| 5k 已加载：DOM 节点 / 挂载消息 | 175 / 15 | **175 / 15** |
| 5k 帧间隔 p95 / 长帧 | 16.7 ms / 0 | **16.7 ms / 0** |
| 5k prepend 最大漂移 / 校正后 / missed | 8 / 0 / false | **8 / 0 / false** |

入口 `maxBackward` 是 rAF（绘制前）采样值；`maxGap` 取绘制后采样，代表用户真正看到的
“最新消息被推离底部”。底部高度补偿造成的 `scrollTop` 回退如果 `gap` 仍为 0，画面
锚在内容底部，不计入可见回退；新增用例里的 `maxVisibleBackwardPainted` 只在
`gap>2` 的绘制后帧上统计回退，`maxBackwardPainted` 仍保留为诊断值。

**慢 Markdown 资源（`/assets/chat-markdown.js` 延迟）**

隔离实例、同一份 e2e，对照 `d9aa96e` 的只读 worktree（独立 `dist/web`）。房间为
32 条 Agent Markdown（无文件卡），从 `#messages` 第一帧起采样 900 ms：

| 场景 | `d9aa96e` | 修复后 |
| --- | --- | --- |
| 100 ms 延迟：首帧可见 | 126–179 ms | 291–300 ms |
| 100 ms 延迟：首帧已挂载 Markdown 字符 | **0**（3/3） | **1,700**（3/3） |
| 100 ms 延迟：绘制后 `maxGap` | 0 或 **4,551 px**（时序相关） | **0 px** |
| 100 ms 延迟：可见回退 | 0 或 **4,551 px** | **0 px** |
| 300 ms 延迟：首帧可见 | 121–137 ms | 407–412 ms |
| 300 ms 延迟：首帧已挂载 Markdown 字符 | **0**（3/3） | **5,600**（3/3） |
| 300 ms 延迟：绘制后 `maxGap` | 0 或 **4,551 px**（时序相关） | **0 px** |
| 300 ms 延迟：可见回退 | 0 或 **4,551 px** | **0 px** |

旧实现在这两档都可能在 reveal 后由同帧 ResizeObserver 补上，因此“绘制后 gap”偶发为
0；确定性的差异是 **reveal 时正文尚未挂载**（`firstVisibleMarkdownChars=0`），
新用例把它设为硬断言，`d9aa96e` 上 100 ms / 300 ms 各 3/3 失败，修复后各 3/3 通过。

### 12.4 新增 e2e

`tests/e2e/chat-virtual-timeline.spec.ts` 的 `virtual timeline bottom stability`：

- `enters the room without a visible backward jump`：`addInitScript` 在导航前安装采样器，
  从 `#messages` 第一帧开始，记录 rAF 与绘制后两套样本约 900 ms。断言
  `maxBackward ≤ 20`、绘制后 `maxGap ≤ 20`、首次可见 ≤400 ms、最终 gap ≤2、
  显示后 `data-virt-at-bottom` 不再翻转。基线 5/5 失败（197 px），HEAD 5/5 通过。
- `stays pinned after scrolling the loaded window to the bottom`：80 条轻内容加载完后
  滚到顶部，Agent 发一条 14 行表格 + 10 条列表的 Markdown 消息（尚在估算高度），
  再一次性滚轮拖到底；以页面内第一帧 `gap≤2` 为到达起点，观察 500 ms 的绘制后样本。
  断言 `maxGapAfterArrival ≤ 20`、`maxVisibleBackwardAfterArrival ≤ 20`、最终 gap ≤2。
  基线 5/5 失败（74/76 px），HEAD 10/10 通过。
- `reveals after slow Markdown (100ms|300ms) without a visible jump`：`page.route`
  把 `/assets/chat-markdown.js` 延迟 100/300 ms，进入 32 条 Agent Markdown 的小房间，
  从 `#messages` 第一帧起完整采样 900 ms。断言首帧可见时
  `firstVisibleMarkdownChars>0`（不能先画空气泡）、rAF `maxBackward≤20`、
  `maxVisibleBackwardPainted≤20`、绘制后 `maxGap≤20`、最终 gap≤2。`d9aa96e`
  100/300 ms 各 3/3 失败（首帧正文为 0，部分轮次 gap 4,551 px），HEAD 各 3/3 通过
  （0 px）。

### 12.5 回滚与边界

- `?timeline=dom` 完全绕过本文件，不获得本次入口 settle 与同步校正；DOM 路径现有
  e2e 只覆盖分页与搜索锚点两个场景。群消息管控与 Task dock 的 e2e 走默认虚拟时间线，
  不是 DOM 回滚，不能用来证明 DOM 路径。
- 本机 headless Chromium 无法模拟 Safari 的橡皮筋回弹；修复只保证程序化校正在绘制前
  完成，不与橡皮筋争抢。
- 剩余边界：
  - pending 只统计**当前挂载窗口**。reveal 之后才挂载的窗口外消息、缩略图解码等
    仍依赖 item list ResizeObserver、`totalListHeightChanged` 与 retry 预算；本机
    10 次入口采样为 0 px，但低端设备/慢图片仍需真机复核。
  - 单条超高消息首次测量仍可能有一次向下的高度修正（估算切真实值）；提交后
    layout effect 在 reveal 后 300 ms 内不参与，避免与 Virtuoso 首轮测量争抢。
  - 正文 pending 的上限是 2 s：资源挂住时最多多等 2 s 再显示，之后仍可能出现
    一次高度修正；没有用长时间空白遮罩替代修复。
