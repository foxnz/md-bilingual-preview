# Markdown 双语预览

把 Markdown 原文和 AI 译文**左右并排**显示在侧边栏。纯只读预览，**永远不写回文件**。

```
┌─────────────────────────────┬─────────────────────────────┐
│ # Video clip retrieval      │ # 视频片段检索              │
├─────────────────────────────┼─────────────────────────────┤
│ A user asks a question. The │ 用户提出一个问题。智能体判  │
│ agent decides a tutorial... │ 断某个教程视频能够回答它… │
├─────────────────────────────┴─────────────────────────────┤
│ ```json                                                   │
│ { "clip_id": "c_123" }        ← 代码块不翻译，整行通栏    │
│ ```                                                       │
└───────────────────────────────────────────────────────────┘
```

## 为什么不用现成的插件

- `harryplusplus.bilingual-markdown-preview` —— 双语并排、不落盘，但只能用 Google 机翻
- `sunven.vscode-extension-md-translator` —— 能用自建模型，但预览只有译文没有原文，且带一个会覆盖源文件的「替换」按钮
- `breaking-brake.markdown-ai-translator` —— 依赖 `vscode.lm`，要装 GitHub Copilot

三个都缺一块。这个插件把三件事凑齐：并排 + 只读 + 自己的模型。

## 安装

```bash
npm install
npx @vscode/vsce package
code --install-extension md-bilingual-preview-0.4.0.vsix
```

装完要 `Developer: Reload Window`。

## 使用

1. `Cmd+Shift+P` → **Markdown 双语预览：设置 API Key**（只需一次，存在 VS Code SecretStorage，不进 settings.json）
2. 打开任意 `.md`，`Cmd+Shift+P` → **Markdown 双语预览：打开**
   也可以点编辑器标题栏的书本图标，或在资源管理器里右键文件

面板右上角有「切换布局」（并排 ⇄ 上下堆叠，窄屏用）和「重新翻译」。

### 关于自定义编辑器

如果你把 `*.md` 关联到了别的自定义编辑器（比如 `markdownForHumans.editor`），很多插件会因为拿不到 `activeTextEditor` 而静默失效。这个插件按三条路依次找目标文件：命令参数 → `activeTextEditor` → `window.tabGroups` 的活动标签页，所以在自定义编辑器下**照常可用**，不需要先切成文本编辑器。

## 配置

所有配置项都在 `mdBilingual.*` 下。

**只有 `apiBaseUrl`、`model`、`targetLanguage` 这三项**留空时会回落到 `mdTranslator.*`（sunven 那个插件的命名空间），所以接口地址和模型不用重配。**其余各项不回落**——`mdTranslator.maxChunkChars` 之类的设置对本插件没有任何作用，要调就得写成 `mdBilingual.*`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `mdBilingual.apiBaseUrl` | 空 → 回落 | OpenAI 兼容接口，如 `https://api.example.com/v1` |
| `mdBilingual.model` | 空 → 回落 | 模型名。`gpt-*` 和 `claude-*` 都行，见下节 |
| `mdBilingual.targetLanguage` | 空 → 回落 | 目标语言，如 `Simplified Chinese` |
| `mdBilingual.layout` | `side-by-side` | 并排或上下堆叠 |
| `mdBilingual.maxSegmentsPerBatch` | 20 | 每批段落数，调小可降低模型弄错 id 的概率 |
| `mdBilingual.maxCharsPerBatch` | 6000 | 每批字符数 |
| `mdBilingual.concurrency` | 1 | 并发请求数。默认串行，对配额紧张的网关最友好 |
| `mdBilingual.maxRetries` | 4 | 429/5xx 的最大重试次数 |
| `mdBilingual.retryBaseMs` | 2000 | 退避基数，第 n 次重试等约 `base × 2ⁿ` |
| `mdBilingual.retryMaxDelayMs` | 30000 | 单次重试的最长等待 |
| `mdBilingual.reasoningEffort` | `auto` | 翻译不需要思考；`auto` 对 gpt 推理模型发 `none`，对 `claude-*` 发 `low` |
| `mdBilingual.requestTimeoutMs` | 120000 | 单次请求超时 |
| `mdBilingual.autoRefresh` | `true` | 源文件改动时自动重译改动的段落 |

