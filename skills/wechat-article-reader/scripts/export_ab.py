#!/usr/bin/env python3
"""导出微信公众号文章到 Obsidian A/B 文件夹格式"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from export import export_article

# A/B 文件夹路径
base_dir = os.path.join(os.path.expanduser('~'), 'Desktop', 'flowus')
md_dir = os.path.join(base_dir, 'A')
img_dir = os.path.join(base_dir, 'B')
os.makedirs(md_dir, exist_ok=True)
os.makedirs(img_dir, exist_ok=True)

url = 'https://mp.weixin.qq.com/s?__biz=Mzk2NDU0NDczMg==&mid=2247492431&idx=1&sn=240a0ed2bcab27a42af9b3228994c6bf'
print(f"导出到: {base_dir}")
print(f"  MD: {md_dir}")
print(f"  图片: {img_dir}")
export_article(url, md_dir=md_dir, img_dir=img_dir)
