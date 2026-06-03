#!/usr/bin/env node
/**
 * 微信公众号文章抓取工具 v2.0
 * 日期：2026-06-03
 *
 * 独立技能，不依赖 FlowUs。直接从微信文章链接抓取内容并转为 Markdown。
 *
 * v2.0 变更：
 *   - figcaption 去重（从源头消除图注重复）
 *   - YAML frontmatter（和 Python 版一致）
 *   - 图片格式检测升级（Content-Type → wx_fmt → URL 扩展名）
 *   - Obsidian 双目录模式（--md-dir + --img-dir）
 *   - 微信剪藏垃圾文字清洗
 *   - 空段落和 &nbsp; 清理
 *   - 图片文件名去重（自动加序号 -2, -3）
 *   - 标题去重（正文首标题与页面标题相同时删除重复）
 *
 * 核心能力：
 *   - HTTP 直接抓取（模拟浏览器请求头）
 *   - 精准解析微信文章 HTML 结构（#js_content、data-src 懒加载图片等）
 *   - 完整的 HTML→Markdown 转换（标题/列表/代码块/表格/引用/加粗等）
 *   - 图片下载到本地（mmbiz.qpic.cn CDN）
 *   - Chrome CDP 降级方案（HTTP 抓不到完整内容时自动切换）
 *
 * 用法：
 *   node wechat-fetch.js <微信文章URL>                          # 抓取单篇
 *   node wechat-fetch.js <URL> --output ./articles              # 输出到指定目录
 *   node wechat-fetch.js <URL> --images                         # 下载图片（默认同目录 images/）
 *   node wechat-fetch.js <URL> --images ./pics                  # 下载图片到指定目录
 *   node wechat-fetch.js <URL> --md-dir ./md --img-dir ./assets # Obsidian 双目录模式
 *   node wechat-fetch.js <URL> --raw                            # 原始 HTML
 *   node wechat-fetch.js <URL> --mode cdp                       # 强制用 Chrome 渲染
 *
 * 批量模式：
 *   echo "URL1\nURL2" | node wechat-fetch.js --list             # 从 stdin 批量
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============== 日志 ==============
function log(msg) {
  try { process.stderr.write('[wechat] ' + msg + '\n'); } catch (_) { /* ignore */ }
}
function out(msg) {
  console.log(msg);
}

// ============== 参数解析 ==============
function parseArgs(argv) {
  const opts = {
    urls: [],
    outputDir: null,
    mdDir: null,
    imgDir: null,
    downloadImages: false,
    imageDir: null,       // 兼容旧 --images 参数
    raw: false,
    mode: 'auto',       // auto | http | cdp
    timeout: 20000,
    waitRender: 10000,
    listMode: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output' || a === '-o') {
      opts.outputDir = argv[++i] || './';
    } else if (a === '--md-dir') {
      opts.mdDir = argv[++i] || null;
    } else if (a === '--img-dir') {
      opts.imgDir = argv[++i] || null;
    } else if (a === '--images') {
      opts.downloadImages = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts.imageDir = argv[++i]; }
    } else if (a === '--raw') {
      opts.raw = true;
    } else if (a === '--mode') {
      opts.mode = (argv[++i] || 'auto').toLowerCase();
    } else if (a === '--timeout') {
      opts.timeout = parseInt(argv[++i], 10) || 20000;
    } else if (a === '--wait') {
      opts.waitRender = parseInt(argv[++i], 10) || 10000;
    } else if (a === '--list') {
      opts.listMode = true;
    } else if (/^https?:\/\//.test(a)) {
      opts.urls.push(a);
    }
  }

  return opts;
}

// ============== URL 验证 ==============
function isWechatUrl(url) {
  return /mp\.weixin\.qq\.com\/(s\b|s\?)/.test(url);
}

// ============== 工具函数 ==============

/** 清理文件名 */
function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/_{2,}/g, '_').trim().substring(0, 120) || 'untitled';
}