## 用 OpenAI 还是 Claude

一个中转站后面往往同时挂着两家的账号：`gpt-*` 转发到 OpenAI，`claude-*` 转发到 Anthropic。**切换只需要改 `mdBilingual.model` 一个值**——base URL 和 API Key 都不用动，接口仍然是同一个 `/chat/completions`。

不用动的原因是插件按模型名自动适配请求参数：

| 参数 | `gpt-*` | `claude-*` | 为什么 |
|---|---|---|---|
| `temperature` | 照常发 | **不发** | Anthropic 从 Claude 4.6 起移除了采样参数，发了直接 400，而 400 不重试，一发就是硬失败 |
| `reasoning_effort` | `auto` → `none` | `auto` → `low` | Anthropic 最低一档是 `low`，没有 `none`。显式设成 `none` 也会折成 `low` |
| `response_format` | 开了就发 | 开了就发 | 转发到 Anthropic 一般不支持，保持 `useJsonResponseFormat: false` 即可 |

剩下的分歧不靠猜：**任何 400 都会按 `reasoning_effort` → `temperature` → `response_format` 的顺序逐个摘掉参数重试**，摘一个试一次，都不计入退避重试次数。所以换一个没见过的模型，最坏情况是多几次请求，不会整批失败。

此外 `max_tokens` 这个参数名本身也在分家：OpenAI 侧的新模型（gpt-5 系列、o 系列）只认 `max_completion_tokens`，收到旧名字直接 400。这一项不能像可选参数那样摘掉（摘了等于放弃长度控制），所以**服务端在 400 里点了名，插件就改名重发**，不点名不动——中转站两种名字都可能认，主动改反而可能踩另一边。

## 输出额度要配得上批大小

`mdBilingual.maxResponseTokens` 是这套配置里最容易配坏的一项，坏了还不容易看出来。

**经验比例：`maxResponseTokens ≳ maxCharsPerBatch × 0.8`。** 默认值 `6000 字符 / 16000 token` 是配平的；如果为了减少请求数把 `maxCharsPerBatch` 调到 20000，`maxResponseTokens` 也得跟到 16000。

配不平的后果是**每一批都必然被截断**：响应是一段语法不合法的半截 JSON。插件对此有两层处理：

- **打开预览时就拦。** 比例失衡会在面板顶部出一条黄色警告，直接写明两头各该调到多少——不用等它跑完一轮再来解释。
- **真截断了也不整批丢。** 断点之前写完的条目会被逐条抢救出来正常显示，只有没写完的那几段标记为失败、保留原文。报错话术会明确指向 `maxResponseTokens`，而不是含糊地说「JSON 解析失败」。

截断信号同时认 OpenAI 的 `finish_reason=length` 和转发 Anthropic 时的 `stop_reason=max_tokens`，流式和非流式都读。

用 `claude-*` 时额度还要再宽一些：**思考 token 和译文共用这个额度**。

网关上有哪些模型可用，可以直接探：

```bash
read -rs MDB_KEY && export MDB_KEY && node tools/probe.js
```

它会列出你的 key 可见的模型并逐个发一次最小请求，告诉你哪些当前真的能用。

## 工作方式

**分段** (`src/segment.js`)。按空行切块，逐块判定是否需要翻译。以下**原样保留、不送模型**：

