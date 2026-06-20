# FlowUs Agent Skill

> **版本**: v4.0 | **架构**: 纯 REST API (V2) + MCP Streamable HTTP 读取
>
> 让 AI Agent 丝滑操作 FlowUs 云知识管理平台：读取、搜索、下载、写入、导出。
>
> **API 版本**: FlowUs V2 (`/v2` 前缀) | **Token 传递**：支持 `--token` 参数、环境变量、`.env` 文件三层自动解析

## ⚠️ 工具选择规则（必读）

> **Agent 必须严格遵守以下规则，违反将导致操作失败。**

### 核心原则：CLI 脚本优先，MCP 工具仅作只读辅助

| 操作类型 | 必须使用 | 禁止使用 | 原因 |
|----------|---------|---------|------|
| **写入**（创建/更新/删除页面、块、数据库） | **CLI 脚本** (`node flowus-write.js`) | ❌ MCP 工具 | MCP 工具的 schema 校验与 FlowUs 实际 API 有差异，合法请求会被拦截 |
| **读取**（查询数据库、读取页面、搜索） | **CLI 脚本** (`node flowus-read.js`) | MCP 工具（可作补充） | CLI 脚本功能更完整，支持 filter/sort/语义搜索等高级特性 |
| **下载导出** | **CLI 脚本** (`node flowus-download.js`) | ❌ MCP 工具 | 下载功能仅 CLI 提供 |
| **文件上传** | **CLI 脚本** (`node flowus-write.js --upload`) | ❌ MCP 工具 | 上传流程（预签名 URL → PUT → 追加块）仅 CLI 实现 |
| **数据库管理**（创建/更新/删除数据库） | **CLI 脚本** (`node flowus-write.js --create-db` 等) | ❌ MCP 工具 | MCP `createDatabase` 的 schema 校验会拒绝合法的 properties 格式 |

### 为什么 MCP 工具不适合写入操作？

1. **Schema 校验过严**：MCP 工具的 input schema 与 FlowUs 实际 API 存在差异，合法的请求参数会被 MCP 层拦截返回校验错误
2. **参数格式限制**：MCP 工具对 properties、filter 等复杂参数的格式要求比实际 API 更严格，导致本应成功的操作反复失败
3. **功能缺失**：MCP 工具不支持文件上传、数据库管理、块级编辑等 V4.0 新增功能

### 执行模板

```bash
# ✅ 正确：用 CLI 脚本操作
node flowus-write.js --create-db <pageId> --title "数据库名" --db-props '{"名称":{"type":"title"}}'
node flowus-write.js --db <dbId> --title "标题" --text "正文"
node flowus-read.js --db <dbId> --list --sort created_time:desc

# ❌ 错误：用 MCP 工具操作（会失败）
# 调用 MCP createDatabase / createPage / updatePage 等写入工具
```


---

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│                    SKILL.md                           │
│              （本文件 - Agent 编排手册）                │
├──────────┬──────────┬───────────┬──────────┬─────────┤
│flowus-   │flowus-   │flowus-    │wechat-   │lib/     │
│read.js   │write.js  │download.js│fetch.js  │         │
│          │(纯REST)  │(纯REST)   │(零依赖)  │mcp+rest │
│ MCP+REST │ REST API │ REST API  │ HTTP+CDP │ 底层库  │
└──────────┴──────────┴───────────┴──────────┴─────────┘
```

**协议设计：**
| 模块 | 协议 | 说明 |
|------|------|------|
| **写入** (write.js) | **纯 REST API (V2)** | 创建/查找/清空/追加/属性更新/删除，REST 块模式写入（mdToBlocks + appendBlocks） |
| **读取/搜索** (read.js) | **MCP + REST (V2)** | Markdown API 优先读取，语义搜索，filter/sort 查询 |
| **下载导出** (download.js) | **纯 REST API (V2)** | Markdown API 优先导出，递归展开嵌套块 |
| **微信抓取** (wechat-fetch.js) | **HTTP + CDP** | 独立技能，零外部依赖 |

**Token 传递方式（优先级从高到低）：**

```bash
# 方式 1：命令行参数（Agent 首次使用时，用户提供的 token 通过此方式传入）
node flowus-write.js --token <你的token> file.md "标题"

