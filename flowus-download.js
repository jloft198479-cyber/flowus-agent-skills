#!/usr/bin/env node
/**
 * FlowUs 下载导出脚本 v1.0
 *
 * 基于 lib/rest-client 底层，
 * 提供 FlowUs 内容的本地导出能力：
 *
 *   - 页面 / 数据库记录 → 本地 .md 文件（含完整正文）
 *   - 批量导出数据库记录（支持过滤）
 *   - 图片/附件本地下载（自动替换 MD 引用）
 *   - 微信文章剪藏批量下载链路
 *
 * 与 flowus-read.js 的区别：
 *   flowus-read.js 侧重终端阅读展示（stdout 输出）
 *   flowus-download.js 侧重文件导出和附件下载（磁盘写入）
 *
 * 用法：
 *   node flowus-download.js --id <pageId>              # 导出单个页面
 *   node flowus-download.js --db <dbId>                 # 导出数据库最新 1 条
 *   node flowus-download.js --db <dbId> 5               # 导出最新 5 条
 *   node flowus-download.js --db <dbId> --all           # 导出全部记录
 *   node flowus-download.js --db <dbId> --keyword xxx   # 按关键词过滤导出
 *   node flowus-download.js --clip [N]                  # 剪藏微信文章下载
 *   node flowus-download.js --clip --all                # 剪藏全部下载
 *   node flowus-download.js --clip 3 --start 5          # 从第 5 篇开始下 3 篇
 *   node flowus-download.js --output ./exports          # 指定输出目录
 *   node flowus-download.js --images                    # 同时下载图片
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const path = require('path');
const fs = require('fs');
const https = require('https');
const rest = require('./lib/rest-client');

// ============== 配置 ==============
/** Token 必须通过环境变量 FLOWUS_TOKEN 提供 */
const TOKEN = process.env.FLOWUS_TOKEN;
/** 默认剪藏数据库（可通过环境变量 FLOWUS_CLIP_DB 覆盖，或通过 --db 指定） */
const DEFAULT_DB_ID = process.env.FLOWUS_CLIP_DB || '';
/** 剪藏数据库 ID（用于 --clip 模式，可被 --db 覆盖） */
const CLIP_DB_ID = process.env.FLOWUS_CLIP_DB || '';
/** 默认输出目录 */
const DEFAULT_OUTPUT_DIR = path.join(require('os').homedir(), 'Desktop', 'flowus', 'downloads');

// ============== 日志 ==============
function log(msg) {
  try { process.stderr.write('[download] ' + msg + '\n'); } catch (_) { /* ignore */ }
}
function out(msg) {
  console.log(msg);
}

// ============== 参数解析 ==============
function parseArgs(argv) {
  const opts = {
    pageId: null,      // --id <pageId>
    dbId: null,        // --db <dbId>
    count: null,       // 数字参数：导出数量
    all: false,        // --all
    keywords: [],      // --keyword xxx
    clipMode: false,   // --clip
    clipAll: false,    // --clip --all
    clipStart: 1,      // --start N
    outputDir: null,   // --output <dir>
    mdDir: null,       // --md-dir <dir>（MD 输出目录）
    imgDir: null,      // --img-dir <dir>（图片输出目录）
    downloadImages: false, // --images
    raw: false,        // --raw
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') { opts.pageId = argv[++i]; }
    else if (a === '--db') { opts.dbId = argv[++i]; }
    else if (a === '--all') { opts.all = true; }
    else if (a === '--clip') { opts.clipMode = true; }
    else if (a === '--clip-all' || (opts.clipMode && a === '--all')) { opts.clipAll = true; }
    else if (a === '--start') { opts.clipStart = parseInt(argv[++i], 10) || 1; }
    else if (a === '--output') { opts.outputDir = argv[++i]; }
    else if (a === '--md-dir') { opts.mdDir = argv[++i]; }
    else if (a === '--img-dir') { opts.imgDir = argv[++i]; }
    else if (a === '--images') {
      opts.downloadImages = true;
      // --images 可选接路径参数：--images F:/obsidian/assets
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts.imageDir = argv[++i]; }
    }
    else if (a === '--keyword') { opts.keywords.push(...(argv[++i] || '').toLowerCase().split(/\s+/).filter(Boolean)); }
    else if (a === '--raw') { opts.raw = true; }
    else if (/^\d+$/.test(a)) { opts.count = parseInt(a, 10); }
  }

  return opts;
}

