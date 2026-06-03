#!/usr/bin/env python3
"""
微信公众号文章导出工具 - Obsidian 版 v5

v5 变更（Obsidian 适配）：
  - 图片命名：{文章名}-{序号}.{ext}（如 钉钉飞书集体转向-01.png）
  - Markdown 引用：![[文件名]] 格式（Obsidian wiki-link）
  - 目录结构：MD 文件 + 同名文件夹并排，图片在文件夹内
  - 预处理移除 <figcaption>，从源头消除图注重复

输出示例：
  Desktop/
    钉钉飞书集体转向/
      钉钉飞书集体转向.md
      钉钉飞书集体转向-01.png
      钉钉飞书集体转向-02.png
      ...
"""

import sys
import os
import re
from datetime import datetime
import argparse
import time

try:
    import requests
    from bs4 import BeautifulSoup
    from markdownify import markdownify as md
except ImportError as e:
    print(f"错误: 缺少必要的库: {e}")
    print("请运行: pip install requests beautifulsoup4 lxml markdownify")
    sys.exit(1)


SESSION = requests.Session()
SESSION.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://mp.weixin.qq.com/',
})


# =============================================================================
# 图片处理（Obsidian 命名 + 直接修改 soup）
# =============================================================================

def process_images(soup, img_dir, title_slug):
    """
    在 soup 子树上完成：懒加载修复 + 下载图片 + 命名替换。
    图片命名：{title_slug}-{序号}.{ext}
    img['src'] 设为纯文件名（供后续转 Obsidian ![[filename]] 用）。
    返回：下载成功数量。
    """
    os.makedirs(img_dir, exist_ok=True)

    imgs = soup.find_all('img')
    if not imgs:
        return 0

    count = 0
    for i, img in enumerate(imgs):
        # 懒加载：data-src → src
        raw_src = img.get('data-src') or img.get('src', '')
        if not raw_src or raw_src.startswith('data:'):
            continue
        img['src'] = raw_src

        # 下载
        print(f"    下载图片 [{i+1}/{len(imgs)}]: {raw_src[:65]}...")
        try:
            r = SESSION.get(raw_src, timeout=20)
            r.raise_for_status()
            content = r.content
        except Exception as e:
            print(f"      [跳过] 下载失败: {e}")
            continue

        # 扩展名
        ext = '.jpg'
        ctype = r.headers.get('Content-Type', '')
        if 'png' in ctype:       ext = '.png'
        elif 'gif' in ctype:      ext = '.gif'
        elif 'webp' in ctype:     ext = '.webp'
        elif 'wx_fmt=png' in raw_src:   ext = '.png'
        elif 'wx_fmt=gif' in raw_src:   ext = '.gif'
        elif 'wx_fmt=webp' in raw_src:  ext = '.webp'

        # Obsidian 命名：文章名-序号
        fname = f"{title_slug}-{i+1:02d}{ext}"
        fpath = os.path.join(img_dir, fname)
        with open(fpath, 'wb') as f:
            f.write(content)
        print(f"      已保存: {fname} ({len(content)//1024} KB)")

        # src 设为纯文件名（Obsidian ![[filename]] 需要的格式）
        img['src'] = fname
        count += 1
        time.sleep(0.3)

    return count


# =============================================================================
# HTML 预处理：移除 figcaption
# =============================================================================

def strip_figcaptions(soup):
    """从 HTML 中移除 <figcaption>，从源头消除图注重复问题"""
    for fc in soup.find_all('figcaption'):
        fc.decompose()


# =============================================================================
# Markdown 后处理：转为 Obsidian 图片格式
# =============================================================================

def to_obsidian_images(md_text):
    """
    将 markdownify 输出的 ![alt](filename) 转为 Obsidian ![[filename]] 格式。
    仅匹配已替换为本地文件名的图片（有扩展名且无 http）。
    """
    def replacer(m):
        alt = m.group(1)
        src = m.group(2)
        # 仅转换本地文件名的图片（含扩展名，非 http URL）
        if re.search(r'\.(png|jpg|jpeg|gif|webp)$', src, re.IGNORECASE) and not src.startswith('http'):
            return f'![[{src}]]'
        return m.group(0)  # CDN 链接保持原样

    return re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', replacer, md_text)


# =============================================================================
# HTML → Markdown
# =============================================================================

def soup_to_markdown(soup):
    return md(str(soup),
        heading_style='atx',
        code_language_markup=True,
        strip=['script', 'style', 'noscript', 'iframe'],
    )


# =============================================================================
# 元数据
# =============================================================================

def extract_meta(soup):
    meta = {}

    t = soup.find('meta', property='og:title')
    if not t:
        t = soup.find('meta', attrs={'name': 'description'})
    meta['title'] = t.get('content', '未知标题').strip() if t else '未知标题'

    t = soup.find('meta', property='og:article:author')
    meta['author'] = t.get('content', '').strip() if t else ''

    pub_time = ''
    for attr in ('og:article:published_time', 'article:published_time',
                 'publish_time', 'date', 'utctime'):
        t = soup.find('meta', attrs={attr: True})
        if t and t.get('content'):
            pub_time = t.get('content', '').strip()
            break
    meta['publish_time'] = pub_time

    t = soup.find('meta', property='og:description')
    meta['description'] = t.get('content', '').strip() if t else ''

    return meta