# 方式 2：环境变量（手动终端测试时用）
export FLOWUS_TOKEN=your_token_here        # Bash/Zsh
$env:FLOWUS_TOKEN="your_token"             # PowerShell
set FLOWUS_TOKEN=your_token_here           # CMD

# 方式 3：.env 文件（Agent 首次拿到 token 后自动缓存到 workspace/.env）
# 文件内容仅需一行：
FLOWUS_TOKEN=你的token

# 可选：默认目标数据库（避免每次指定 --db / --parent）
export FLOWUS_DEFAULT_DB=your_database_id
export FLOWUS_DEFAULT_PARENT=your_db_id
export FLOWUS_CLIP_DB=your_clip_db_id
```

### Token 缓存机制（Agent 必读）

> **这是 Agent 的核心职责之一——管理好自己的 token。**

当脚本报错 `缺少 FlowUs 授权 token` 时：

1. **向用户索取 token** —— 告诉用户你需要 FlowUs 授权码才能操作
2. **用 `--token` 参数传入执行本次任务**
3. **同时将 token 写入当前工作目录的 `.env` 文件**，格式：
   ```
   FLOWUS_TOKEN=用户给你的token
   ```
4. **以后每次执行都不再需要问用户**，脚本会自动从 `.env` 读取

**关键原则：token 来自用户授权，绝不自动从其他配置文件提取。只通过上述三种合法渠道获取。**

---

## 文件清单

| 文件 | 职责 | 依赖 | Token |
|------|------|------|-------|
| `lib/mcp-client.js` | MCP Streamable HTTP 客户端 | 仅 Node 内置 | 需要（读取模块） |
| `lib/rest-client.js` | REST API 客户端（Bearer Token） | 仅 Node 内置 | 需要（写入模块） |
| `flowus-read.js` | 数据库读取 / 页面读取 / 全局搜索 / 关键词搜索 | mcp + rest | 需要（--token / .env / 环境变量） |
| `flowus-write.js` | Markdown 上传 / 代码上传 / 文本写入 / 页面更新 / 属性更新 / 删除 | **仅 rest** | 需要（--token / .env / 环境变量） |
| `flowus-download.js` | 导出为 .md / 批量导出 / 图片下载 / 剪藏微信文章 | **仅 rest** | 需要（--token / .env / 环境变量） |
| `wechat-fetch.js` | 微信公众号文章抓取（独立技能） | **零外部依赖** | 不需要 |

---

## 快速参考

### 场景 → 命令映射

| 用户意图 | 命令 |
|----------|------|
| "查看帮助" | `node flowus-read.js --help` / `flowus-write.js --help` / `flowus-download.js --help` |
| "读取剪藏最新几条" | `node flowus-read.js --db <id> [N]` |
| "读取并概括最新剪藏" | ① `node flowus-read.js --db <id> 1` → 获取 pageId ② `node flowus-read.js --id <pageId>` → 读取正文 |
| "读取剪藏最早的几条" | `node flowus-read.js --db <id> --sort created_time:asc [N]` |
| "按时间排序通读" | `node flowus-read.js --db <id> --sort created_time:desc 5`（一步完成排序+正文读取） |
| "搜索数据库中的 xxx" | `node flowus-read.js --db <id> --keyword xxx` |
| "全局搜索 xxx" | `node flowus-read.js --search xxx` |
| "语义搜索（自然语言）" | `node flowus-read.js --semantic "自然语言查询"` |
| "读取某个页面的内容" | `node flowus-read.js --id <pageId>` |
| "数据库过滤查询" | `node flowus-read.js --db <id> --list --filter '{"property":"状态","select":{"equals":"完成"}}'` |
| "数据库排序查询" | `node flowus-read.js --db <id> --list --sort '创建时间:desc'` 或 `--sort created_time:desc` |
| "把这个 .md 文件传到 FlowUs" | `node flowus-write.js file.md "标题"` |
| "写入指定数据库" | `node flowus-write.js --db <dbId> file.md "标题"` |
| "直接文本写入（不读文件）" | `node flowus-write.js --db <dbId> --title "标题" --text "正文内容"` |
| "带图标和封面创建页面" | `node flowus-write.js --icon 📝 --cover URL file.md "标题"` |
| "更新已有页面" | `node flowus-write.js --update file.md "标题"` |
| "更新页面属性" | `node flowus-write.js --update-prop <pageId> --set-title "新标题"` |
| "删除页面" | `node flowus-write.js --delete <pageId>` |
| "编辑某个块的内容" | `node flowus-write.js --edit-block <blockId> --text "新内容"` |
| "勾选/取消待办块" | `node flowus-write.js --edit-block <blockId> --checked true` |
| "删除某个块" | `node flowus-write.js --delete-block <blockId> --force` |
| "上传本地图片/文件" | `node flowus-write.js --upload <文件路径> --parent <pageId>` |
| "创建数据库" | `node flowus-write.js --create-db <pageId> --title "数据库名" --db-props '{"名称":{"type":"title"}}'` |
| "创建行内数据库" | `node flowus-write.js --create-db <pageId> --title "数据库名" --db-props-file props.json --inline` |
| "给数据库添加属性" | `node flowus-write.js --update-db <dbId> --db-props '{"新字段":{"type":"rich_text"}}'` |
| "删除数据库" | `node flowus-write.js --delete-db <dbId> --force` |
| "导出为本地 .md 文件" | `node flowus-download.js --db <id> [N] --output ./dir` |
| "下载剪藏的微信文章" | `node flowus-download.js --clip [N]` |
| "抓取微信文章" | `node wechat-fetch.js <URL> --images` |

> **重要**：`flowus-read.js --db <id> [N]` 只返回记录列表（元数据），不包含正文。要读取正文，需用 `--id <pageId>` 单独读取。这是两步操作：先列表获取 ID，再读取正文。但 `--sort` + 数量参数可以一步完成排序+通读（如 `--sort created_time:asc 3`）。

> **标题说明**：FlowUs 剪藏页面的 properties 通常没有 title 属性，脚本会自动从正文 heading 中提取标题作为 fallback，不再显示"(无标题)"。

> **--sort 别名**：支持英文属性名，如 `created_time:asc`、`last_edited_time:desc`，也支持缩写 `asc`/`desc`。

---

## 各模块详细说明

### 1. flowus-write.js — 写入（V2 纯 REST 块模式）

**用途**: 将内容写入 FlowUs。统一使用 REST 块模式（mdToBlocks + appendBlocks）。

**V4.0 新特性**：
- **块级编辑**：`--edit-block` 更新单个块内容，`--delete-block` 删除单个块（无需清空整页）
- **文件上传**：`--upload` 上传本地图片/文件到 FlowUs 页面（自动获取预签名 URL → PUT → 追加块）
- **数据库管理**：`--create-db` 创建数据库（`--inline` 行内模式），`--update-db` 添加属性，`--delete-db` 删除数据库
- **属性文件读取**：`--db-props-file` 从 JSON 文件读取数据库属性，避免 PowerShell 引号转义问题
- **纯 REST 块模式写入**：Markdown → mdToBlocks → appendBlocks，不依赖 MCP
- **`--title` / `--text` 分离**：`--title` 设置页面标题，`--text` 设置页面正文内容
- **`--db` 统一参数**：`--db` 作为 `--parent` 的别名，与 read.js 保持一致
- **自动获取标题属性名**：`_getTitlePropName()` 查询数据库 schema，不再硬编码 `title`
- **软删除**：`--delete` / `--delete-block` / `--delete-db` 操作均为软删除（移入回收站），可恢复
- **429 限流自动重试**：写入操作也支持限流退避

> ⚠️ **Idempotency-Key 不可用**：FlowUs API 当前不支持 `Idempotency-Key` header，使用会导致 HTTP 500。

```bash
# Markdown 上传（最常用）
node flowus-write.js article.md "文章标题"
node flowus-write.js ./notes/daily.md