// ============== 工具函数 ==============

/**
 * 从 rich_text 数组提取纯文本
 */
function extractRichText(rt) {
  if (!rt || !Array.isArray(rt)) return '';
  return rt.map(r => r.plain_text || r.text?.content || '').join('');
}

/**
 * 从 block 中提取文本内容
 */
function extractBlockText(block) {
  const type = block.type;
  const data = block[type] || block.data || {};
  const rt = data.rich_text;
  if (!rt || !Array.isArray(rt)) return '';
  return rt.map(r => r.text?.content || r.plain_text || '').join('');
}

/**
 * 通用属性值提取（兼容中英文属性名）
 */
function getPropValue(props, ...names) {
  for (const name of names) {
    const prop = props?.[name];
    if (!prop) continue;
    const val = prop[prop.type];
    if (val == null) continue;
    switch (prop.type) {
      case 'title': return extractRichText(val);
      case 'rich_text': return extractRichText(val);
      case 'select': return val.name || null;
      case 'multi_select': return val.map(x => x.name).join(', ') || null;
      case 'number': return String(val);
      case 'date': return val.start || String(val);
      case 'url': return String(val);
      case 'checkbox': return val ? '✅' : '⬜';
      default: return typeof val === 'object' ? JSON.stringify(val) : String(val);
    }
  }
  return null;
}

function getTitle(props) {
  return getPropValue(props, 'title', '标题') || '(无标题)';
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
  catch { return iso; }
}

/** 清理文件名中的非法字符 */
function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').substring(0, 100);
}

/** 转义正则特殊字符 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清洗微信剪藏混入的垃圾文字
 * 微信页面被剪藏到 FlowUs 时会带进来阅读器 UI、元信息行等无关内容
 */
function cleanWechatArtifacts(md) {
  const lines = md.split('\n');
  const cleaned = lines.filter(line => {
    const t = line.trim();
    // 微信阅读器 UI 文字
    if (/^(在小说阅读器读本章|去阅读|在小说阅读器中沉浸阅读)$/.test(t)) return false;
    // "Original 作者 公众号 时间 地点" 元信息行
    if (/^Original\s/.test(t)) return false;
    return true;
  });
  return cleaned.join('\n');
}

// ============== Block → Markdown 转换 ==============

/**
 * 将 blocks 数组转换为 Markdown 字符串
 * @param {Array} blocks
 * @param {object} [options]
 * @param {string} [options.imageDir] - 图片相对路径前缀
 * @returns {{ md: string, imageUrls: string[] }} md 内容和收集到的图片 URL 列表
 */