/**
 * 去除所有 HTML 标签，提取纯文本（用于检测空壳页面）
 */
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取 <title>
 */
function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? decodeHTMLEntities(m[1].trim()) : '(无标题)';
}

/**
 * HTML 实体解码
 */
function decodeHTMLEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026');
}

// ============== HTTP 抓取 ==============

/** 微信文章抓取专用 Headers */
const WECHAT_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * HTTP GET 抓取网页
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{html: string, url: string, statusCode: number}>}
 */
function fetchHttp(url, options = {}) {
  const timeout = options.timeout || 20000;
  const extraHeaders = options.headers || {};

  log(`HTTP 抓取: ${url.substring(0, 80)}...`);

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout,
      headers: { ...WECHAT_HEADERS, ...extraHeaders },
    };

    const req = mod.request(reqOptions, (res) => {
      // 处理重定向（手动跟随）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).href;
        }
        log(`  重定向 ${res.statusCode} → ${redirectUrl.substring(0, 60)}...`);
        fetchHttp(redirectUrl, options).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP_${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf-8');
        resolve({ html, url, statusCode: res.statusCode });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`NETWORK_ERROR: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`REQUEST_TIMEOUT (${timeout}ms)`));
    });

    req.end();
  });
}

// ============== 微信文章结构化解析 ==============

/**
 * 解析微信文章的元信息
 * @param {string} html
 * @returns {{ title: string, author: string, accountId: string, publishTime: string, digest: string }}
 */
function parseWechatMeta(html) {
  const meta = {
    title: '',
    author: '',
    accountId: '',
    publishTime: '',
    digest: '',
  };

  // 标题：优先 og:title，其次 rich_media_title h1
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
  if (ogTitle) meta.title = decodeHTMLEntities(ogTitle[1]);
  if (!meta.title) {
    const h1Title = html.match(/<h1\s+class=["'][^"]*rich_media_title[^"']*["'][^>]*>([^<]*)<\/h1>/i);
    if (h1Title) meta.title = decodeHTMLEntities(h1Title[1]);
  }
  if (!meta.title) {
    meta.title = extractTitle(html).replace(/\s*_*\s*微信.*$/i, '').trim();
  }

  // 作者/公众号昵称：nickname 变量 或 og:description 中提取
  const nickMatch = html.match(/var\s+nickname\s*=\s*["']([^"']*)["']/i);
  if (nickMatch) meta.author = decodeHTMLEntities(nickMatch[1]);

  const acctMatch = html.match(/var\s+user_name\s*=\s*["']([^"']*)["']/i);
  if (acctMatch) meta.accountId = acctMatch[1];

  // 发布时间
  const timeMatch = html.match(/var\s+publish_time\s*=\s*["']([^"']*)["']\s*$/m)
    || html.match(/var\s+ct\s*=\s*["']([^"']*)["']/i);
  if (timeMatch) {
    const ts = parseInt(timeMatch[1], 10);
    if (ts > 0) {
      meta.publishTime = new Date(ts * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    }
  }
  // 备选：publish_time 元素
  if (!meta.publishTime) {
    const ptEl = html.match(/id=["']publish_time["'][^>]*>([^<]*)</i);
    if (ptEl) meta.publishTime = ptEl[1].trim();
  }

  // 摘要
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i);
  if (descMatch) meta.digest = decodeHTMLEntities(descMatch[1]);

  return meta;
}

/**
 * 提取微信文章正文区域 (#js_content)
 * @param {string} html
 * @returns {string} 正文 HTML 片段
 */
function extractBodyHtml(html) {
  // 微信正文核心选择器
  const patterns = [
    /<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/i,
    /<div[^>]*class=["'][^"]*rich_media_content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1].length > 50) return m[1];
  }

  // fallback: body 内容
  const bodyM = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyM ? bodyM[1] : html;
}

/**
 * 预处理微信正文 HTML：
 *   0. 移除 figcaption（从源头消除图注重复）
 *   1. 将 data-src 替换为 src（懒加载图片）
 *   2. 清理微信特有的标签（mp-*、wx-tap-* 等）
 *   3. 去除内联 style 中的无关属性
 * @param {string} html
 * @returns {{ cleanHtml: string, imageUrls: Array<{src:string, alt:string, index:number}> }}
 */
function preprocessWechatHtml(html) {
  let s = html;
  const imageUrls = [];
  let imgIndex = 0;

  // 0. 移除 figcaption（从源头消除图注重复问题）
  s = s.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, '');

  // 1. 图片：data-src → src（微信懒加载机制）
  s = s.replace(/<img([^>]*)>/gi, (tag, attrs) => {
    const srcMatch = attrs.match(/data-src=["']([^"']+)["']/i);
    const typeMatch = attrs.match(/data-type=["'](\w+)["']/i);
    const altMatch = attrs.match(/alt=["']([^"']*)["']/i);

    if (srcMatch) {
      const imgUrl = srcMatch[1].replace(/&amp;/g, '&'); // 反转义
      const alt = altMatch ? decodeHTMLEntities(altMatch[1]) : '';
      imageUrls.push({ src: imgUrl, alt, index: imgIndex++ });
      return `<img src="${imgUrl}" alt="${alt.replace(/"/g, '&quot;')}">`;
    }

    // 没有 data-src 的 img，检查普通 src
    const normalSrc = attrs.match(/src=["']([^"']+)["']/i);
    if (normalSrc && !normalSrc[1].startsWith('data:')) {
      const imgUrl = normalSrc[1];
      const alt = altMatch ? decodeHTMLEntities(altMatch[1]) : '';
      imageUrls.push({ src: imgUrl, alt, index: imgIndex++ });
    }

    return tag;
  });

  // 2. 移除微信特有组件标签（替换为占位或保留内部内容）
  s = s.replace(/<mp-common-[a-z-]+[^>]*>([\s\S]*?)<\/mp-common-[a-z-]+>/gi, '$1');
  s = s.replace(/<mp-check-channels[^>]*\/?>/gi, '');
  s = s.replace(/<mp-recommend[^>]*>[\s\S]*?<\/mp-recommend>/gi, '');

  // 3. 移除微信交互元素
  s = s.replace(/<section[^>]*class="[^"]*rich_media_tool[^"]*"[^>]*>[\s\S]*?<\/section>/gi, '');
  s = s.replace(/<div[^>]*class="[^"]*qr_code_pc[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  s = s.replace(/<div[^>]*class="[^"]*reward_tip[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // 4. 视频：提取为链接
  s = s.replace(/<mp-video[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, videoUrl) => {
    return `\n[视频: ${videoUrl}]\n`;
  });
  s = s.replace(/<iframe[^>]*src=["']([^"']*v\.qq\.com[^"']*)["'][^>]*><\/iframe>/gi, '[腾讯视频]');
  s = s.replace(/<iframe[^>]*src=["']([^"']+)["'][^>]*><\/iframe>/gi, '[嵌入式内容: $1]');

  // 5. 音频
  s = s.replace(/<mp-common-audio[^>]*>[\s\S]*?<\/mp-common-audio>/gi, '[音频]');

  return { cleanHtml: s, imageUrls };
}

// ============== HTML → Markdown 转换器 ==============

/**
 * 将预处理后的微信正文 HTML 转为 Markdown
 * 针对微信文章的富文本格式做了专门优化
 * @param {string} html
 * @returns {string}
 */
function wechatHtmlToMd(html) {
  let s = html;

  // ===== 第一轮：移除不需要的元素 =====
  // script / style
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

  // 导航、工具栏、广告等噪音
  s = s.replace(/<(nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 微信小程序卡片
  s = s.replace(/<wx-open-launch-weapp[^>]*>[\s\S]*?<\/wx-open-launch-weapp>/gi, '[小程序卡片]');

  // ===== 第二轮：结构转换 =====

  // 标题（微信正文中一般不用 h1-h3，但可能有）
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // 段落和换行
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');

  // section 标签（微信大量使用 section 做排版）→ 转为段落
  s = s.replace(/<section[^>]*>([\s\S]*?)<\/section>/gi, '\n$1\n');

  // 分隔线
  s = s.replace(/<hr\s*\/?>/gi, '\n---\n');

  // ===== 第三轮：列表处理 =====
  // 有序列表
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1');
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

  // ===== 第四轮：行内格式 =====

  // 加粗/斜体
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  s = s.replace(/<span[^>]*style="[^"]*font-weight:\s*bold[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '**$1**');

  // 行内代码
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 引用块
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (match, inner) => {
    const lines = inner.trim().split('\n').map(l => '> ' + l.trim()).join('\n');
    return '\n' + lines + '\n';
  });

  // ===== 第五轮：代码块（pre > code）=====
  // 先处理 pre/code 组合
  s = s.replace(/<pre[^>]*>\s*<code[^>]*class=["']language-(\w+)["'][^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    '\n```$1\n$2\n```\n');
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    '\n```\n$1\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // ===== 第六轮：表格 =====
  s = convertTables(s);

  // ===== 第七轮：链接和图片 =====
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // 图片在预处理中已处理过 src，这里统一转 Markdown 格式
  s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$2]($1)');
  s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)');

  // ===== 第八轮：清理 =====

  // 移除剩余标签（但保留内容）
  s = s.replace(/<[^>]+>/g, '');

  // HTML 实体解码
  s = decodeHTMLEntities(s);

  // 微信剪藏垃圾文字清洗
  s = s.replace(/在小说阅读器读本章/g, '');
  s = s.replace(/去阅读/g, '');
  s = s.replace(/在小说阅读器中沉浸阅读/g, '');
  s = s.replace(/^Original\s+.*$/gm, '');
  s = s.replace(/轻点两下取消赞/g, '');
  s = s.replace(/轻点两下取消在看/g, '');
  s = s.replace(/^赞$|^在看$/gm, '');
  s = s.replace(/视频\s*小程序/g, '');

  // &nbsp; 和空段落清理
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/^\s*$/gm, '');

  // 清理多余空白
  s = s.replace(/[ \t]+/g, ' ');                    // 多空格→单空格
  s = s.replace(/\n[ \t]+/g, '\n');                 // 行首空白
  s = s.replace(/[ \t]+\n/g, '\n');                 // 行尾空白
  s = s.replace(/\n{3,}/g, '\n\n');                 // 最多连续2个换行
  s = s.trim();

  return s;
}

/**
 * 表格 HTML → Markdown GFM 表格
 * 处理微信文章中常见的 table 结构
 */
function convertTables(html) {
  let s = html;

  // 匹配完整的 table 块
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;

  s = s.replace(tableRegex, (tableContent) => {
    const rows = [];

    // 提取所有 tr
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    let isHeader = true;

    while ((trMatch = trRegex.exec(tableContent)) !== null) {
      const cells = [];
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;

      while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
        cells.push(cellMatch[1].trim());
      }

      if (cells.length > 0) {
        rows.push('| ' + cells.join(' | ') + ' |');
        if (isHeader) {
          rows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
          isHeader = false;
        }
      }
    }

    return rows.length > 0 ? '\n' + rows.join('\n') + '\n' : tableContent;
  });

  return s;
}

// ============== 图片下载 ==============

/**
 * 下载单张图片
 * @param {string} url
 * @param {string} savePath
 * @returns {Promise<{ok: boolean, contentType: string}>}
 */
function downloadImage(url, savePath) {
  return new Promise((resolve) => {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location, savePath).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        log(`  图片下载失败 (${res.statusCode}): ${url.substring(0, 60)}`);
        resolve({ ok: false, contentType: '' });
        return;
      }

      const contentType = res.headers['content-type'] || '';
      const ws = fs.createWriteStream(savePath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve({ ok: true, contentType }); });
      ws.on('error', () => resolve({ ok: false, contentType: '' }));
    });

    req.on('error', () => resolve({ ok: false, contentType: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, contentType: '' }); });
  });
}