# 代码文件上传（自动语法高亮）
node flowus-write.js script.py "Python 工具"
node flowus-write.js index.html "前端页面"

# 直接文本写入
node flowus-write.js --text "# 标题\n\n正文..." "页面标题"

# 图标和封面
node flowus-write.js --icon 📝 --cover https://img.url/cover.png file.md "带图标的页面"

# 目标控制
node flowus-write.js --db <dbId> file.md              # 写入指定数据库（--db 是 --parent 的别名）
node flowus-write.js --parent <dbId> file.md           # 同上
node flowus-write.js --parent-type page <文件>          # 父级为普通页面（不指定时自动检测）
node flowus-write.js --update file.md "标题"            # 更新模式（清空后重写）

# 属性更新（--update-prop + 具体操作）
node flowus-write.js --update-prop <pageId> --set-title "新标题"
node flowus-write.js --update-prop <pageId> --set-select "状态:已完成"
node flowus-write.js --update-prop <pageId> --set-checkbox "完成:true"
node flowus-write.js --update-prop <pageId> --set-text "描述:内容"
node flowus-write.js --update-prop <pageId> --set-icon "📝"
node flowus-write.js --update-prop <pageId> --set-cover "https://..."

# 删除页面
node flowus-write.js --delete <pageId>

# 块级编辑（V4.0 新增）
node flowus-write.js --edit-block <blockId> --text "新内容"     # 更新块文本
node flowus-write.js --edit-block <blockId> --checked true      # 勾选待办
node flowus-write.js --delete-block <blockId> --force           # 删除单个块

