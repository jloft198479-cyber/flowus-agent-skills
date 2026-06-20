# FlowUs Agent Skills

> 让 AI Agent 丝滑操作 FlowUs 云知识管理平台 + 微信公众号文章抓取

零 npm 依赖，纯 Node.js 实现，开箱即用。

## 功能概览

| 模块 | 功能 | 协议 | Token |
|------|------|------|-------|
| **flowus-write.js** | Markdown/代码上传、页面创建/更新/删除、属性更新 | 纯 REST | 需要 |
| **flowus-read.js** | 数据库读取、页面正文、全局搜索、关键词搜索 | MCP + REST | 需要 |
| **flowus-download.js** | 导出为 .md、批量导出、图片下载、剪藏下载 | 纯 REST | 需要 |
| **wechat-fetch.js** | 微信公众号文章抓取、图片下载、Obsidian 适配 | HTTP + CDP | 不需要 |

## 快速开始

### 1. 环境变量

```bash
# 必需：FlowUs API Token
export FLOWUS_TOKEN=your_token_here        # Bash/Zsh
$env:FLOWUS_TOKEN="your_token"             # PowerShell

# 可选：默认目标数据库
export FLOWUS_DEFAULT_DB=your_database_id
export FLOWUS_CLIP_DB=your_clip_db_id
```

### 2. 常用命令

```bash
# 读取剪藏最新 5 条
node flowus-read.js 5

# 搜索数据库
node flowus-read.js --db <id> --keyword "关键词"

# 上传 Markdown 到 FlowUs
node flowus-write.js article.md "文章标题"

# 导出页面为本地 .md
node flowus-download.js --id <pageId> --output ./exports

# 抓取微信文章
node wechat-fetch.js "https://mp.weixin.qq.com/s/xxx" --images
```

## 项目结构

```
├── SKILL.md                # Agent 编排手册（完整用法说明）
├── flowus-write.js         # 写入模块
├── flowus-read.js          # 读取模块
├── flowus-download.js      # 下载导出模块
├── wechat-fetch.js         # 微信文章抓取（独立技能）
├── lib/
│   ├── mcp-client.js       # MCP Streamable HTTP 客户端
│   └── rest-client.js      # REST API 客户端
├── skills/
│   └── wechat-article-reader/  # Python 版微信抓取（备选）
└── .trae/skills/
    └── wechat-fetch/       # Trae 技能定义
```

## 典型工作流

### 微信文章 → FlowUs 归档

```bash
# 1. 抓取微信文章
node wechat-fetch.js "https://mp.weixin.qq.com/s/xxx" --md-dir ./articles --img-dir ./assets

# 2. 上传到 FlowUs
node flowus-write.js ./articles/文章标题.md "文章标题"
```

### FlowUs 批量导出

```bash
# 导出数据库中所有记录（含图片）
node flowus-download.js --db <dbId> --all --images --output ./backup
```

### 搜索 → 定位 → 操作

```bash
node flowus-read.js --search "API 文档"
node flowus-read.js --id <pageId>
node flowus-write.js --text "总结内容" "总结"
```

## 技术特点

- **零 npm 依赖** — 仅使用 Node.js 内置模块（https, http, fs, path, child_process）
- **无硬编码 Token** — 全部通过环境变量配置，GitHub 安全
- **双协议架构** — 写入纯 REST（快速可靠），读取 MCP + REST（灵活）
- **Obsidian 适配** — wiki-link 格式、双目录模式、YAML frontmatter
- **微信懒加载图片** — 自动处理 data-src → src 转换

## 支持的 FlowUs 块类型

heading_1/2/3, paragraph, bulleted_list_item, numbered_list_item, to_do,
code, callout, quote, divider, image, bookmark, embed, table(+table_row), toggle, equation, link_to_page

## 许可证

MIT License

## 作者

CC派活儿