/**
 * 批量下载文章中的图片
 * @param {Array<{src:string, alt:string, index:number}>} imageUrls
 * @param {string} baseName 文章基础文件名（用于生成图片文件名）
 * @param {string} targetDir 目标目录
 * @param {boolean} useAbsPath 是否使用绝对路径（Obsidian wiki-link 模式）
 * @returns {Promise<Array<{url:string, fileName:string, localRelPath:string|null}>>}
 */
async function downloadImages(imageUrls, baseName, targetDir, useAbsPath = false) {
  if (imageUrls.length === 0) return [];

  const results = [];
  const imgTargetDir = targetDir || path.join(process.cwd(), 'images');
  const isExternalDir = /^[A-Za-z]:/.test(imgTargetDir) || imgTargetDir.startsWith('/');

  log(`  下载 ${imageUrls.length} 张图片 → ${imgTargetDir}`);

  for (let i = 0; i < imageUrls.length; i++) {
    const img = imageUrls[i];

    // 生成文件名：文章名-序号.扩展名
    // 扩展名判断优先级：URL wx_fmt 参数 → URL 扩展名 → 默认 jpg
    let ext = 'jpg'; // 默认 jpg（微信图片大多是 jpg）

    // 1. URL wx_fmt 参数判断
    if (/wx_fmt=png/i.test(img.src)) ext = 'png';
    else if (/wx_fmt=gif/i.test(img.src)) ext = 'gif';
    else if (/wx_fmt=webp/i.test(img.src)) ext = 'webp';
    // 2. URL 扩展名判断
    else {
      const extMatch = img.src.match(/\.(\w+)(?:\?|$)/);
      if (extMatch && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extMatch[1].toLowerCase())) {
        ext = extMatch[1].toLowerCase();
        if (ext === 'jpeg') ext = 'jpg';
      }
    }

    const fileName = `${baseName}-${String(i + 1).padStart(2, '0')}.${ext}`;
    let filePath = path.join(imgTargetDir, fileName);

    // 图片文件名去重：如果目标文件已存在，自动加序号
    let finalFileName = fileName;
    if (fs.existsSync(filePath)) {
      let dup = 2;
      while (fs.existsSync(path.join(imgTargetDir, `${baseName}-${String(i + 1).padStart(2, '0')}-${dup}.${ext}`))) dup++;
      finalFileName = `${baseName}-${String(i + 1).padStart(2, '0')}-${dup}.${ext}`;
      filePath = path.join(imgTargetDir, finalFileName);
    }

    // 直接下载到目标路径（不使用临时文件）
    const { ok, contentType } = await downloadImage(img.src, filePath);

    if (ok) {
      // 根据 Content-Type 校正扩展名（最高优先级）
      let correctedExt = null;
      if (contentType.includes('png')) correctedExt = 'png';
      else if (contentType.includes('gif')) correctedExt = 'gif';
      else if (contentType.includes('webp')) correctedExt = 'webp';

      if (correctedExt && correctedExt !== ext) {
        const correctedFileName = finalFileName.replace(/\.\w+$/, `.${correctedExt}`);
        const correctedPath = path.join(imgTargetDir, correctedFileName);
        try { fs.renameSync(filePath, correctedPath); } catch (_) {}
        finalFileName = correctedFileName;
      }

      const localRelPath = isExternalDir ? null : `images/${finalFileName}`;
      results.push({ url: img.src, fileName: finalFileName, localRelPath });
      log(`    ✓ ${finalFileName}`);
    } else {
      // 下载失败，清理残留文件
      try { fs.unlinkSync(filePath); } catch (_) {}
      results.push({ url: img.src, fileName: null, localRelPath: null });
      log(`    ✗ 图片 ${i + 1} 下载失败`);
    }

    // 限速，避免被 CDN 封
    if (i < imageUrls.length - 1) await sleep(200);
  }

  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============== Markdown 后处理 ==============