# 文件上传（V4.0 新增）
node flowus-write.js --upload ./photo.png --parent <pageId>     # 上传图片（自动插入 image 块）
node flowus-write.js --upload ./doc.pdf --parent <pageId>       # 上传文件（自动插入 file 块）

# 数据库管理（V4.0 新增）
node flowus-write.js --create-db <pageId> --title "项目看板" --db-props '{"名称":{"type":"title"},"状态":{"type":"select"}}'
node flowus-write.js --create-db <pageId> --title "项目看板" --db-props-file props.json --inline  # 行内数据库，属性从文件读取
node flowus-write.js --update-db <dbId> --db-props '{"优先级":{"type":"select"}}'  # 添加属性
node flowus-write.js --update-db <dbId> --db-props-file props.json  # 从文件读取属性
node flowus-write.js --update-db <dbId> --title "新名称"       # 重命名
node flowus-write.js --delete-db <dbId> --force                # 删除数据库

# 原始 block JSON（高级用法）
node flowus-write.js --raw '[{type:"heading_1",data:{...}}]' "标题"
node flowus-write.js --raw-file blocks.json "标题"   # 推荐：从文件读取避免转义

# 调试
node flowus-write.js --dry-run file.md               # 只解析不写入
```

**写入格式规范（实测验证）：**
- **写入模式**：统一 REST 块模式（mdToBlocks + appendBlocks），不使用 MCP putMarkdown（MCP Server 不提供该工具）
- 写入格式：`{ type: 'paragraph', data: { rich_text: [...] } }` — 统一用 `data` 键
- 读取返回：服务端转换为 `{ type: 'paragraph', paragraph: { rich_text: [...] } }` — 类型名键
- rich_text 创建时用简化格式：`{ text: { content: "..." } }`，不含 annotations/plain_text/href
- rich_text 单段 ≤ 2000 字符（超长自动分割）
- 单次追加 ≤ 100 子块（自动分批）
- 写入限速 ~100 次/分（内置 delay）
- **创建页面 properties 格式**：属性 key 必须是数据库中的实际属性名（如 `标题`），不是固定的 `title`。`_getTitlePropName()` 会自动查询数据库 schema 获取标题属性名
- **父级为普通页面时**：parent 用 `{ page_id: "xxx" }`，不用 database_id；且创建时不传 properties（FlowUs API 拒绝），标题通过创建后 PATCH /pages/{id} 设置
- **自动检测父级类型**：指定 --parent 但不指定 --parent-type 时，脚本自动 GET /pages/{id} 和 /databases/{id} 检测父级是页面还是数据库
- **icon 格式**：`{ type: 'emoji', emoji: '📝' }`（必须含 `type` 字段）
- **cover 格式**：`{ type: 'external', external: { url: 'https://...' } }`（必须含 `type` 和 `external` 嵌套）

**支持的块类型（15 种）：**
heading_1/2/3, paragraph, bulleted_list_item, numbered_list_item, to_do,
code, callout, quote, divider, image, bookmark, table(+table_row), toggle, child_page

### 2. flowus-read.js — 读取（V2）

**用途**: 读取 FlowUs 数据库记录、页面正文、全局搜索、语义搜索。

**V2 新特性**：
- **Markdown API 优先**：读取页面正文时优先使用 `GET /v2/pages/:id/content/markdown`，失败 fallback 到手动块转换
- **语义搜索**：`--semantic` 自然语言向量检索，返回匹配度+摘要
- **服务端过滤/排序**：`--filter` 和 `--sort` 直接传给 API，减少数据传输
- **429 限流自动重试**：遇到限流自动退避（优先使用 Retry-After 头）

```bash
# 基础读取
node flowus-read.js                    # 默认数据库最新 1 条
node flowus-read.js 5                  # 最新 5 条

