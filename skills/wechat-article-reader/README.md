# 微信公众号文章读取方法

## 快速上手

当用户提供微信公众号链接时，使用 `wechat-article-reader` 技能导出文章为 Markdown。

## 技能信息

| 项目 | 内容 |
|------|------|
| **技能名称** | wechat-article-reader |
| **技能路径** | `F:\Users\fzz198479\.qclaw\workspace\skills\wechat-article-reader\SKILL.md` |
| **脚本路径** | `F:\Users\fzz198479\.qclaw\workspace\skills\wechat-article-reader\scripts\export.py` |
| **输出目录** | `F:\Users\fzz198479\.qclaw\workspace\source` |

## 触发条件

- 用户提供微信公众号文章链接 (mp.weixin.qq.com)
- 用户要求"下载"、"导出"或"保存"微信文章
- 用户要求将微信文章转换为 Markdown

## 执行步骤

### 1. 检查依赖
```bash
python -c "import requests; import bs4; import markdownify; print('OK')"
```

### 2. 运行导出脚本
```bash
python "F:\Users\fzz198479\.qclaw\workspace\skills\wechat-article-reader\scripts\export.py" "<文章URL>" "F:\Users\fzz198479\.qclaw\workspace\source"
```

### 3. 读取导出的文件
- 文件命名格式：`YYYYMMDD_HHMMSS_文章标题.md`
- 位置：`F:\Users\fzz198479\.qclaw\workspace\source\`

## 已知问题与解决方案

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Windows 控制台输出乱码 | PowerShell 默认编码为 GBK | 已修复：将脚本中的 Unicode 字符（✓）替换为 ASCII 字符（[成功]） |
| 部分文章无法提取 | 需要微信登录或已被删除 | 尝试在浏览器中打开，或使用 browser-cdp 技能 |
| 图片未下载 | 脚本仅保存 Markdown 文本 | 如需图片，需额外处理 |

## 依赖安装（如需要）

```bash
pip install requests beautifulsoup4 lxml markdownify
```

## 替代方案

如果 wechat-article-reader 技能失效，可考虑：

1. **browser-cdp 技能** - 通过浏览器直接访问文章页面获取内容
2. **browser 工具** - 使用 OpenClaw 内置浏览器工具访问
3. **在线服务** - 如 shengqiang.fun 等微信文章导出工具（需评估安全性）

## 更新记录

- **2026-04-11**: 修复 Windows 编码问题，成功读取测试文章
