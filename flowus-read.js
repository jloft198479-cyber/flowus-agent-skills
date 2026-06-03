#!/usr/bin/env node
/**
 * FlowUs 通用读取脚本 v1.0
 *
 * 基于 lib/mcp-client + lib/rest-client 共享底层，
 * 提供完整的 FlowUs 内容读取能力：
 *
 *   - 数据库记录列表 / 属性定义 / 关键词搜索（含正文）
 *   - 页面正文读取 / 原始 JSON
 *   - REST API 全局搜索
 *   - 导出为本地 .md 文件
 *
 * 用法：
 *   node flowus-read.js                          # 读取剪藏最新 1 条
 *   node flowus-read.js 5                        # 读取剪藏最新 5 条
 *   node flowus-read.js --db <id>                # 指定数据库/页面
 *   node flowus-read.js --db <id> --list         # 列出全部记录
 *   node flowus-read.js --db <id> --schema       # 查看属性定义
 *   node flowus-read.js --db <id> --keyword xxx  # 搜索（标题+属性+正文）
 *   node flowus-read.js --db <id> --index 3      # 第 3 条
 *   node flowus-read.js --id <pageId>            # 直接读页面正文
 *   node flowus-read.js --search xxx             # REST 全局搜索
 *   node flowus-read.js --id <id> --export       # 导出为 .md 文件
 *   node flowus-read.js --raw                    # 原始 JSON 输出
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const path = require('path');
const fs = require('fs');
const mcp = require('./lib/mcp-client');
const rest = require('./lib/rest-client');

// ============== 配置 ==============
/** Token 必须通过环境变量 FLOWUS_TOKEN 提供 */
const TOKEN = process.env.FLOWUS_TOKEN;
/** 默认目标数据库（可通过环境变量 FLOWUS_DEFAULT_DB 覆盖，或通过 --db 指定） */
const DEFAULT_DB_ID = process.env.FLOWUS_DEFAULT_DB || '';

// ============== 日志 ==============
/** 诊断日志 → stderr（不污染 stdout 管道数据） */
function log(msg) {
  try { process.stderr.write(msg + '\n'); } catch (_) { /* ignore */ }
}
/** 用户内容输出 → stdout（可管道、可重定向） */
function out(msg) {
  console.log(msg);
}

// ============== 参数解析 ==============
function parseArgs(argv) {
  const opts = {
    dbId: null,        // --db <id>
    pageId: null,      // --id <id>
    count: null,       // 纯数字参数 或默认 1
    list: false,       // --list
    schema: false,     // --schema
    keywords: [],      // --keyword xxx
    indexStart: null,  // --index N 或 N-M
    indexEnd: null,
    searchQuery: null, // --search xxx
    exportPath: null,  // --export [path]
    raw: false,        // --raw
    from: null,        // --from YYYY-MM-DD
    to: null,          // --to YYYY-MM-DD
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--db') {
      opts.dbId = argv[++i];
    } else if (a === '--id') {
      opts.pageId = argv[++i];
    } else if (a === '--list') {
      opts.list = true;
    } else if (a === '--schema') {
      opts.schema = true;
    } else if (a === '--keyword') {
      opts.keywords.push(...(argv[++i] || '').toLowerCase().split(/\s+/).filter(Boolean));
    } else if (a === '--index') {
      const v = argv[++i] || '';
      if (v.includes('-')) {
        const p = v.split('-').map(Number);
        opts.indexStart = p[0]; opts.indexEnd = p[1];
      } else {
        opts.indexStart = opts.indexEnd = Number(v);
      }
    } else if (a === '--search') {
      opts.searchQuery = argv[++i] || '';
    } else if (a === '--export') {
      opts.exportPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    } else if (a === '--raw') {
      opts.raw = true;
    } else if (a === '--from') {
      opts.from = argv[++i];
    } else if (a === '--to') {
      opts.to = argv[++i];
    } else if (/^\d+$/.test(a)) {
      opts.count = parseInt(a, 10);
    }
  }

  return opts;
}

// ============== 工具函数 ==============

/**
 * 从 rich_text 数组提取纯文本
 * @param {Array|null} rt
 * @returns {string}
 */
function extractRichText(rt) {
  if (!rt || !Array.isArray(rt)) return '';
  return rt.map(r => r.plain_text || r.text?.content || '').join('');
}