# 指定目标
node flowus-read.js --db <databaseId>
node flowus-read.js --id <pageId>

# 列表与元数据
node flowus-read.js --db <id> --list
node flowus-read.js --db <id> --schema

# 搜索
node flowus-read.js --search "关键词"           # REST 全局搜索
node flowus-read.js --search "关键词" --search-filter page  # 限定搜索类型(page/database/folder/mind_map)
node flowus-read.js --semantic "自然语言查询"     # 语义搜索（向量检索）
node flowus-read.js --db <id> --keyword xxx     # 数据库内搜索（标题+属性+正文）
node flowus-read.js --db <id> --index 3         # 第 3 条
node flowus-read.js --db <id> --index 2-5       # 第 2~5 条

# 服务端过滤和排序（V2）
node flowus-read.js --db <id> --list --filter '{"property":"状态","select":{"equals":"完成"}}'
node flowus-read.js --db <id> --list --sort '创建时间:desc'
node flowus-read.js --db <id> --list --filter '{"and":[{"property":"作者","select":{"equals":"花叔"}}]}' --sort '日期:asc'

# 导出与原始数据
node flowus-read.js --id <id> --export
node flowus-read.js --raw

# 日期过滤
node flowus-read.js --from 2026-06-01
node flowus-read.js --to 2026-06-03
```

**属性类型支持（19/19 完整覆盖）：**
title, rich_text, number, checkbox, url, email, phone_number,
select, multi_select, date, people, files, relation,
formula, rollup, created_time, last_edited_time, created_by, last_edited_by

### 3. flowus-download.js — 下载导出（V2 纯 REST）

**V2 新特性**：
- **Markdown API 优先**：导出页面时优先使用 Markdown API，失败 fallback 到手动块转换
- **递归展开嵌套块**：所有层级子块完整展开，不再跳过
- **完整属性支持**：19 种属性类型全覆盖

```bash
# 单页 / 数据库批量导出
node flowus-download.js --id <pageId>
node flowus-download.js --db <dbId> 10
node flowus-download.js --db <dbId> --all
node flowus-download.js --db <dbId> --keyword xxx

# 微信文章剪藏链路
node flowus-download.js --clip [N]
node flowus-download.js --clip --all
node flowus-download.js --clip 3 --start 5

# 图片下载 + 输出控制
node flowus-download.js --images              # 同时下载图片
node flowus-download.js --output ./exports    # 自定义目录
```

### 4. wechat-fetch.js — 微信文章抓取（独立技能）

**用途**: 直接从微信公众号文章链接抓取内容，转为 Markdown。零外部依赖。

```bash
# 基础用法
node wechat-fetch.js <微信文章URL>

# Obsidian 双目录模式
node wechat-fetch.js <URL> --md-dir ./articles --img-dir ./assets

# 输出控制
node wechat-fetch.js <URL> --output ./articles
node wechat-fetch.js <URL> --raw

# 渲染策略
node wechat-fetch.js <URL> --mode http       # 强制 HTTP
node wechat-fetch.js <URL> --mode cdp        # 强制 Chrome 渲染

