# FlowUs Agent Skill

> **版本**: v2.1 | **架构**: 纯 REST API 写入 + MCP Streamable HTTP 读取
>
> 让 AI Agent 丝滑操作 FlowUs 云知识管理平台：读取、搜索、下载、写入、导出。
>
> **GitHub 就绪**：无硬编码 Token，全部通过环境变量配置。

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
| **写入** (write.js) | **纯 REST API** | 创建/查找/清空/追加/属性更新/删除，零 MCP 依赖 |
| **读取/搜索** (read.js) | **MCP + REST** | MCP 读取（封装好），REST 搜索 |
| **下载导出** (download.js) | **纯 REST API** | REST 读取内容 + REST 扫描剪藏列表，零 MCP 依赖 |
| **微信抓取** (wechat-fetch.js) | **HTTP + CDP** | 独立技能，零外部依赖 |

**环境变量配置：**
```bash
# 必需：API Token（同时适用于 MCP 和 REST）
export FLOWUS_TOKEN=your_token_here        # Bash/Zsh
$env:FLOWUS_TOKEN="your_token"             # PowerShell
set FLOWUS_TOKEN=your_token_here           # CMD

# 可选：默认目标数据库（避免每次指定 --db / --parent）
export FLOWUS_DEFAULT_DB=your_database_id
export FLOWUS_DEFAULT_PARENT=your_db_id
export FLOWUS_CLIP_DB=your_clip_db_id
```

---

## 文件清单

| 文件 | 职责 | 依赖 | Token |
|------|------|------|-------|
| `lib/mcp-client.js` | MCP Streamable HTTP 客户端 | 仅 Node 内置 | 需要（读取模块） |
| `lib/rest-client.js` | REST API 客户端（Bearer Token） | 仅 Node 内置 | 需要（写入模块） |
| `flowus-read.js` | 数据库读取 / 页面读取 / 全局搜索 / 关键词搜索 | mcp + rest | 需要 |
| `flowus-write.js` | Markdown 上传 / 代码上传 / 文本写入 / 页面更新 / 属性更新 / 删除 | **仅 rest** | 需要 |
| `flowus-download.js` | 导出为 .md / 批量导出 / 图片下载 / 剪藏微信文章 | **仅 rest** | 需要 |
| `wechat-fetch.js` | 微信公众号文章抓取（独立技能） | **零外部依赖** | 不需要 |

---

## 快速参考

### 场景 → 命令映射

| 用户意图 | 命令 |
|----------|------|
| "读取剪藏最新几条" | `node flowus-read.js [N]` |
| "搜索数据库中的 xxx" | `node flowus-read.js --db <id> --keyword xxx` |
| "全局搜索 xxx" | `node flowus-read.js --search xxx` |
| "读取某个页面的内容" | `node flowus-read.js --id <pageId>` |
| "把这个 .md 文件传到 FlowUs" | `node flowus-write.js file.md "标题"` |
| "带图标和封面创建页面" | `node flowus-write.js --icon 📝 --cover URL file.md "标题"` |
| "更新已有页面" | `node flowus-write.js --update file.md "标题"` |
| "更新页面属性" | `node flowus-write.js --update-prop <pageId> --prop key=value` |
| "删除页面" | `node flowus-write.js --delete <pageId>` |
| "导出为本地 .md 文件" | `node flowus-download.js --db <id> [N] --output ./dir` |
| "下载剪藏的微信文章" | `node flowus-download.js --clip [N]` |
| "抓取微信文章" | `node wechat-fetch.js <URL> --images` |

---

## 各模块详细说明

### 1. flowus-write.js — 写入（v2.0 纯 REST）

**用途**: 将内容写入 FlowUs。纯 REST API 架构，不依赖 MCP。

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
node flowus-write.js --parent <dbId> file.md        # 写入指定数据库
node flowus-write.js --update file.md "标题"         # 更新模式（清空后重写）

# 属性更新
node flowus-write.js --update-prop <pageId> --prop status=完成

# 删除页面
node flowus-write.js --delete <pageId>

# 原始 block JSON（高级用法）
node flowus-write.js --raw '[{type:"heading_1",data:{...}}]' "标题"
node flowus-write.js --raw-file blocks.json "标题"   # 推荐：从文件读取避免转义

# 调试
node flowus-write.js --dry-run file.md               # 只解析不写入
```

**写入格式规范（实测验证）：**
- 写入格式：`{ type: 'paragraph', data: { rich_text: [...] } }` — 统一用 `data` 键
- 读取返回：服务端转换为 `{ type: 'paragraph', paragraph: { rich_text: [...] } }` — 类型名键
- rich_text 单段 ≤ 2000 字符（超长自动分割）
- 单次追加 ≤ 100 子块（自动分批）
- 写入限速 ~100 次/分（内置 delay）

**支持的块类型（15 种）：**
heading_1/2/3, paragraph, bulleted_list_item, numbered_list_item, to_do,
code, callout, quote, divider, image, bookmark, table(+table_row), toggle, child_page

### 2. flowus-read.js — 读取

**用途**: 读取 FlowUs 数据库记录、页面正文、全局搜索。

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
node flowus-read.js --db <id> --keyword xxx     # 数据库内搜索（标题+属性+正文）
node flowus-read.js --db <id> --index 3         # 第 3 条
node flowus-read.js --db <id> --index 2-5       # 第 2~5 条

# 导出与原始数据
node flowus-read.js --id <id> --export
node flowus-read.js --raw

# 日期过滤
node flowus-read.js --from 2026-06-01
node flowus-read.js --to 2026-06-03
```

**属性类型支持（13/15）：**
title, rich_text, number, checkbox, url, email, phone_number,
select, multi_select, date, people, files, relation
（formula 为只读，created_time/last_edited_time/created_by/last_edited_by 为系统只读属性）

### 3. flowus-download.js — 下载导出（纯 REST）

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
| `未设置 FLOWUS_TOKEN` | 缺少环境变量 | `export FLOWUS_TOKEN=xxx` |
| `HTTP_401/403` | Token 无效或过期 | 检查 Token 是否正确 |
| `TOOL_ERROR(404)` | 页面/数据库 ID 不存在 | 检查 ID |
| `REQUEST_TIMEOUT` | 网络超时或页面过大 | 增大超时或分批处理 |

---

## 技术约束

| 约束 | 值 |
|------|-----|
| rich_text 单段上限 | 2000 字符 |
| 单次写入上限 | 100 个子块 |
| 写入频率限制 | ~100 次/分钟 |
| 分页大小（MCP/REST） | 100 条/页 |
| 安全翻页上限 | 50000 条 |
| 外部依赖 | **零 npm 依赖** |

---

## 作为依赖库使用

```javascript
const mcp = require('./lib/mcp-client');
const rest = require('./lib/rest-client');

// 配置（Token 通过环境变量传入）
rest.configure({ token: process.env.FLOWUS_TOKEN });
mcp.configure({ token: process.env.FLOWUS_TOKEN, clientName: 'my-app' });

// 写入（纯 REST）
await rest.post('/pages', { parent: { database_id: 'xxx' }, properties: {...} });
await rest.patch('/blocks/{id}/children', { children: [block(...)] });

// 读取（MCP）
await mcp.mcpCall('API-getPage', { page_id: 'xxx' });

// 搜索（REST，支持 filter/sort）
await rest.search('关键词', { filter: { value: 'page' }, sort: { timestamp: 'last_edited_time' } });

// 用户信息验证
const user = await rest.me(); // → { id, name, email, avatar_url }
```