function blocksToMarkdown(blocks, options = {}) {
  const lines = [];
  const imageUrls = []; // 收集所有图片 URL
  const usedFileNames = new Map(); // 去重：同名文件加 -2, -3 后缀

  for (const block of blocks) {
    const type = block.type;
    const data = block[type] || block.data || {};
    const text = extractBlockText(block);

    switch (type) {
      case 'heading_1':
        lines.push(`\n# ${text}`);
        break;
      case 'heading_2':
        lines.push(`\n## ${text}`);
        break;
      case 'heading_3':
        lines.push(`\n### ${text}`);
        break;
      case 'paragraph':
        // 过滤空段落和 &nbsp; 段落
        // 过滤空段落和 &nbsp;（ ）段落
        if (text.replace(/ /g, '').trim()) lines.push(text);
        break;
      case 'divider':
        lines.push('\n---');
        break;
      case 'bulleted_list_item':
        lines.push(`  - ${text}`);
        break;
      case 'numbered_list_item':
        lines.push(`  1. ${text}`);
        break;
      case 'to_do': {
        const checked = data.checked ? 'x' : ' ';
        lines.push(`  [${checked}] ${text}`);
        break;
      }
      case 'code': {
        const lang = data.language || '';
        lines.push(`\n\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case 'quote':
        lines.push(`\n> ${text}`);
        break;
      case 'callout': {
        const icon = data.icon?.emoji || data.icon?.type || '💡';
        lines.push(`\n> ${icon} ${text}`);
        break;
      }
      case 'image': {
        const url = data.file?.url || data.external?.url || '';
        if (url) {
          let fileName = decodeURIComponent(path.basename(url.split('?')[0])) || 'image.png';
          // 文件名去重（同名自动加序号）
          if (usedFileNames.has(fileName)) {
            const c = usedFileNames.get(fileName);
            usedFileNames.set(fileName, c + 1);
            const ext = path.extname(fileName);
            fileName = `${path.basename(fileName, ext)}-${c}${ext}`;
          } else {
            usedFileNames.set(fileName, 1);
          }
          // 判断是否使用 Obsidian wiki-link 格式（绝对路径 = 外部目录）
          const isExternalDir = options.imageDir && (/^[A-Za-z]:/.test(options.imageDir) || options.imageDir.startsWith('/'));
          if (isExternalDir) {
            lines.push(`\n![[${decodeURIComponent(fileName)}]]`);
            imageUrls.push({ url, fileName, targetDir: options.imageDir });
          } else {
            const imgRelPath = options.imageDir ? `${options.imageDir}/${fileName}` : url;
            lines.push(`\n![image](${imgRelPath})`);
            imageUrls.push({ url, relPath: imgRelPath });
          }
        }
        break;
      }
      case 'file': {
        // 文件/附件块：提取文件名和 URL，导出为图片或链接格式
        const fileUrl = data.file?.url || data.external?.url || '';
        if (fileUrl) {
          let rawName = decodeURIComponent(path.basename(fileUrl.split('?')[0])) || 'file';
          // 文件名去重（同名自动加序号）
          if (usedFileNames.has(rawName)) {
            const c = usedFileNames.get(rawName);
            usedFileNames.set(rawName, c + 1);
            const ext = path.extname(rawName);
            rawName = `${path.basename(rawName, ext)}-${c}${ext}`;
          } else {
            usedFileNames.set(rawName, 1);
          }
          // 判断是否使用 Obsidian wiki-link 格式
          const isExternalDir = options.imageDir && (/^[A-Za-z]:/.test(options.imageDir) || options.imageDir.startsWith('/'));
          if (isExternalDir) {
            lines.push(`\n![[${rawName}]]`);
            imageUrls.push({ url: fileUrl, fileName: rawName, targetDir: options.imageDir });
          } else {
            const fileRelPath = options.imageDir ? `${options.imageDir}/${rawName}` : fileUrl;
            lines.push(`\n![${rawName}](${fileRelPath})`);
            imageUrls.push({ url: fileUrl, relPath: fileRelPath });
          }
        } else {
          // 无 URL，只有名称/描述
          const altName = data.file?.name || (data.caption ? extractRichText(data.caption).slice(0, 80) : '附件');
          lines.push(`\n📎 ${altName}`);
        }
        break;
      }
      case 'bookmark':
        lines.push(`\n[${text}](${data.url || ''})`);
        break;
      case 'embed':
        lines.push(`\n[embed](${data.url || ''})`);
        break;
      case 'table': {
        // 表格头：输出列数信息，后续 table_row 输出具体行
        const width = data.table_width || 0;
        if (width > 0) {
          lines.push(`<!-- TABLE_START:${width} -->`);
        }
        break;
      }
      case 'table_row':
        // 表格行：提取单元格文本，首行自动加分隔线（始终把第一行当表头）
        if (data.cells && Array.isArray(data.cells)) {
          const rowStr = data.cells.map(cell =>
            extractRichText(cell).replace(/\|/g, '\\|').trim()
          ).join(' | ');
          const line = `| ${rowStr} |`;
          lines.push(line);
          // 检查上一行是否是 TABLE_START 标记，如果是则在第一行后插入分隔线
          const prevIdx = lines.length - 2;
          if (prevIdx >= 0 && lines[prevIdx].startsWith('<!-- TABLE_START:')) {
            const colCount = data.cells.length;
            lines[prevIdx] = ''; // 清除标记
            lines.splice(prevIdx + 2, 0, '| ' + Array(colCount).fill('---').join(' | ') + ' |');
          }
        } else {
          // table_row 无 cells 数据，跳过
        }
        break;
      case 'toggle': {
        const summary = text || '(折叠内容)';
        lines.push(`<details>\n<summary>${summary}</summary>`);
        // toggle 的 children 需要递归处理，这里简化为标记
        lines.push(`\n(折叠块内容需展开查看)`);
        lines.push(`\n</details>`);
        break;
      }
      case 'child_page':
        // 子页面引用，跳过
        break;
      default:
        if (text.trim()) lines.push(text);
    }
  }

  return { md: lines.join('\n'), imageUrls };
}

// ============== REST 读取操作 ==============

async function restQueryAllRecords(dbId) {
  const all = await rest.queryDatabase(dbId);
  all.sort((a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0));
  return all;
}

async function searchInBody(pageId, keywords) {
  if (!keywords.length) return false;
  try {
    const blocks = await rest.getAllBlocks(pageId);
    const fullText = blocks.map(extractBlockText).join(' ').toLowerCase();
    return keywords.every(kw => fullText.includes(kw));
  } catch (e) { return false; }
}

/**
 * 展开嵌套子块（一层），扁平化插入
 * 对 has_children=true 的块（如 table），获取其子块并插入到该块后面
 * @param {Array} blocks - 顶层块列表
 * @returns {Promise<Array>} 扁平化后的块列表
 */
async function expandNestedBlocks(blocks) {
  const needExpand = blocks.filter(b => b.has_children && !b.children?.length);
  if (needExpand.length === 0) return blocks;

  log(`  展开 ${needExpand.length} 个嵌套块（table 等）...`);
  const result = [...blocks];

  for (let i = 0; i < result.length; i++) {
    const b = result[i];
    if (!b.has_children || b.children?.length) continue;

    try {
      const res = await rest.get(`/blocks/${b.id}/children?page_size=100`);
      const children = res.results || [];
      b.children = children;
      if (children.length > 0) {
        result.splice(i + 1, 0, ...children);
        i += children.length;
      }
    } catch (e) {
      log(`    展开 ${b.type}(${b.id}) 失败: ${e.message.substring(0, 60)}`);
      b.children = [];
    }
    await rest.sleep(50);
  }
  return result;
}

// ============== 图片下载 ==============

/**
 * 下载单个图片文件到本地
 * @param {string} url - 图片 URL
 * @param {string} filePath - 本地保存路径
 * @returns {Promise<boolean>} 是否成功
 */
function downloadFile(url, filePath) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : require('http');
    const req = proto.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 处理重定向
        downloadFile(res.headers.location, filePath).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        log(`  图片下载失败: HTTP ${res.statusCode} - ${url.substring(0, 60)}`);
        resolve(false);
        return;
      }

      // 确保目录存在
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      const ws = fs.createWriteStream(filePath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    req.on('error', (err) => {
      log(`  图片下载网络错误: ${err.message.substring(0, 50)}`);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 批量下载图片
 * 支持三种模式：
 *   - 默认模式：图片保存到 baseDir/images/，MD 引用 images/文件名
 *   - 自定义目录模式：图片保存到 customImgDir，MD 引用文件名（前缀由调用方处理）
 *   - 外部目录模式（targetDir）：Obsidian wiki-link 格式
 *
 * @param {Array<{url: string, relPath?: string, fileName?: string, targetDir?: string}>} imageList
 * @param {string} baseDir - 图片保存根目录（默认模式的基准目录）
 * @param {string} [customImgDir] - 自定义图片目录（不为空时图片直接存到此目录）
 * @returns {Promise<Map<string, string>>} url → 本地路径映射
 */
async function downloadImages(imageList, baseDir, customImgDir) {
  const urlMap = new Map();
  if (!imageList.length) return urlMap;

  // 检测是否有外部目录模式
  const hasExternal = imageList.some(img => img.targetDir);
  const imgDir = customImgDir || (hasExternal ? null : path.join(baseDir, 'images'));
  log(`  下载 ${imageList.length} 张图片${imgDir ? '到 ' + imgDir : '（外部目录模式）'}`);

  const dlUsedNames = new Map(); // 去重
  let success = 0;
  for (let i = 0; i < imageList.length; i++) {
    const img = imageList[i];
    const { url } = img;
    if (urlMap.has(url)) continue;

    let localFullPath;
    let localRelPath;

    if (img.targetDir) {
      // 外部绝对路径模式（Obsidian wiki-link）
      let fileName = img.fileName || path.basename(url.split('?')[0]) || 'image.png';
      // 去重
      if (dlUsedNames.has(fileName)) {
        const c = dlUsedNames.get(fileName);
        dlUsedNames.set(fileName, c + 1);
        const ext = path.extname(fileName);
        fileName = `${path.basename(fileName, ext)}-${c}${ext}`;
      } else { dlUsedNames.set(fileName, 1); }
      localFullPath = path.join(img.targetDir, decodeURIComponent(fileName));
      localRelPath = null; // wiki-link 不需要 URL 替换
    } else {
      // 默认/自定义目录模式
      let fileName = 'image.png';
      try {
        const u = new URL(url);
        const baseName = path.basename(u.pathname);
        // 解码百分号编码，避免磁盘上存着 %E4%B8%89 而阅读器找的是中文名
        const decoded = decodeURIComponent(baseName);
        if (decoded && decoded.indexOf('.') > 0) fileName = decoded;
        else if (baseName && baseName.indexOf('.') > 0) fileName = baseName;
        else if (u.searchParams.get('name')) fileName = decodeURIComponent(u.searchParams.get('name'));
      } catch (_) { /* 使用默认 */ }
      // 文件名去重
      if (dlUsedNames.has(fileName)) {
        const c = dlUsedNames.get(fileName);
        dlUsedNames.set(fileName, c + 1);
        const ext = path.extname(fileName);
        fileName = `${path.basename(fileName, ext)}-${c}${ext}`;
      } else { dlUsedNames.set(fileName, 1); }
      // 自定义目录 → 引用只用文件名；默认 → images/文件名
      localRelPath = customImgDir ? fileName : `images/${fileName}`;
      localFullPath = path.join(imgDir, fileName);
    }

    const ok = await downloadFile(url, localFullPath);
    if (ok) {
      urlMap.set(url, localRelPath);
      success++;
    }

    // 控制频率
    if (i < imageList.length - 1) await new Promise(r => setTimeout(r, 100));
  }

  log(`  图片下载完成: ${success}/${imageList.length}`);
  return urlMap;
}

// ============== 核心导出逻辑 ==============

/**
 * 导出单个页面为 .md 文件
 * @param {string} pageId
 * @param {string} outputDir - 输出目录
 * @param {object} [options]
 * @param {boolean} [options.downloadImages=false] - 是否下载图片
 * @returns {Promise<{filePath: string, title: string}>}
 */
async function exportPage(pageId, outputDir, options = {}) {
  log(`  正在读取页面: ${pageId}`);

  // 获取页面信息（REST）和块列表（REST，更可靠：分页稳定、data 格式统一）
  const [pageDetail, blocks] = await Promise.all([
    (async()=>{ try { return await rest.get('/pages/' + pageId); } catch(e) { return null; } })(),
    rest.getAllBlocks(pageId),
  ]);

  // 确定标题
  let title = '(无标题)';
  if (pageDetail?.properties) {
    const t = getTitle(pageDetail.properties);
    if (t !== '(无标题)') title = t;
  }
  if (title === '(无标题)') {
    for (const b of blocks) {
      if (['heading_1', 'heading_2'].includes(b.type)) {
        const t = extractBlockText(b);
        if (t) { title = t; break; }
      }
    }
  }

  // 确定保存目录
  const saveMdDir = options.mdDir || outputDir;
  const saveImgDir = (options.downloadImages && options.imgDir) ? path.resolve(options.imgDir) : null;

  // 图片在 MD 中的引用方式：
  //   - 绝对路径（如 F:/obsidian/assets）→ Obsidian wiki-link：![[文件名.png]]
  //   - 相对路径 → 标准 Markdown：![](相对路径/文件名.png)
  let imageDir = null;
  if (saveImgDir) {
    const isAbs = /^[A-Za-z]:[/\\]/.test(saveImgDir) || saveImgDir.startsWith('/');
    if (isAbs) {
      imageDir = saveImgDir; // 绝对路径，触发 blocksToMarkdown 的 wiki-link 分支
    } else {
      imageDir = path.relative(saveMdDir, saveImgDir).replace(/\\/g, '/');
    }
  } else if (options.downloadImages) {
    imageDir = options.imageDir || 'images';
  }

  // Blocks → Markdown（展开嵌套子块如 table_row）
  const expandedBlocks = await expandNestedBlocks(blocks);
  const { md: bodyMd, imageUrls } = blocksToMarkdown(expandedBlocks, { imageDir });

  // 清洗微信剪藏混入的垃圾文字
  const cleanedBody = cleanWechatArtifacts(bodyMd);

  // 组装完整文档
  let fullMd = `# ${title}\n\n`;
  fullMd += `> ID: ${pageId}\n`;
  fullMd += `> 导出时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
  if (pageDetail?.created_time) {
    fullMd += `> 创建时间: ${formatTime(pageDetail.created_time)}\n`;
  }
  fullMd += `\n${cleanedBody}`;

  // 去重：只检查正文第一个标题是否和页面标题相同，是则删掉
  const bodyFirstLine = cleanedBody.split('\n').find(l => l.trim());
  if (bodyFirstLine) {
    const bodyHeading = bodyFirstLine.trim().match(/^#{1,3}\s+(.+)$/);
    if (bodyHeading && bodyHeading[1].trim() === title) {
      fullMd = fullMd.replace(bodyFirstLine, '').replace(/\n{3,}/g, '\n\n');
    }
  }

  // 下载图片（自定义目录或默认 images/）
  if (options.downloadImages && imageUrls.length > 0) {
    const urlMap = await downloadImages(imageUrls, outputDir, saveImgDir);
    // 替换 MD 中的图片引用为本地路径（仅对非 wiki-link 模式）
    for (const [url, localRelPath] of urlMap) {
      if (localRelPath) fullMd = fullMd.split(url).join(localRelPath);
      // wiki-link 模式（localRelPath=null）不需要替换，MD 中已经是 ![[filename]]
    }
  }

  // 写入文件
  const safeName = sanitizeFileName(title);
  const filePath = path.join(saveMdDir, `${safeName}.md`);
  fs.mkdirSync(saveMdDir, { recursive: true });
  fs.writeFileSync(filePath, fullMd, 'utf-8');

  return { filePath, title };
}

/**
 * 导出数据库记录（单条或批量）
 * @param {string} dbId
 * @param {string} outputDir
 * @param {object} [options]
 * @returns {Promise<Array<{filePath: string, title: string}>>}
 */
async function exportDatabaseRecords(dbId, outputDir, options = {}) {
  const count = options.count || (options.all ? 999999 : 1);

  log(`正在查询数据库: ${dbId}`);
  const records = await restQueryAllRecords(dbId);

  // 关键词过滤
  let filtered = records;
  if (options.keywords && options.keywords.length > 0) {
    const matched = [];
    for (const r of filtered) {
      const title = getTitle(r.properties || {}).toLowerCase();
      const inMeta = options.keywords.every(kw => title.includes(kw));
      let inBody = false;
      if (inMeta) { inBody = true; }
      else { inBody = await searchInBody(r.id, options.keywords); }
      if (inMeta || inBody) matched.push(r);
    }
    filtered = matched;
  }

  // 按 created_time 降序排序（最新在前）
  // REST API 返回顺序不可靠，必须本地排序才能确保批量下载时顺序可预测
  filtered.sort((a, b) => {
    const ta = a.created_time || a.createdTime || '';
    const tb = b.created_time || b.createdTime || '';
    return tb.localeCompare(ta);
  });
  if (filtered.length > 0) {
    log(`  已按时间降序排序: ${getTitle(filtered[0].properties)} (最新) → ${getTitle(filtered[filtered.length - 1].properties)} (最早)`);
  }

  // 截取数量
  const target = filtered.slice(0, count);
  if (target.length === 0) {
    out('\n没有找到符合条件的记录。');
    return [];
  }

  log(`将导出 ${target.length} 条记录到: ${outputDir}`);

  const results = [];
  for (let i = 0; i < target.length; i++) {
    const r = target[i];
    const title = getTitle(r.properties || {});
    log(`  [${i + 1}/${target.length}] ${title}`);

    try {
      const result = await exportPage(r.id, outputDir, {
        downloadImages: options.downloadImages,
        imageDir: options.imageDir,
      });
      results.push(result);
      out(`  ✓ ${result.filePath}`);
    } catch (e) {
      log(`  ✗ 导出失败: ${e.message.substring(0, 80)}`);
    }

    if (i < target.length - 1) await rest.sleep(200);
  }

  return results;
}

// ============== 剪藏微信文章模式 ==============

/**
 * 获取剪藏数据库的所有子页面（按 created_time 降序）
 * @returns {Promise<Array>} child_page 类型的子块列表
 */
async function getClipPages() {
  log('[1] 获取剪藏列表...');

  const allItems = await rest.getAllBlocks(CLIP_DB_ID, { pageSize: 100 });

  // 过滤 child_page 类型
  const pages = allItems.filter(item => item.type === 'child_page');

  // 按 created_time 降序排序
  pages.sort((a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0));

  log(`  剪藏总数: ${pages.length}`);
  return pages;
}

/**
 * 从剪藏页面中提取微信文章 URL
 * @param {Array} pages - 子页面列表
 * @param {number} start - 起始索引（1-based）
 * @param {number} count - 数量（0=不限）
 * @param {boolean} fetchAll - 是否扫描全部
 * @returns {Promise<Array<{title: string, url: string, pageId: string}>>}
 */
async function extractWechatArticles(pages, start, count, fetchAll) {
  const session = rest; // 用 REST 获取页面详情更快
  const articles = [];

  const scanRange = fetchAll ? pages : pages.slice(0, start + count - 1);

  log(`[2] 提取微信文章 URL（检查 ${scanRange.length} 条）...`);

  for (const item of scanRange) {
    const pid = item.id;
    try {
      const detail = await session.get(`/pages/${pid}`);
      const props = detail.properties || {};

      // 标题
      const title = getTitle(props);
      if (title === '(无标题)') continue;

      // URL（遍历属性找 url 类型且包含 mp.weixin.qq.com 的）
      let url = '';
      for (const [k, v] of Object.entries(props)) {
        if (v.type === 'url') {
          const raw = v.url || '';
          if (raw.includes('mp.weixin.qq.com')) {
            url = raw.replace('http://', 'https://');
            break;
          }
        }
      }

      if (url) {
        articles.push({ title, url, pageId: pid });
        log(`  ✓ ${title}`);
      }
    } catch (e) {
      // 获取失败时跳过
    }

    await rest.sleep(50);
  }

  // 截取范围
  let result;
  if (fetchAll) {
    result = articles;
  } else {
    result = articles.slice(start - 1, start - 1 + count);
  }

  log(`  找到 ${result.length} 篇微信文章`);
  return result;
}

/**
 * 剪藏模式主流程
 * @param {object} opts
 * @returns {Promise<number>} 成功数
 */
async function modeClip(opts) {
  const count = opts.clipAll ? 0 : (opts.count || 1);
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  const clipOutputDir = path.join(outputDir, 'wechat');

  // 1. 获取剪藏列表
  const pages = await getClipPages();
  if (pages.length === 0) {
    out('\n剪藏库为空。');
    return 0;
  }

  // 2. 提取微信文章
  const articles = await extractWechatArticles(pages, opts.clipStart, count, opts.clipAll);
  if (articles.length === 0) {
    out('\n未找到微信文章。');
    return 0;
  }

  // 3. 逐篇导出
  log(`\n[3] 开始导出到: ${clipOutputDir}`);
  out(`\n找到 ${articles.length} 篇微信文章`);
  out(`输出目录: ${clipOutputDir}\n`);

  let success = 0;
  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    log(`  [${i + 1}/${articles.length}] ${art.title}`);

    try {
      const result = await exportPage(art.pageId, clipOutputDir, {
        downloadImages: opts.downloadImages,
        imageDir: opts.imageDir,
        mdDir: opts.mdDir,
        imgDir: opts.imgDir,
      });
      out(`  ✓ ${result.filePath}`);
      success++;
    } catch (e) {
      log(`  ✗ 失败: ${e.message.substring(0, 80)}`);
    }

    await rest.sleep(200);
  }

  return success;
}

// ============== 主入口 ==============
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Token 验证（剪藏/数据库/单页模式需要 Token）
  const needsToken = opts.clipMode || opts.pageId || opts.dbId;
  if (!TOKEN && needsToken) {
    out('错误: 未设置 FLOWUS_TOKEN 环境变量');
    out('');
    out('用法:');
    out('  $env:FLOWUS_TOKEN="your_token"    (PowerShell)');
    out('  export FLOWUS_TOKEN=your_token    (Bash)');
    process.exit(1);
  }

  // 配置客户端
  rest.configure({ token: TOKEN || '' });

  // 确定输出目录
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });

  // ===== 分发到各模式 =====

  // 模式 A：--clip 剪藏模式
  if (opts.clipMode) {
    const success = await modeClip(opts);
    out(`\n${'='.repeat(50)}`);
    out(`完成: ${success} 篇成功导出`);
    out(`${'='.repeat(50)}`);
    return;
  }

  // 模式 B：--id 单页导出
  if (opts.pageId) {
    log(`导出页面: ${opts.pageId}`);
    const result = await exportPage(opts.pageId, outputDir, {
      downloadImages: opts.downloadImages,
      imageDir: opts.imageDir,
      mdDir: opts.mdDir,
      imgDir: opts.imgDir,
    });
    out(`✓ 已导出: ${result.filePath}`);
    return;
  }

  // 模式 C：--db 数据库导出（默认模式）
  const dbId = opts.dbId || DEFAULT_DB_ID;
  const results = await exportDatabaseRecords(dbId, outputDir, {
    count: opts.count,
    all: opts.all,
    keywords: opts.keywords,
    downloadImages: opts.downloadImages,
  });

  if (results.length > 0) {
    out(`\n${'='.repeat(50)}`);
    out(`导出完成: ${results.length}/${results.length} 成功`);
    out(`目录: ${outputDir}`);
    out(`${'='.repeat(50)}`);
  }
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
