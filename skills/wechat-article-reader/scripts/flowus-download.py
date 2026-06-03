#!/usr/bin/env python3
"""
FlowUs 剪藏 → Obsidian 一键下载 v1.1

流程：
  1. REST API 获取剪藏列表（全量翻页）
  2. 本地按 created_time 降序排序
  3. 逐条获取页面属性，提取微信文章 URL
  4. 调用 export.py 下载 MD + 图片

用法：
  python flowus-download.py                              # 下载最新 1 篇
  python flowus-download.py 3                            # 下载最新 3 篇
  python flowus-download.py 3 --start 5                 # 从第 5 篇开始下载 3 篇
  python flowus-download.py --all                        # 下载全部微信文章
  python flowus-download.py --md-dir D:\docs --img-dir D:\img  # 自定义输出路径

默认输出路径：
  MD 文件 -> F:\obsidian\raw\flowus
  图片    -> F:\obsidian\assets
  （可通过 --md-dir / --img-dir 覆盖）

相关工具：
  clip-read.js    读取剪藏文章内容（支持多维过滤：序号/日期/关键词/作者）
  -> 位于：scripts/clip-read.js
"""
import sys, os, io, json, time, subprocess, argparse

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ========== 配置 ==========
TOKEN = 'Dc7Hb3P4z2S5toOTe0BOEn1XcgOHAdF9KFrNGmx6'
API_BASE = 'https://api.flowus.cn/v1'
HEADERS = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}
BID = 'd6611d46-3e37-40fb-aa83-976098e9ee91'

# export.py 路径（同目录）
EXPORT_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'export.py')

# 默认输出目录（不指定时使用）
DEFAULT_MD_DIR = r'F:\obsidian\raw\flowus'   # MD 文件
DEFAULT_IMG_DIR = r'F:\obsidian\assets'        # 图片

# 可通过命令行覆盖：
#   --md-dir <路径>   指定 MD 输出目录
#   --img-dir <路径>  指定图片输出目录

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ========== Session 复用 ==========
_session = None

def get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        adapter = HTTPAdapter(pool_connections=5, pool_maxsize=10,
                              max_retries=Retry(total=3, backoff_factor=0.5,
                                                status_forcelist=[500, 502, 503, 504]))
        _session.mount('https://', adapter)
        _session.headers.update(HEADERS)
    return _session


def get_all_child_pages():
    """获取剪藏数据库的所有子页面（全量翻页），按 created_time 降序排序"""
    print('[1] 获取剪藏列表...')

    all_items = []
    cursor = None
    session = get_session()

    while True:
        params = {'page_size': 100}
        if cursor:
            params['start_cursor'] = cursor

        try:
            resp = session.get(f'{API_BASE}/blocks/{BID}/children', params=params, timeout=15)
            if resp.status_code != 200:
                print(f'  API 错误: {resp.status_code}')
                break
        except Exception as e:
            print(f'  请求失败: {e}')
            break

        data = resp.json()
        items = data.get('results', [])
        all_items.extend(items)

        if not data.get('has_more'):
            break
        cursor = data.get('next_cursor')
        time.sleep(0.1)

    # 过滤 child_page 类型
    pages = [item for item in all_items if item.get('type') == 'child_page']

    # 按 created_time 降序排序（最新在前）
    pages.sort(key=lambda x: x.get('created_time', ''), reverse=True)

    print(f'  剪藏总数: {len(pages)}')
    return pages


def get_wechat_articles(start=1, count=1, fetch_all=False):
    """从排好序的子页面列表中提取微信文章（最新在前）"""
    pages = get_all_child_pages()
    if not pages:
        return []

    session = get_session()
    articles = []

    # 需要扫描的范围
    if fetch_all:
        scan_pages = pages
    else:
        end_idx = start + count - 1
        scan_pages = pages[:end_idx]

    print(f'[2] 提取微信文章 URL（需检查 {len(scan_pages)} 条）...')

    for item in scan_pages:
        pid = item.get('id')
        try:
            detail = session.get(f'{API_BASE}/pages/{pid}', timeout=10).json()
        except:
            continue

        props = detail.get('properties', {})

        # 标题
        title = ''
        for t in props.get('title', {}).get('title', []):
            title = t.get('text', {}).get('content', '')
            break
        if not title:
            continue

        # URL（遍历所有属性找 url 类型）
        url = ''
        for v in props.values():
            if v.get('type') == 'url':
                raw = v.get('url', '') or ''
                if 'mp.weixin.qq.com' in raw:
                    url = raw.replace('http://', 'https://')
                    break

        if url:
            articles.append({'title': title, 'url': url})
            print(f'  ✓ {title}')

        if not fetch_all and len(articles) >= start + count - 1:
            break

        time.sleep(0.05)

    # 截取需要的范围
    if fetch_all:
        result = articles
    else:
        start_idx = start - 1
        result = articles[start_idx:start_idx + count]

    print(f'  找到 {len(result)} 篇微信文章')
    return result


def download_one(article, md_dir, img_dir, index):
    """下载单篇文章，调用 export.py"""
    title = article['title']
    url = article['url']
    print(f'\n  下载 [{index}]: {title}')
    print(f'  URL: {url[:80]}...')

    # 构建环境变量，确保 export.py 也用 UTF-8
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'

    cmd = [sys.executable, EXPORT_SCRIPT, url, '--md-dir', md_dir, '--img-dir', img_dir]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=180, env=env)
        # Windows 下 subprocess 输出可能是 GBK
        stdout = result.stdout.decode('utf-8', errors='replace')
        stderr = result.stderr.decode('gbk', errors='replace')
        if result.returncode == 0:
            print(f'  ✓ 成功')
            return True
        else:
            err_msg = stderr.strip()[-300:] if stderr else stdout.strip()[-300:] or '未知错误'
            print(f'  ✗ 失败: {err_msg}')
            return False
    except subprocess.TimeoutExpired:
        print(f'  ✗ 超时 (180s)')
        return False
    except Exception as e:
        print(f'  ✗ 异常: {e}')
        return False


def main():
    parser = argparse.ArgumentParser(description='FlowUs 剪藏 → Obsidian 一键下载')
    parser.add_argument('count', nargs='?', type=int, default=1, help='下载数量（默认 1）')
    parser.add_argument('--start', type=int, default=1, help='从第几篇开始（默认 1）')
    parser.add_argument('--all', action='store_true', help='下载全部微信文章')
    parser.add_argument('--md-dir', default=None, help='MD 输出目录')
    parser.add_argument('--img-dir', default=None, help='图片输出目录')

    args = parser.parse_args()
    md_dir = args.md_dir or DEFAULT_MD_DIR
    img_dir = args.img_dir or DEFAULT_IMG_DIR
    os.makedirs(md_dir, exist_ok=True)
    os.makedirs(img_dir, exist_ok=True)

    count = 0 if args.all else args.count
    articles = get_wechat_articles(start=args.start, count=count, fetch_all=args.all)

    if not articles:
        print('\n未找到微信文章')
        sys.exit(1)

    print(f'\nMD 目录: {md_dir}')
    print(f'图片目录: {img_dir}')
    print(f'\n[3] 开始下载...')

    success = 0
    for i, article in enumerate(articles, 1):
        if download_one(article, md_dir, img_dir, i):
            success += 1

    print(f'\n{"="*50}')
    print(f'完成: {success}/{len(articles)} 成功')
    print(f'{"="*50}')


if __name__ == '__main__':
    main()
