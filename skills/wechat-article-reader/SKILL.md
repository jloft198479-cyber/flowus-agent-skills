---
name: WeChat-article-reader
description: "将微信公众号文章导出为 Markdown 格式 + 图片。当用户提供微信公众号链接 (mp.weixin.qq.com)、FlowUs 剪藏链接，或要求下载/导出/保存微信文章时触发。默认输出：MD → F:\\obsidian\\raw\\flowus，图片 → F:\\obsidian\\assets。"
---

# 微信公众号文章导出技能 (WeChat-Article-Reader)

## 触发条件

当以下情况时触发此技能：

- 用户提供微信公众号文章链接 (mp.weixin.qq.com)
- 用户要求"下载"、"导出"或"保存"微信文章
- 用户要求将微信文章转换为 Markdown
- 用户提到"公众号文章"、"微信文章"、"下载微信"、"导出公众号"

**触发示例：**
- "下载这篇文章 https://mp.weixin.qq.com/s/xxx"
- "把这篇公众号文章导出为 markdown"
- "保存微信文章到本地"
- "帮我保存这篇微信文章"
- "查看 FlowUs 最新收藏并下载"

## 工作原理

此技能使用 Python 脚本执行以下操作：
1. 通过 FlowUs REST API 获取剪藏列表（自动翻页 + 按时间排序）
2. 提取剪藏中的微信文章 URL
3. 抓取微信文章 HTML 页面
4. 从 `#js_content` div 提取正文内容
5. 下载所有文章图片，按「标题-序号」命名
6. 使用 markdownify 将 HTML 转换为 Obsidian 格式 Markdown

## 脚本目录

**基础目录**：`~/.workbuddy/skills/wechat-article-reader`

**调度脚本**：`scripts/flowus-download.py`（主入口，**v1.1**）
**执行脚本**：`scripts/export.py`（下载单篇文章，被 flowus-download.py 调用，**v5**）

## 相关工具

此技能与 FlowUs 读写链路配合使用：

| 工具 | 版本 | 功能 |
|------|------|------|
| `clip-read.js` | v2.0 | 读取 FlowUs 剪藏（前置：先读剪藏获取序号） |
| `markdown-to-flowus.js` | v3.1 | 上传本地 MD 到 FlowUs 工作副本（后续：文档写回） |

完整生产线：**clip-read（读）→ flowus-download（下）→ markdown-to-flowus（写）**

## 安装设置

### 依赖检查

```bash
python -c "import requests, bs4, markdownify" 2>/dev/null || echo "需要安装依赖"
```

### 如需安装依赖

```bash
pip install requests beautifulsoup4 lxml markdownify
```

## 默认输出路径

| 类型 | 默认路径 | 可覆盖参数 |
|------|---------|-----------|
| MD 文件 | `F:\obsidian\raw\flowus` | `--md-dir <路径>` |
| 图片 | `F:\obsidian\assets` | `--img-dir <路径>` |

## 执行步骤

当此技能被触发时，按以下步骤执行：

### 步骤 1：执行下载脚本

```bash
# 下载最新 1 篇
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py 1

# 下载最新 N 篇
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py 5

# 下载全部
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py --all

# 自定义输出路径
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py 3 --md-dir D:\docs --img-dir D:\img
```

### 步骤 2：报告结果

告知用户：
- 成功或失败状态
- 输出文件路径
- 下载数量（成功 / 总数）
- 任何错误或警告

## 命令示例

```bash
# 基本导出（默认路径）
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py 1

# 指定自定义输出目录
python ~/.workbuddy/skills/wechat-article-reader/scripts/flowus-download.py 3 --md-dir D:\docs --img-dir D:\img
```

## 输出格式

导出的 Markdown 文件包含：

```yaml
---
title: 文章标题
author: 作者名称
publish_time: 发布时间
source_url: 原文链接
exported_at: 导出时间戳
---

# 文章标题

文章正文内容（Obsidian wiki-link 格式引用图片）
```

## 图片命名

格式：`{文章标题}-{序号}.{扩展名}`
示例：`Claude Code终极教程-01.png`

## 已知限制

- **需要登录的文章**：部分文章需要微信登录才能查看
- **反爬虫**：微信有反机器人措施，可能阻止频繁请求
- **已删除文章**：约 7% 的剪藏文章无法下载（需登录、已删除、链接失效）

## 错误处理

脚本会：
- 跳过已存在的文件（按文件名去重，可安全重复执行）
- 打印清晰的中文进度信息
- 批量下载时自动跳过失败项，汇总报告