# 批量
echo "URL1\nURL2" | node wechat-fetch.js --list
```

---

## 典型工作流

### 工作流 A: 阅读 → 整理 → 写回

```bash
node flowus-read.js --db <sourceDb> --keyword "项目计划"
node flowus-write.js processed.md "整理后的项目计划"
node flowus-write.js --update processed.md "项目计划 v2"
```

### 工作流 B: 批量导出 → 本地处理

```bash
node flowus-download.js --db <dbId> --all --images --output ./backup
node flowus-download.js --db <dbId> --keyword "周报" --output ./reports
```

### 工作流 C: 微信抓取 → FlowUs 归档

```bash
# 先抓取微信文章
node wechat-fetch.js "https://mp.weixin.qq.com/s/xxx" --md-dir ./articles --img-dir ./assets
# 再上传到 FlowUs
node flowus-write.js ./articles/文章标题.md "文章标题"
```

### 工作流 D: 搜索 → 定位 → 操作

```bash
node flowus-read.js --search "API 文档"
node flowus-read.js --id <找到的 pageId>
node flowus-write.js --text "总结内容" "总结"
```

---

## 错误处理指南

| 错误现象 | 可能原因 | 解决方式 |
|----------|---------|----------|
| `缺少 FlowUs 授权 token` | 未提供 token（参数/环境变量/.env 均无） | 用 `--token <token>` 传入，或写入 `.env` 文件 |
| `HTTP_401/403` | Token 无效或过期 | 向用户重新索取 token |
| `validation_error (HTTP_400)` | properties 属性名不匹配数据库 schema | 属性 key 必须是数据库中的实际属性名（如 `标题`），不是固定的 `title` |
| `HTTP_500`（创建页面时） | 使用了 Idempotency-Key header | FlowUs API 不支持 Idempotency-Key，移除该 header |
| `TOOL_ERROR(404)` | 页面/数据库 ID 不存在 | 检查 ID |
| `REQUEST_TIMEOUT` | 网络超时或页面过大 | 增大超时或分批处理 |

---

## 技术约束

| 约束 | 值 |
|------|-----|
| API 版本 | V2 (`/v2` 前缀) |
| rich_text 单段上限 | 2000 字符 |
| 单次写入上限 | 100 个子块 |
| API 限流 | 120 次/分钟（429 自动退避重试） |
| 分页大小（MCP/REST） | 100 条/页 |
| 安全翻页上限 | 50000 条 |
| 删除方式 | 软删除（移入回收站，可恢复） |
| 外部依赖 | **零 npm 依赖** |

---

## 作为依赖库使用

```javascript
const mcp = require('./lib/mcp-client');
const rest = require('./lib/rest-client');

// 配置（Token 通过 --token 参数 / 环境变量 / .env 自动解析）
rest.configure({ token: token });
mcp.configure({ token: token, clientName: 'my-app' });

// 写入（纯 REST V2）
await rest.post('/pages', { parent: { database_id: 'xxx' }, properties: {...} });
await rest.patch('/blocks/{id}/children', { children: [block(...)] });

// 读取（MCP）
await mcp.mcpCall('API-getPage', { page_id: 'xxx' });

// Markdown API（V2 新增，优先使用）
const md = await rest.getPageMarkdown('page_id');  // → { markdown: "..." }

// 搜索（REST V2，支持 filter/sort）
await rest.search('关键词', { filter: { value: 'page' }, sort: { timestamp: 'last_edited_time' } });

// 语义搜索（V2 新增）
await rest.semanticSearch('自然语言查询', { pageSize: 10, scoreThreshold: 0.3 });

// 删除（V2，软删除）
await rest.deletePage('page_id');   // → { in_trash: true }
await rest.deleteBlock('block_id'); // → { in_trash: true }

// 更新块（V2 新增）
await rest.updateBlock('block_id', { type: 'paragraph', data: { rich_text: [...] } });

// 文件上传（V2 新增）
const uploadInfo = await rest.getUploadUrl({
  filename: 'image.png', contentType: 'image/png',
  contentLength: 12345, pageId: 'page_id'
});

// 用户信息验证
const user = await rest.me(); // → { id, name, email, avatar_url }
```