/**
 * 从 block 中提取文本内容（兼容 data/code 等不同字段名）
 * @param {object} block
 * @returns {string}
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
 * @param {object} props - 页面/记录的 properties 对象
 * @param {...string} names - 可能的属性名（按优先级）
 * @returns {string|null}
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
      case 'email': return String(val);
      case 'phone_number': return String(val);
      case 'checkbox': return val ? '✅' : '⬜';
      case 'people': return Array.isArray(val) ? val.map(p => p.name || p.id).join(', ') : (val?.name || null);
      case 'files': return Array.isArray(val) ? val.map(f => f.file?.name || f.file?.url || '文件').join(', ') : null;
      case 'relation': return Array.isArray(val) ? val.length + ' 条关联' : null;
      case 'created_time':
      case 'last_edited_time':
        return typeof val === 'string' ? val.substring(0, 10) : String(val);
      case 'created_by':
      case 'last_edited_by':
        return val?.name || val?.id || null;
      default: return typeof val === 'object' ? JSON.stringify(val) : String(val);
    }
  }
  return null;
}

/**
 * 获取标题属性值（自动尝试 title / 标题）
 * @param {object} props
 * @returns {string}
 */
function getTitle(props) {
  return getPropValue(props, 'title', '标题') || '(无标题)';
}

/**
 * 格式化 ISO 时间为本地可读格式
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  } catch { return iso; }
}

/** 仅日期部分 */
function formatDateShort(iso) {
  return iso ? iso.substring(0, 10) : '';
}

// ============== Block 格式化 ==============

/**
 * 将 blocks 数组格式化为 Markdown 文本
 * @param {Array} blocks
 * @returns {string}
 */
function formatBlocksToMd(blocks) {
  const lines = [];
  for (const block of blocks) {
    const text = extractBlockText(block);
    if (!text.trim()) continue;

    const type = block.type;
    const data = block[type] || block.data || {};

    switch (type) {
      case 'heading_1': lines.push(`\n# ${text}`); break;
      case 'heading_2': lines.push(`\n## ${text}`); break;
      case 'heading_3': lines.push(`\n### ${text}`); break;
      case 'divider': lines.push('\n---'); break;
      case 'bulleted_list_item': lines.push(`  - ${text}`); break;
      case 'numbered_list_item': lines.push(`  1. ${text}`); break;
      case 'code': lines.push(`\n\`\`\`${data.language || ''}\n${text}\n\`\`\``); break;
      case 'callout': lines.push(`\n> ${data.icon?.emoji || ''} ${text}`); break;
      case 'quote': lines.push(`\n> ${text}`); break;
      case 'to_do': lines.push(`  [${data.checked ? 'x' : ' '}] ${text}`); break;
      case 'image': {
        const url = data.file?.url || data.external?.url || '';
        lines.push(`\n![image](${url})`);
        break;
      }
      case 'bookmark': lines.push(`\n[${text}](${data.url || ''})`); break;
      case 'embed': lines.push(`\n[embed](${data.url || ''})`); break;
      case 'table':
      case 'table_row':
        // 表格块单独处理较复杂，这里简化输出
        break;
      default:
        lines.push(text);
    }
  }
  return lines.join('\n');
}

/**
 * 从 blocks 中提取第一个标题作为文档标题
 * @param {Array} blocks
 * @returns {string}
 */
function extractTitleFromBlocks(blocks) {
  for (const b of blocks) {
    if (['heading_1', 'heading_2'].includes(b.type)) {
      const t = extractBlockText(b);
      if (t) return t;
    }
  }
  return '';
}

// ============== REST 读取操作（替代 MCP）==============

/**
 * 通过 REST 获取页面所有子块（全量翻页）
 * @param {string} id
 * @returns {Promise<Array>}
 */
async function restGetAllBlocks(id) {
  return rest.getAllBlocks(id);
}

/**
 * 通过 REST 查询数据库记录（全量翻页）
 * @param {string} dbId
 * @returns {Promise<Array>}
 */
async function restQueryAllRecords(dbId) {
  const all = await rest.queryDatabase(dbId);
  // 按创建时间倒序
  all.sort((a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0));
  return all;
}

/**
 * 通过 REST 获取数据库信息
 * @param {string} dbId
 * @returns {Promise<object|null>}
 */
async function restGetDatabase(dbId) {
  try {
    return await rest.get('/databases/' + dbId);
  } catch (e) {
    return null;
  }
}

/**
 * 通过 REST 获取页面信息
 * @param {string} pageId
 * @returns {Promise<object|null>}
 */