- YAML frontmatter（只认文件开头）
- 围栏代码块（``` 和 ~~~，正确处理内嵌围栏与块内空行）
- HTML 块与注释
- 分隔线、链接引用定义
- 任何不含自然语言的块（表格分隔行、纯 URL、纯行内代码）

**翻译** (`src/translate.js`)。按段数和字符数分批，并发请求 OpenAI 兼容接口，要求返回 `{"translations":[{"id","text"}]}`。请求体由 `buildRequestBody()` 按模型名挑参数构造，OpenAI 和 Anthropic 的差异都收在这一个函数里。

**渲染** (`src/webview.js`)。CSS Grid 每块一行，左原文右译文——逐段天然对齐，不需要滚动同步。不翻译的块通栏显示。原文立刻可读，译文按批次陆续填入。

**缓存**。按 `模型|目标语言|块内容 SHA1` 缓存，只在内存里，不落盘。所以改一段只会重译那一段。

## 不会做的事

源码里**没有任何写文件的代码路径**。可以自己验：

```bash
grep -rE 'writeFile|WorkspaceEdit|applyEdit|\.edit\(|fs\.' src/
```

`src/` 连 `fs` 模块都没 require。译文只存在于 webview 和内存缓存里，关掉面板就没了。

## 报错怎么读

状态码就能把责任分清楚，不用猜：

| 状态码 | 含义 | 该做什么 |
|---|---|---|
| **401** | key 无效或没带 | 重设 API Key。这才是「key 的问题」 |
| **429** | 服务端限流 | **不是 key 的问题**——key 无效会返回 401。是网关侧暂时没配额 |
| **400** | 请求参数不合法 | 插件会按 `reasoning_effort` → `temperature` → `response_format` 逐个摘掉重试。摘光了还 400，报错会指向模型名——多半是 `mdBilingual.model` 写错或网关没有这个模型 |
| **5xx** | 服务端故障 | 自动重试 |
| **200 但说「被 max_tokens 截断」** | 输出额度不够 | 调大 `mdBilingual.maxResponseTokens`，见上一节。断点前的译文已经抢救出来了，只补没写完的那几段 |

429 和 5xx 会按指数退避自动重试，服务端给了 `Retry-After` 就以它为准——但**一律受 `mdBilingual.retryMaxDelayMs` 夹制**。限流的网关经常回一个几百上千秒的 `Retry-After`，照单全收会让插件静默睡死。截断之后大概率还是 429，但那是一条你看得见的失败，不是一个看不见的挂起。被截断时状态栏会写明服务端原本要求等多久。

重试期间状态栏会显示「⏳ 被限流，8s 后重试（第 2/4 次）」，不会看起来像卡死。

重试用尽仍失败时，只有那一批的段落显示「这一批翻译失败」，其余已完成的译文照常保留。

遇到持续 429，按这个顺序试：

1. 确认 `mdBilingual.concurrency` 是 1
2. 调大 `mdBilingual.maxRetries` / `retryMaxDelayMs`，让它等得更久
3. 调整批大小——**但先搞清楚网关按什么限流**：
   - 按**请求数**限（RPM）：调大 `maxSegmentsPerBatch`、`maxCharsPerBatch`，批次更少请求就更少
   - 按**token 数**限（TPM）：反过来，调大批次只会更快烧完额度，该调小
   - 分不清就看报错里的原话，或两个方向各试一次
   - 不论往哪调，`maxResponseTokens` 都要跟着 `maxCharsPerBatch` 走，见上一节
4. 换 `mdBilingual.model`。如果网关的账号池是按模型分的，换一个就绕开了

## 已知限制

- **缩进式代码块**（4 空格，非围栏）不受保护，会被当作正文送去翻译。围栏代码块不受影响。
- 行内元素靠 system prompt 约束，不做占位符替换。极少数情况下模型可能动到行内代码或链接地址。因为是只读预览，出错不会污染任何文件。
- 松散列表（条目之间有空行）会被切成多块，各自渲染成独立的 `<ul>`，视觉上条目间距略大。
- 缓存不落盘，重开 VS Code 需要重新翻译。

## 自检

```bash
node test/check.js                      # 60 项单元检查
node test/check.js path/to/some.md      # 再附加一份真实文档的分段统计
```

不需要 VS Code，不发任何网络请求。