def safe_filename(s, max_len=50):
    """清理文件名，限制长度（避免路径过长）"""
    s = re.sub(r'[<>:"/\\|?*]', '', s)
    s = re.sub(r'\s+', '', s)
    s = s.strip('._')
    if len(s) > max_len:
        s = s[:max_len]
    return s


# =============================================================================
# 主导出流程
# =============================================================================

def export_article(url, md_dir=None, img_dir=None):
    """
    导出文章到指定目录。
    - md_dir: MD 文件输出目录
    - img_dir: 图片输出目录
    """
    # 默认输出目录（Obsidian 双轨结构）
    if not md_dir:
        md_dir = r'F:\obsidian\raw\flowus'
    if not img_dir:
        img_dir = r'F:\obsidian\assets'
    os.makedirs(md_dir, exist_ok=True)
    os.makedirs(img_dir, exist_ok=True)

    print(f"[1] 下载文章: {url}")
    try:
        response = SESSION.get(url, timeout=30)
        response.raise_for_status()
    except Exception as e:
        print(f"[失败] 无法下载文章 - {e}")
        return False

    # 用二进制读取，避免自动解码出错
    html = response.content
    soup = BeautifulSoup(html, 'lxml')

    # 元数据
    meta = extract_meta(soup)
    title_slug = safe_filename(meta['title'])
    print(f"[2] 标题：{meta['title']}")
    print(f"    作者：{meta['author'] or '(未知)'}")
    print(f"    时间：{meta['publish_time'] or '(未知)'}")

    # 正文
    content_div = soup.find('div', id='js_content')
    if not content_div:
        print("[失败] 无法找到正文内容（文章需要登录或已删除）")
        return False

    # 预处理：移除 figcaption（从源头消除图注重复）
    strip_figcaptions(content_div)

    # 双目录结构：
    #   md_dir/文章名.md         （MD 直接放在 md_dir 下）
    #   img_dir/文章名-01.png    （图片直接放在 img_dir 下，通过命名关联）
    # article_dir 仅用于日志显示
    article_dir = title_slug  # 仅用于日志

    # 图片处理（懒加载 + 下载 + 命名），直接放到 img_dir
    print(f"[3] 下载图片到 {img_dir} ...")
    img_count = process_images(content_div, img_dir, title_slug)
    print(f"    完成：{img_count} 张图片")

    # HTML → Markdown
    print(f"[4] 转换为 Markdown...")
    md_content = soup_to_markdown(content_div)

    # 转为 Obsidian 图片格式 ![[filename]]
    md_content = to_obsidian_images(md_content)

    # 写 MD 文件到 md_dir
    md_path = os.path.join(md_dir, f"{title_slug}.md")

    frontmatter = [
        "---",
        f"title: {meta['title']}",
        f"author: {meta['author']}",
        f"publish_time: {meta['publish_time']}",
        f"source_url: {url}",
        f"exported_at: {datetime.now().isoformat()}",
    ]
    if meta['description']:
        frontmatter.append(f"description: {meta['description']}")
    frontmatter.append("---\n")

    header = [
        f"# {meta['title']}",
        "",
        f"> 原文链接: {url}",
        "",
        f"**作者**: {meta['author'] or '未知'}",
        "",
        f"**发布时间**: {meta['publish_time'] or '未知'}",
        "",
        "---",
        "",
    ]

    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(frontmatter))
        f.write('\n'.join(header))
        f.write(md_content)

    size_kb = os.path.getsize(md_path) // 1024
    print(f"\n[完成] MD：{md_path} ({size_kb} KB)")
    print(f"       图片：{img_count} 张（保存在 {img_dir}）")
    return True


# =============================================================================
# 入口
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='微信公众号文章导出工具（Obsidian 版）',
    )
    parser.add_argument('url', help='微信公众号文章 URL')
    parser.add_argument('--md-dir', default=None, help='MD 文件输出目录')
    parser.add_argument('--img-dir', default=None, help='图片输出目录')
    parser.add_argument('--output', '-o', default=None, help='统一输出目录（md-dir 和 img-dir 共用）')

    args = parser.parse_args()
    if not args.url.startswith('https://mp.weixin.qq.com/'):
        print("错误: 不是有效的微信公众号文章 URL")
        sys.exit(1)

    # 确定输出目录
    desktop = os.path.join(os.path.expanduser('~'), 'Desktop')

    if args.output:
        # 统一目录模式：MD 和图片都在同一目录下（v5 兼容模式）
        md_dir = os.path.join(args.output, safe_filename(extract_title(args.url)))
        img_dir = md_dir  # 图片在 article_dir 子目录
    else:
        # 双目录模式：MD 和图片分开
        md_dir = args.md_dir or desktop
        img_dir = args.img_dir or desktop

    success = export_article(args.url, md_dir=md_dir, img_dir=img_dir)
    sys.exit(0 if success else 1)


def extract_title(url):
    """从 URL 提取标题（仅用于默认目录名）"""
    try:
        r = SESSION.get(url, timeout=10)
        soup = BeautifulSoup(r.text, 'lxml')
        t = soup.find('meta', property='og:title')
        return t.get('content', 'article').strip() if t else 'article'
    except:
        return 'article'


if __name__ == '__main__':
    main()