async function restGetPage(pageId) {
  try {
    return await rest.get('/pages/' + pageId);
  } catch (e) {
    return null;
  }
}

// ============== 正文搜索（核心改进） ==============

/**
 * 在记录的正文内容中搜索关键词
 * 需要调用 getBlockChildren 获取正文 blocks，然后在其中搜索
 *
 * @param {string} pageId - 记录 ID
 * @param {string[]} keywords - 小写关键词数组
 * @returns {Promise<boolean>} 是否匹配
 */
async function searchInBody(pageId, keywords) {
  if (!keywords.length) return false;

  try {
    const blocks = await restGetAllBlocks(pageId);
    // 将所有块的文本拼接成一个字符串用于搜索
    const fullText = blocks.map(extractBlockText).join(' ').toLowerCase();

    return keywords.every(kw => fullText.includes(kw));
  } catch (e) {
    // 正文获取失败时跳过正文搜索，不阻止结果返回
    return false;
  }
}

// ============== 导出工具 ==============

/**
 * 将内容写入 .md 文件并返回路径
 * @param {string} content - Markdown 内容
 * @param {string} prefix - 文件名前缀
 * @param {string} [customPath] - 自定义路径
 * @returns {string} 写入的文件路径
 */
function exportToFile(content, prefix, customPath) {
  let filePath;
  if (customPath && customPath.endsWith('.md')) {
    filePath = path.resolve(customPath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  } else if (customPath) {
    try {
      if (fs.statSync(customPath).isDirectory()) {
        filePath = path.join(customPath, `${prefix}-${Date.now()}.md`);
      } else {
        // 路径存在但不是目录，当作文件名处理
        filePath = customPath.endsWith('.md') ? customPath : `${customPath}.md`;
      }
    } catch (e) {
      // 路径不存在，创建为 .md 文件
      filePath = customPath.endsWith('.md') ? customPath : `${customPath}.md`;
    }
  } else {
    const tmpDir = process.env.TEMP || '/tmp';
    filePath = path.join(tmpDir, `${prefix}-${Date.now()}.md`);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ============== 各模式实现 ==============

/**
 * 模式 A：--id 直接读取页面正文
 */
async function modeReadPage(opts) {
  const pageId = opts.pageId;

  if (!opts.raw) log(`正在读取页面: ${pageId}`);

  // 并行获取属性和正文
  const [pageDetail, blocks] = await Promise.all([
    restGetPage(pageId),
    restGetAllBlocks(pageId),
  ]);

  // 确定标题
  let title = '(无标题)';
  if (pageDetail?.properties) {
    const t = getTitle(pageDetail.properties);
    if (t !== '(无标题)') title = t;
  }
  if (title === '(无标题)') {
    const heading = extractTitleFromBlocks(blocks);
    if (heading) title = heading;
  }

  if (opts.raw) {
    const output = { page_id: pageId, title, properties: pageDetail?.properties || {}, blocks };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const formatted = formatBlocksToMd(blocks);
  const mdContent = `# ${title}\n\n> ID: ${pageId}\n> 时间: ${formatTime(pageDetail?.created_time)}\n\n${formatted}`;

  if (opts.exportPath !== null) {
    const fp = exportToFile(mdContent, `flowus-page-${pageId.substring(0, 8)}`, opts.exportPath);
    out(`\n📄 已导出: ${fp}`);
    out(mdContent);
  } else {
    out(mdContent);
    const fp = exportToFile(mdContent, `flowus-page-${pageId.substring(0, 8)}`);
    out(`\n📄 已保存: ${fp}`);
  }
}

/**
 * 模式 B：--schema 查看数据库属性定义
 */
async function modeSchema(dbId, opts) {
  if (!opts.raw) log(`正在获取数据库属性定义: ${dbId}`);

  const dbInfo = await restGetDatabase(dbId);
  if (!dbInfo) {
    out('目标不是数据库，无法查看属性定义。');
    return;
  }

  const props = dbInfo.properties || {};

  if (opts.raw) {
    console.log(JSON.stringify(props, null, 2));
    return;
  }

  out(`\n📋 数据库: ${extractRichText(dbInfo.title) || dbId}`);
  out(`   ID: ${dbId}`);
  out(`\n属性定义 (${Object.keys(props).length} 个):\n`);

  for (const [key, val] of Object.entries(props)) {
    let extra = '';
    if ((val.type === 'select' || val.type === 'multi_select') && val[val.type]?.options) {
      extra = ` [${val[val.type].options.map(o => o.name).join(', ')}]`;
    }
    out(`  • ${key} (${val.type}${extra})`);
  }
}

/**
 * 模式 C：--list 列出数据库全部记录
 */
async function modeList(dbId, opts) {
  if (!opts.raw) log(`正在查询数据库记录...`);

  const records = await restQueryAllRecords(dbId);
  const dbInfo = await restGetDatabase(dbId);
  const props = dbInfo?.properties || {};

  // 应用过滤
  let filtered = records;

  // 关键词过滤（标题+属性+正文）
  if (opts.keywords.length > 0) {
    const matched = [];
    for (const r of filtered) {
      const title = getTitle(r.properties || {}).toLowerCase();
      // 搜所有非系统属性的文本值
      const attrTexts = Object.entries(r.properties || {})
        .filter(([k, v]) => !['title','created_time','created_by','last_edited_time','last_edited_by'].includes(v?.type))
        .map(([, v]) => getPropValue(r.properties, Object.keys(r.properties).find(k => r.properties[k] === v)) || '')
        .join(' ').toLowerCase();
      const inMeta = opts.keywords.every(kw => title.includes(kw) || attrTexts.includes(kw));

      // 搜正文（新增能力）
      let inBody = false;
      if (inMeta) {
        inBody = true; // 元数据已匹配，无需再搜正文
      } else {
        inBody = await searchInBody(r.id, opts.keywords);
      }

      if (inMeta || inBody) matched.push(r);
    }
    filtered = matched;
  }

  // 索引过滤
  if (opts.indexStart !== null) {
    filtered = filtered.filter((_, i) => i >= opts.indexStart - 1 && i <= opts.indexEnd - 1);
  }

  // 日期过滤
  if (opts.from) {
    const ts = new Date(opts.from + 'T00:00:00+08:00').getTime();
    filtered = filtered.filter(r => new Date(r.created_time || 0).getTime() >= ts);
  }
  if (opts.to) {
    const ts = new Date(opts.to + 'T23:59:59+08:00').getTime();
    filtered = filtered.filter(r => new Date(r.created_time || 0).getTime() <= ts);
  }

  if (opts.raw) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  out(`\n共 ${filtered.length} 条记录:\n`);

  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    const title = getTitle(r.properties || {});
    const time = formatDateShort(r.created_time);

    // 动态展示非系统属性
    const extras = [];
    for (const [k, v] of Object.entries(props)) {
      if (['title', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by'].includes(v.type)) continue;
      const val = getPropValue(r.properties, k);
      if (val != null) extras.push(`${k}: ${val}`);
    }

    const parts = [`  ${i + 1}. ${title}`];
    if (extras.length > 0) parts.push(` | ${extras.join(' | ')}`);
    if (time) parts.push(` [${time}]`);
    out(parts.join(''));
  }
}

/**
 * 模式 D：通读模式 — 读取数据库记录的完整正文
 */
async function modeReadRecords(dbId, opts) {
  const count = opts.count || 1;

  if (!opts.raw) log(`正在查询数据库记录（取 ${count} 条）...`);

  const records = await restQueryAllRecords(dbId);

  // 应用与 modeList 相同的过滤逻辑
  let filtered = records;

  if (opts.keywords.length > 0) {
    const matched = [];
    for (const r of filtered) {
      const title = getTitle(r.properties || {}).toLowerCase();
      const attrTexts = Object.entries(r.properties || {})
        .filter(([k, v]) => !['title','created_time','created_by','last_edited_time','last_edited_by'].includes(v?.type))
        .map(([, v]) => getPropValue(r.properties, Object.keys(r.properties).find(k2 => r.properties[k2] === v)) || '')
        .join(' ').toLowerCase();
      const inMeta = opts.keywords.every(kw => title.includes(kw) || attrTexts.includes(kw));

      let inBody = false;
      if (inMeta) { inBody = true; }
      else { inBody = await searchInBody(r.id, opts.keywords); }

      if (inMeta || inBody) matched.push(r);
    }
    filtered = matched;
  }

  if (opts.indexStart !== null) {
    filtered = filtered.filter((_, i) => i >= opts.indexStart - 1 && i <= opts.indexEnd - 1);
  }

  // 截取指定数量
  const target = filtered.slice(0, count);

  if (target.length === 0) {
    out('\n没有找到符合条件的记录。');
    return;
  }

  if (opts.raw) {
    console.log(JSON.stringify(target, null, 2));
    return;
  }

  const dbInfo = await restGetDatabase(dbId);
  const dbProps = dbInfo?.properties || {};

  const outputParts = [];

  for (let i = 0; i < target.length; i++) {
    const r = target[i];
    const title = getTitle(r.properties || {});
    const time = formatTime(r.created_time);

    outputParts.push(`${'='.repeat(60)}`);
    outputParts.push(`📌 [${i + 1}/${target.length}] ${title}`);
    outputParts.push(`🕐 ${time}`);
    outputParts.push(`📄 ID: ${r.id}`);

    // 非系统属性
    for (const [k, v] of Object.entries(dbProps)) {
      if (['title', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by'].includes(v.type)) continue;
      const val = getPropValue(r.properties, k);
      if (val != null) outputParts.push(`   ${k}: ${val}`);
    }

    // 正文
    try {
      const blocks = await restGetAllBlocks(r.id);
      if (blocks.length > 0) {
        outputParts.push(`\n${formatBlocksToMd(blocks)}`);
      }
    } catch (e) {
      outputParts.push(`\n(正文读取失败: ${e.message.substring(0, 60)})`);
    }

    if (i < target.length - 1) await rest.sleep(200);
  }

  outputParts.push(`\n${'='.repeat(60)}`);
  outputParts.push('✅ 完成');

  const fullText = outputParts.join('\n');
  out(fullText);

  // 自动保存
  const fp = exportToFile(fullText, 'flowus-read', opts.exportPath);
  out(`\n📄 已保存: ${fp}`);
}

/**
 * 模式 E：--search REST 全局搜索
 */
async function modeSearch(query, opts) {
  if (!query) { out('请提供搜索关键词: --search "关键词"'); return; }

  if (!opts.raw) log(`正在全局搜索: "${query}"`);

  try {
    const results = await rest.search(query, { pageSize: 20 });

    if (opts.raw) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      out(`\n未找到与 "${query}" 相关的内容。`);
      return;
    }

    out(`\n找到 ${results.length} 条结果:\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const title = getTitle(r.properties || {});
      const objType = r.object || 'unknown';
      const parentType = r.parent?.type || '?';

      let parentInfo = '';
      if (parentType === 'database_id') parentInfo = ` | 数据库: ${r.parent.database_id?.substring(0, 8)}...`;
      else if (parentType === 'space_id') parentInfo = ' | 工作区根目录';
      else if (parentType === 'page_id') parentInfo = ` | 父页: ${r.parent.page_id?.substring(0, 8)}...`;

      out(`  ${i + 1}. [${objType}] ${title}`);
      out(`     ID: ${r.id}`);
      out(`     更新: ${formatTime(r.last_edited_time)}${parentInfo}`);

      if (i < results.length - 1) out('');
    }
  } catch (e) {
    out(`搜索失败: ${e.message}`);
  }
}

// ============== 主入口 ==============
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Token 验证
  if (!TOKEN) {
    out('错误: 未设置 FLOWUS_TOKEN 环境变量');
    out('');
    out('用法:');
    out('  set FLOWUS_TOKEN=your_token_here    (Windows CMD)');
    out('  $env:FLOWUS_TOKEN="your_token"       (PowerShell)');
    out('  export FLOWUS_TOKEN=your_token       (Bash/Zsh)');
    process.exit(1);
  }

  // 配置客户端（纯 REST，不再依赖 MCP）
  rest.configure({ token: TOKEN });

  // ===== 分发到各模式 =====

  // 模式 A：--id 直接读页面
  if (opts.pageId) {
    await modeReadPage(opts);
    return;
  }

  // 模式 E：--search 全局搜索
  if (opts.searchQuery !== null) {
    await modeSearch(opts.searchQuery, opts);
    return;
  }

  // 确定目标数据库
  const dbId = opts.dbId || DEFAULT_DB_ID;
  const sourceLabel = opts.dbId ? '指定数据库' : '剪藏数据库';

  // 模式 B：--schema
  if (opts.schema) {
    await modeSchema(dbId, opts);
    return;
  }

  // 模式 C：--list 或有过滤条件
  if (opts.list || opts.keywords.length > 0 || opts.indexStart !== null || opts.from || opts.to) {
    await modeList(dbId, opts);
    return;
  }

  // 模式 D：通读模式（默认）
  await modeReadRecords(dbId, opts);
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