/**
 * 将 MD 中的图片 URL 替换为本地路径
 * @param {string} md
 * @param {Array<{url:string, fileName:string|null, localRelPath:string|null}>} images
 * @param {boolean} useWikiLink 是否使用 Obsidian wiki-link 格式
 * @returns {string}
 */
function replaceImageLinks(md, images, useWikiLink = false) {
  let result = md;
  for (const img of images) {
    if (!img.fileName) continue; // 下载失败的跳过

    if (useWikiLink && img.localRelPath === null) {
      // 外部绝对路径模式：wiki-link
      result = result.split(img.url).join(`![[${img.fileName}]]`);
    } else if (img.localRelPath) {
      // 相对路径模式：标准 MD
      result = result.split(img.url).join(`![](${img.localRelPath})`);
    }
  }
  return result;
}

// ============== Chrome CDP 降级方案 ==============

function checkChromeSupport() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return { available: true, chromePath: p }; } catch (_) {}
  }
  if (process.platform === 'darwin') {
    const mp = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(mp)) return { available: true, chromePath: mp };
  }
  return { available: false, chromePath: null };
}

async function fetchViaChrome(url, options = {}) {
  const { spawn } = require('child_process');
  const waitMs = options.waitMs || 10000;
  const timeout = options.timeout || 60000;

  const info = checkChromeSupport();
  if (!info.available) throw new Error('未找到 Chrome 浏览器');

  log(`Chrome 渲染模式: ${url.substring(0, 60)}...`);
  log(`  等待渲染: ${(waitMs / 1000).toFixed(1)}s`);

  return new Promise((resolve, reject) => {
    const chrome = spawn(info.chromePath, [
      '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-extensions',
      `--virtual-time-budget=${waitMs}`,
      '--dump-dom', url,
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutData = '', stderrData = '';

    chrome.stdout.on('data', d => { stdoutData += d.toString(); });
    chrome.stderr.on('data', d => { stderrData += d.toString(); });

    const timer = setTimeout(() => { try { chrome.kill(); } catch (_) {} reject(new Error('Chrome 超时')); }, timeout);

    chrome.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdoutData) {
        reject(new Error(`Chrome 退出码 ${code}: ${stderrData.substring(0, 200)}`));
        return;
      }
      const html = stdoutData.trim();
      if (!html) reject(new Error('Chrome 未输出内容'));
      else resolve({ html, url, statusCode: 200 });
    });

    chrome.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ============== 核心调度 ==============

/**
 * 抓取一篇微信文章
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{title:string, author:string, md:string, imageUrls:Array, meta:object, strategy:string}>}
 */
async function fetchArticle(url, options = {}) {
  const mode = options.mode || 'auto';
  const timeout = options.timeout || 20000;

  if (!isWechatUrl(url)) {
    throw new Error(`不是有效的微信公众号文章链接: ${url}`);
  }

  log(`抓取文章: ${url.substring(0, 70)}...`);

  let htmlResult;

  // ===== 策略选择 =====
  if (mode === 'cdp') {
    htmlResult = await fetchViaChrome(url, options);
  } else if (mode === 'http') {
    htmlResult = await fetchHttp(url, { timeout });
  } else {
    // auto：先尝试 HTTP
    try {
      htmlResult = await fetchHttp(url, { timeout });
      const bodyText = stripTags(extractBodyHtml(htmlResult.html));
      // 如果正文太短（< 100 字符），可能是反爬或需要 JS 渲染
      if (bodyText.length < 100) {
        log('  HTTP 内容不足，尝试 Chrome 渲染...');
        const cdpOk = checkChromeSupport().available;
        if (cdpOk) {
          htmlResult = await fetchViaChrome(url, options);
        } else {
          log('  Chrome 不可用，使用 HTTP 结果');
        }
      }
    } catch (e) {
      log(`  HTTP 失败: ${e.message.substring(0, 60)}`);
      const cdpOk = checkChromeSupport().available;
      if (cdpOk) {
        htmlResult = await fetchViaChrome(url, options);
      } else {
        throw e;
      }
    }
  }

  const strategy = (mode === 'cdp') ? 'chrome' :
                    (mode === 'http') ? 'http' :
                    (htmlResult.statusCode === 200) ? 'http-auto' : 'chrome-fallback';

  // ===== 解析 =====
  const meta = parseWechatMeta(htmlResult.html);
  const bodyHtml = extractBodyHtml(htmlResult.html);
  const { cleanHtml, imageUrls } = preprocessWechatHtml(bodyHtml);
  const md = wechatHtmlToMd(cleanHtml);

  log(`  标题: ${meta.title}`);
  log(`  作者: ${meta.author || '(未知)'}`);
  log(`  正文: ${md.length} 字符, ${imageUrls.length} 张图片`);

  return {
    title: meta.title,
    author: meta.author,
    md,
    imageUrls,
    meta,
    strategy,
  };
}

// ============== 文件输出 ==============

function saveToFile(content, fileName, outputDir) {
  let filePath;

  if (outputDir) {
    const outDir = path.resolve(outputDir);
    if (!fs.existsSync(outDir)) {
      try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    }
    filePath = path.join(outDir, fileName);
  } else {
    filePath = path.join(process.env.TEMP || '/tmp', fileName);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ============== 主入口 ==============
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --list 模式
  if (opts.listMode || opts.urls.length === 0) {
    if (opts.urls.length === 0 && process.stdin.isTTY) {
      out(`
微信公众号文章抓取 v2.0

用法:
  node wechat-fetch.js <微信文章URL>                           # 抓取单篇
  node wechat-fetch.js <URL> --output ./articles               # 输出到指定目录
  node wechat-fetch.js <URL> --images                          # 下载图片（默认 images/）
  node wechat-fetch.js <URL> --images ./pics                   # 下载图片到指定目录
  node wechat-fetch.js <URL> --md-dir ./md --img-dir ./assets  # Obsidian 双目录模式
  node wechat-fetch.js <URL> --raw                             # 输出原始 HTML
  node wechat-fetch.js <URL> --mode cdp                        # 强制 Chrome 渲染
  echo "URL1\\nURL2" | node wechat-fetch.js --list             # 批量抓取

Obsidian 双目录模式:
  --md-dir <路径>    指定 MD 文件输出目录
  --img-dir <路径>   指定图片输出目录（绝对路径时自动使用 wiki-link 格式）
  --output <路径>    统一目录的快捷方式（MD 和图片在同一目录）

示例:
  node wechat-fetch.js "https://mp.weixin.qq.com/s?__biz=xxx&mid=xxx"
  node wechat-fetch.js "https://mp.weixin.qq.com/s/xxxxx" --images --output ./articles
  node wechat-fetch.js "https://mp.weixin.qq.com/s/xxxxx" --md-dir ./notes --img-dir ./assets
`);
      return;
    }

    // 从 stdin 读
    if (opts.urls.length === 0) {
      let stdinData = '';
      const stdin = await new Promise(resolve => {
        let resolved = false;
        const timer = setTimeout(() => { resolved = true; resolve(''); }, 3000);
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { stdinData += chunk; });
        process.stdin.on('end', () => { if (!resolved) { clearTimeout(timer); resolve(stdinData); } });
        process.stdin.on('error', () => { if (!resolved) { clearTimeout(timer); resolve(''); } });
        if (!process.stdin.readable || process.stdin.isTTY) { clearTimeout(timer); resolve(''); }
      });
      if (stdinData) {
        opts.urls = stdinData.split('\n').map(l => l.trim()).filter(l => /^https?:\/\//.test(l));
      }
    }
  }

  if (opts.urls.length === 0) {
    out('错误: 未提供有效的微信文章 URL');
    process.exit(1);
  }

  // 逐个处理
  for (let i = 0; i < opts.urls.length; i++) {
    const url = opts.urls[i];
    log(`\n[${i + 1}/${opts.urls.length}] ================================`);

    try {
      const result = await fetchArticle(url, {
        mode: opts.mode,
        timeout: opts.timeout,
        waitRender: opts.waitRender,
      });

      // 原始模式
      if (opts.raw) {
        // raw 模式也先抓一次获取 HTML
        const httpRes = await fetchHttp(url, { timeout: opts.timeout });
        const rawFile = saveToFile(httpRes.html, `wechat-raw-${Date.now()}.html`, opts.outputDir);
        out(httpRes.html);
        out(`\n📄 原始 HTML 已保存: ${rawFile}`);
        continue;
      }

      // ===== 构建最终 Markdown =====
      const baseName = sanitizeFileName(result.title);
      const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      // YAML frontmatter
      const frontmatter = [
        '---',
        `title: ${result.title}`,
        `author: ${result.author || ''}`,
        `publish_time: ${result.meta.publishTime || ''}`,
        `source_url: ${url}`,
        `exported_at: ${new Date().toISOString()}`,
        '---',
        '',
      ].join('\n');

      const headerLines = [
        `# ${result.title}`,
        ``,
        `> 来源: 微信公众号`,
        result.author ? `> 作者: ${result.author}` : null,
        result.meta.publishTime ? `> 发布: ${result.meta.publishTime}` : null,
        `> 抓取时间: ${timestamp}`,
        `> 链接: ${url}`,
        ``,
      ].filter(Boolean).join('\n');

      let finalMd = frontmatter + headerLines + '\n' + result.md;

      // ===== 图片处理 =====
      let downloadedImages = [];
      if (opts.downloadImages && result.imageUrls.length > 0) {
        // 确定图片目标目录
        let imgDir = opts.imageDir; // 旧 --images 参数
        if (opts.imgDir) imgDir = opts.imgDir; // 新 --img-dir 参数优先

        // 确定是否使用 Obsidian wiki-link
        const useWikiLink = imgDir && (/^[A-Za-z]:/.test(imgDir) || imgDir.startsWith('/'));

        downloadedImages = await downloadImages(
          result.imageUrls,
          baseName,
          imgDir,
        );

        // 替换 MD 中的图片链接
        finalMd = replaceImageLinks(finalMd, downloadedImages, useWikiLink);
      }

      // ===== 标题去重 =====
      // 如果正文第一个标题和页面标题相同，删除正文中的重复标题
      const titleLine = `# ${result.title}`;
      if (finalMd.includes(titleLine)) {
        const firstIdx = finalMd.indexOf(titleLine);
        const secondIdx = finalMd.indexOf(titleLine, firstIdx + titleLine.length);
        if (secondIdx !== -1) {
          // 删除第二次出现的标题行
          finalMd = finalMd.substring(0, secondIdx) + finalMd.substring(secondIdx + titleLine.length);
        }
      }

      // ===== 输出 =====
      out(finalMd);

      // 确定 MD 文件保存目录
      let mdSaveDir = opts.outputDir;
      if (opts.mdDir) mdSaveDir = opts.mdDir;

      // 保存文件
      const outFile = saveToFile(finalMd, `${baseName}.md`, mdSaveDir);
      out(`\n📄 已保存: ${outFile}`);

      if (downloadedImages.length > 0) {
        const successCount = downloadedImages.filter(x => x.fileName).length;
        out(`🖼️ 图片: ${successCount}/${downloadedImages.length} 张成功`);
      }

      out(`--- [策略: ${result.strategy}] ---`);

    } catch (e) {
      log(`  ✗ 失败: ${e.message}`);
      out(`\n✗ 抓取失败: ${e.message}`);
    }

    if (i < opts.urls.length - 1) await sleep(500);
  }

  out('\n✅ 全部完成');
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
