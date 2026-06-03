---
name: "wechat-fetch"
description: "Fetch and convert WeChat (微信公众号) articles to Markdown with images. Invoke when user wants to grab content from a WeChat article URL (mp.weixin.qq.com/s/...) or mentions fetching WeChat articles directly without going through FlowUs."
---

# 微信公众号文章抓取技能 v2.0

独立于 FlowUs 的微信文章抓取工具。直接从微信公众号文章链接获取内容，转为格式完整的 Markdown 文件，支持图片下载和 Obsidian 适配。

## 核心能力

| 能力 | 说明 |
|------|------|
| **HTTP 直接抓取** | 模拟浏览器请求头（UA、Referer 等），绕过基础反爬 |
| **精准结构解析** | 识别 `#js_content` 正文区、`data-src` 懒加载图片、`og:title` 元信息 |
| **完整 MD 转换** | 标题/列表/代码块/GFM 表格/引用/加粗/斜体/链接/视频占位 |
| **YAML frontmatter** | 自动输出 title/author/publish_time/source_url/exported_at |
| **图片下载** | Content-Type + wx_fmt 双保险识别格式，自动命名和去重 |
| **Obsidian 适配** | `--md-dir` + `--img-dir` 双目录模式，绝对路径自动 wiki-link |
| **figcaption 去重** | 预处理时移除 `<figcaption>`，从源头消除图注重复 |
| **垃圾文字清洗** | 自动清除微信剪藏特有垃圾文字 |
| **CDP 降级** | HTTP 抓取内容不足时自动切换 Chrome 渲染模式 |

## 用法

```bash
# 基础用法
node wechat-fetch.js <微信文章URL>

# 输出控制
node wechat-fetch.js <URL> --output ./articles          # 统一输出目录
node wechat-fetch.js <URL> --md-dir ./md --img-dir ./img # Obsidian 双目录模式
node wechat-fetch.js <URL> --raw                        # 输出原始 HTML

# 图片下载
node wechat-fetch.js <URL> --images                     # 下载图片到默认 images/
node wechat-fetch.js <URL> --images ./pics              # 下载图片到指定目录

# 渲染策略
node wechat-fetch.js <URL> --mode http                  # 强制 HTTP 模式
node wechat-fetch.js <URL> --mode cdp                   # 强制 Chrome 渲染

# 批量模式
echo "URL1\nURL2" | node wechat-fetch.js --list         # 从 stdin 批量
```

## Obsidian 双目录模式

```bash
# MD 文件和图片分开放置（Obsidian 标准用法）
node wechat-fetch.js <URL> --md-dir F:\obsidian\raw\flowus --img-dir F:\obsidian\assets
```

当 `--img-dir` 为绝对路径时，MD 中图片自动使用 `![[filename.png]]` wiki-link 格式。

## 输出格式

导出的 Markdown 文件包含 YAML frontmatter：

```yaml
---
title: 文章标题
author: 作者名称
publish_time: 发布时间
source_url: 原文链接
exported_at: 导出时间戳
---

# 文章标题

> 原文链接: https://mp.weixin.qq.com/s/xxx
> 作者: xxx
> 发布时间: 2026/6/3

文章正文内容
```

## 图片命名规则

格式：`{文章标题}-{序号}.{扩展名}`

示例：`Claude Code终极教程-01.png`

同名文件自动加序号：`Claude Code终极教程-01-2.png`

## URL 格式支持

- 完整参数 URL：`https://mp.weixin.qq.com/s?__biz=xxx&mid=xxx&idx=1&sn=xxx`
- 短链 URL：`https://mp.weixin.qq.com/s/xxxxx`

## 关键技术细节

### 1. 懒加载图片处理

微信文章中的图片使用懒加载机制，脚本自动将 `data-src` 替换为 `src`。

### 2. 图片格式检测（三级判断）

1. **Content-Type 响应头**（最可靠）
2. **URL wx_fmt 参数**（微信特有，如 `wx_fmt=png`）
3. **URL 扩展名**（兜底）

### 3. figcaption 去重

预处理时移除所有 `<figcaption>` 标签，从源头消除图注重复问题。

### 4. 垃圾文字清洗

自动清除微信剪藏特有垃圾文字："在小说阅读器读本章"、"Original xxx"、"轻点两下取消赞"等。

### 5. 零外部依赖

仅使用 Node.js 内置模块：`https`, `http`, `fs`, `path`, `child_process`

## 与 FlowUs 技能的关系

本技能**完全独立**，不依赖任何 FlowUs Token 或 API。

典型配合流程：
1. **wechat-fetch** → 从微信抓取文章 → 得到 `.md`
2. **flowus-write** → 将 `.md` 上传到 FlowUs

```bash
# 先抓取
node wechat-fetch.js "https://mp.weixin.qq.com/s/xxxx" --md-dir ./articles --img-dir ./assets

# 再上传
node flowus-write.js ./articles/文章标题.md "文章标题"
```
