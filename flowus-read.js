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
/**
 * Token 解析优先级（从高到低）：
 *   1. --token <xxx> 命令行参数（Agent 显式传入）
 *   2. FLOWUS_TOKEN 环境变量（手动终端测试）
 *   3. 当前工作目录下 .env 文件（Agent 首次授权后缓存）
 */
function _resolveToken(cliToken) {
  if (cliToken) return cliToken;
  if (process.env.FLOWUS_TOKEN) return process.env.FLOWUS_TOKEN;
  // 从 .env 读取：优先工作目录，回退到脚本自身目录
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '.env'),
  ];
  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/^FLOWUS_TOKEN\s*=\s*(.+)$/m);
      if (m) return m[1].trim();
    } catch (_) { /* .env 不存在则忽略 */ }
  }
  return null;
}
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

// ============== 帮助信息 ==============
const HELP_TEXT = `
FlowUs 读取脚本 v1.0

用法:
  node flowus-read.js                          # 读取剪藏最新 1 条
  node flowus-read.js 5                        # 读取剪藏最新 5 条
  node flowus-read.js --db <id>                # 指定数据库
  node flowus-read.js --db <id> --list         # 列出全部记录
  node flowus-read.js --db <id> --schema       # 查看属性定义
  node flowus-read.js --db <id> --keyword xxx  # 搜索（标题+属性+正文）
  node flowus-read.js --db <id> --index 3      # 第 3 条
  node flowus-read.js --id <pageId>            # 直接读页面正文
  node flowus-read.js --search xxx             # REST 全局搜索
  node flowus-read.js --semantic "查询"         # 语义搜索
  node flowus-read.js --id <id> --export       # 导出为 .md 文件
  node flowus-read.js --raw                    # 原始 JSON 输出

参数:
  --db <id>           目标数据库 ID（或设置 FLOWUS_DEFAULT_DB 环境变量）
  --id <id>           页面 ID（直接读取正文）
  --token <token>     FlowUs 授权 token
  --list              列出记录（不读正文）
  --schema            查看数据库属性定义
  --keyword <词>      数据库内搜索（可多次使用）
  --index <N>         指定第 N 条（或 N-M 范围）
  --search <词>       全局搜索
  --search-filter <t> 搜索类型: page/database/folder/mind_map
  --semantic <查询>    语义搜索（自然语言）
  --filter <json>     服务端过滤条件
  --sort <字段:方向>   服务端排序（如 "创建时间:desc" 或 "created_time:asc"，支持 asc/desc 缩写）
  --from <日期>       起始日期过滤
  --to <日期>         结束日期过滤
  --export [path]     导出为 .md 文件
  --raw               输出原始 JSON
  --help              显示此帮助信息
`;

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
    searchFilter: null, // --search-filter page|database|folder|mind_map
    semanticQuery: null, // --semantic xxx
    exportPath: null,  // --export [path]
    raw: false,        // --raw
    from: null,        // --from YYYY-MM-DD
    to: null,          // --to YYYY-MM-DD
    filterJson: null,  // --filter '{"property":"Status","select":{"equals":"Doing"}}'
    sortStr: null,     // --sort "Status:ascending"
    token: null,       // --token <授权码>
    help: false,       // --help
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--db') {
      opts.dbId = argv[++i];
    } else if (a === '--token') {
      opts.token = argv[++i] || '';
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
    } else if (a === '--search-filter') {
      opts.searchFilter = argv[++i] || null;
    } else if (a === '--semantic') {
      opts.semanticQuery = argv[++i] || '';
    } else if (a === '--export') {
      opts.exportPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    } else if (a === '--raw') {
      opts.raw = true;
    } else if (a === '--from') {
      opts.from = argv[++i];
    } else if (a === '--to') {
      opts.to = argv[++i];
    } else if (a === '--filter') {
      opts.filterJson = argv[++i] || null;
    } else if (a === '--sort') {
      opts.sortStr = argv[++i] || null;
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
      case 'date': {
        if (!val) return null;
        const s = val.start || '';
        const e = val.end || '';
        if (s && e) return `${s} ~ ${e}`;
        return s || String(val);
      }
      case 'url': return String(val);
      case 'email': return String(val);
      case 'phone_number': return String(val);
      case 'checkbox': return val ? '✅' : '⬜';
      case 'people': return Array.isArray(val) ? val.map(p => p.name || p.id).join(', ') : (val?.name || null);
      case 'files': return Array.isArray(val) ? val.map(f => f.file?.name || f.file?.url || '文件').join(', ') : null;
      case 'relation': return Array.isArray(val) ? val.length + ' 条关联' : null;
      case 'formula': return val?.string || val?.number != null ? String(val?.number ?? val?.string ?? '') : null;
      case 'rollup': return Array.isArray(val?.array) ? val.array.length + ' 项' : null;
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
 * 支持 table/table_row 嵌套结构（需先调用 expandNestedBlocks 展开）
 * @param {Array} blocks
 * @returns {string}
 */
function formatBlocksToMd(blocks) {
  const lines = [];
  let tableWidth = 0; // 当前表格列数（table 块设置，table_row 使用）

  for (const block of blocks) {
    const type = block.type;
    const data = block[type] || block.data || {};

    switch (type) {
      case 'heading_1': lines.push(`\n# ${extractBlockText(block)}`); break;
      case 'heading_2': lines.push(`\n## ${extractBlockText(block)}`); break;
      case 'heading_3': lines.push(`\n### ${extractBlockText(block)}`); break;
      case 'divider': lines.push('\n---'); break;
      case 'bulleted_list_item': lines.push(`  - ${extractBlockText(block)}`); break;
      case 'numbered_list_item': lines.push(`  1. ${extractBlockText(block)}`); break;
      case 'code': lines.push(`\n\`\`\`${data.language || ''}\n${extractBlockText(block)}\n\`\`\``); break;
      case 'callout': lines.push(`\n> ${data.icon?.emoji || ''} ${extractBlockText(block)}`); break;
      case 'quote': lines.push(`\n> ${extractBlockText(block)}`); break;
      case 'to_do': lines.push(`  [${data.checked ? 'x' : ' '}] ${extractBlockText(block)}`); break;
      case 'image': {
        const url = data.file?.url || data.external?.url || '';
        const caption = extractRichText(data.caption);
        lines.push(`\n![${caption || 'image'}](${url})`);
        break;
      }
      case 'bookmark': {
        const caption = extractRichText(data.caption);
        lines.push(`\n[${caption || extractBlockText(block)}](${data.url || ''})`);
        break;
      }
      case 'embed': {
        const caption = extractRichText(data.caption);
        lines.push(`\n[embed${caption ? ': ' + caption : ''}](${data.url || ''})`);
        break;
      }
      case 'equation': {
        const expr = data.expression || '';
        if (expr) lines.push(`\n$$\n${expr}\n$$`);
        break;
      }
      case 'link_to_page': {
        const pid = data.page_id || data.database_id || '';
        const label = data.database_id ? '数据库引用' : '页面引用';
        lines.push(`\n[${label}](${pid})`);
        break;
      }
      case 'table':
        tableWidth = data.table_width || 0;
        break;
      case 'table_row':
        if (data.cells && Array.isArray(data.cells)) {
          const rowStr = data.cells.map(cell =>
            extractRichText(cell).replace(/\|/g, '\\|').trim()
          ).join(' | ');
          lines.push(`| ${rowStr} |`);
          // 首行（上一行不是表格行）后插入分隔线
          const prevLine = lines.length >= 2 ? lines[lines.length - 2] : '';
          if (prevLine && !prevLine.startsWith('|')) {
            const colCount = data.cells.length;
            lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');
          }
        }
        break;
      case 'toggle': {
        const summary = extractBlockText(block) || '(折叠内容)';
        lines.push(`<details>\n<summary>${summary}</summary>`);
        lines.push(`\n</details>`);
        break;
      }
      case 'column_list':
      case 'column':
        // 分栏布局容器/列，子块已通过 expandNestedBlocks 展开
        break;
      case 'child_page':
        // 子页面引用，跳过
        break;
      default: {
        const text = extractBlockText(block);
        if (text.trim()) lines.push(text);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 从 Markdown 文本中提取第一个标题（# 或 ## 开头）
 * FlowUs 剪藏页面的 properties 通常没有 title，真实标题在正文的 heading 中
 * @param {string} md - Markdown 文本
 * @returns {string} 提取到的标题，空字符串表示未找到
 */
function extractTitleFromMd(md) {
  if (!md) return '';
  const m = md.match(/^#{1,2}\s+(.+)$/m);
  return m ? m[1].trim() : '';
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
 * 展开嵌套子块（递归），扁平化插入
 * 对 has_children=true 的块（如 table、toggle、callout），获取其子块并插入到该块后面
 * @param {Array} blocks - 顶层块列表
 * @returns {Promise<Array>} 扁平化后的块列表
 */
async function expandNestedBlocks(blocks) {
  const needExpand = blocks.filter(b => b.has_children && !b.children?.length);
  if (needExpand.length === 0) return blocks;

  log(`  展开 ${needExpand.length} 个嵌套块...`);
  const result = [...blocks];

  for (let i = 0; i < result.length; i++) {
    const b = result[i];
    if (!b.has_children || b.children?.length) continue;

    try {
      const children = await rest.getAllBlocks(b.id);
      b.children = children;
      if (children.length > 0) {
        result.splice(i + 1, 0, ...children);
        // 不跳过子块，让循环继续检查子块是否也需要展开
      }
    } catch (e) {
      log(`    展开 ${b.type}(${b.id}) 失败: ${e.message.substring(0, 60)}`);
      b.children = [];
    }
    await rest.sleep(50);
  }
  return result;
}

/**
 * 通过 REST 查询数据库记录（全量翻页，支持服务端过滤和排序）
 *
 * 官方文档：POST /v2/databases/:database_id/query
 * - sorts 支持按属性或时间戳排序，服务端直接返回排序结果
 * - 有 sorts 时不再客户端二次排序（服务端已排好序）
 * - 无 sorts 时按创建时间倒序（客户端排序，保持向后兼容）
 *
 * @param {string} dbId
 * @param {object} [filterBody] - 查询过滤条件（含 filter/sorts/after_created_at 等）
 * @returns {Promise<Array>}
 */
async function restQueryAllRecords(dbId, filterBody) {
  const all = await rest.queryDatabase(dbId, filterBody);
  // 仅在无服务端 sorts 时，客户端按创建时间倒序（保持向后兼容）
  if (!filterBody?.sorts) {
    all.sort((a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0));
  }
  return all;
}

/**
 * 英文属性名 → 中文属性名映射
 * FlowUs 数据库属性名可能是中文，但用户/Agent 更习惯用英文
 * 官方文档：sorts 支持 property（属性名）和 timestamp（created_time/last_edited_time）
 */
const SORT_ALIAS_MAP = {
  created_time: '创建时间',
  last_edited_time: '最后编辑时间',
  created_by: '创建人',
  last_edited_by: '最后编辑人',
  title: '标题',
  name: '标题',
  status: '状态',
  date: '日期',
  tag: '标签',
  url: '链接',
};

/**
 * 解析 --sort 字符串为 sorts 数组
 * 格式: "PropertyName:ascending" 或 "PropertyName:descending"
 * 支持英文别名：created_time → 创建时间, last_edited_time → 最后编辑时间
 * 支持缩写：asc/desc
 *
 * 官方文档：sorts 中每个排序项包含 property 和 direction，
 * 也支持 timestamp 排序（created_time / last_edited_time）
 *
 * @param {string} sortStr
 * @param {object} [dbProps] - 数据库属性 schema（用于自动映射英文名到中文名）
 * @returns {Array}
 */
function parseSortStr(sortStr, dbProps) {
  if (!sortStr) return undefined;
  const parts = sortStr.split(',');
  return parts.map(p => {
    let [property, direction] = p.trim().split(':');
    direction = (direction || 'ascending').trim().toLowerCase();
    // 缩写支持
    if (direction === 'asc') direction = 'ascending';
    if (direction === 'desc') direction = 'descending';

    property = property.trim();

    // 1. 先查别名映射
    const mapped = SORT_ALIAS_MAP[property.toLowerCase()];
    if (mapped) {
      // created_time / last_edited_time 是 timestamp 排序，不是 property 排序
      if (property.toLowerCase() === 'created_time' || property.toLowerCase() === 'last_edited_time') {
        return { timestamp: property.toLowerCase(), direction };
      }
      return { property: mapped, direction };
    }

    // 2. 如果传入了 dbProps，尝试在 schema 中查找匹配的属性名
    if (dbProps) {
      for (const [key, val] of Object.entries(dbProps)) {
        if (key.toLowerCase() === property.toLowerCase()) {
          return { property: key, direction };
        }
        // 按 type 匹配：如果用户传的是 type 名（如 "title"），找到对应的属性名
        if (val.type && val.type.toLowerCase() === property.toLowerCase()) {
          return { property: key, direction };
        }
      }
    }

    // 3. 原样传递（用户可能直接传了中文属性名）
    return { property, direction };
  });
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
 *
 * 优化策略（基于官方文档）：
 * 1. 优先使用 Markdown API（GET /v2/pages/:id/content/markdown），一次请求拿到完整正文
 * 2. 标题从 markdown 内容中提取（FlowUs 剪藏页面的 properties 通常没有 title）
 * 3. 仅在 Markdown API 失败时，才 fallback 到 getPage + getAllBlocks（3 次 API 调用）
 * 4. 仅在需要 created_time 且 getPage 未被调用时，才额外请求页面属性
 */
async function modeReadPage(opts) {
  const pageId = opts.pageId;

  if (!opts.raw) log(`正在读取页面: ${pageId}`);

  if (opts.raw) {
    // raw 模式：需要完整 blocks 数据，走传统路径
    const pageDetail = await restGetPage(pageId);
    const blocks = await restGetAllBlocks(pageId);
    const title = pageDetail?.properties ? getTitle(pageDetail.properties) : '(无标题)';
    const output = { page_id: pageId, title, properties: pageDetail?.properties || {}, blocks };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // 优先使用 Markdown API（一次请求获取正文）
  let formatted = '';
  let title = '(无标题)';
  let createdTime = '';

  try {
    const mdResult = await rest.getPageMarkdown(pageId);
    if (mdResult?.markdown) {
      formatted = mdResult.markdown;
      log('  使用 Markdown API 读取成功');

      // 从 markdown 内容提取标题（剪藏页面 properties 通常无 title，真实标题在正文 heading 中）
      const mdTitle = extractTitleFromMd(formatted);
      if (mdTitle) title = mdTitle;

      // 从 Markdown API 响应中获取 last_edited_time（无 created_time，需额外请求）
      if (opts.exportPath !== null || !formatted) {
        // 导出模式需要 created_time
        const pageDetail = await restGetPage(pageId);
        createdTime = formatTime(pageDetail?.created_time);
      }
    }
  } catch (e) {
    log(`  Markdown API 不可用，fallback 到块读取: ${e.message.substring(0, 60)}`);
  }

  // Fallback：手动块转换
  if (!formatted) {
    const pageDetail = await restGetPage(pageId);
    createdTime = formatTime(pageDetail?.created_time);

    if (pageDetail?.properties) {
      const t = getTitle(pageDetail.properties);
      if (t !== '(无标题)') title = t;
    }

    const blocks = await restGetAllBlocks(pageId);
    const expandedBlocks = await expandNestedBlocks(blocks);

    // 块模式也尝试从正文提取标题
    if (title === '(无标题)') {
      const heading = extractTitleFromBlocks(expandedBlocks);
      if (heading) title = heading;
    }

    formatted = formatBlocksToMd(expandedBlocks);
  }

  // 如果仍无 created_time，请求一次页面属性
  if (!createdTime) {
    const pageDetail = await restGetPage(pageId);
    createdTime = formatTime(pageDetail?.created_time);
  }

  const mdContent = `# ${title}\n\n> ID: ${pageId}\n> 时间: ${createdTime}\n\n${formatted}`;

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

  // 先获取 dbInfo（用于 sort 属性名映射和属性展示）
  const dbInfo = await restGetDatabase(dbId);
  const props = dbInfo?.properties || {};

  // 构建 filterBody：将 --from/--filter/--sort 转为服务端参数
  const filterBody = {};
  if (opts.from) {
    const ts = Math.floor(new Date(opts.from + 'T00:00:00+08:00').getTime() / 1000);
    filterBody.after_created_at = ts;
  }
  if (opts.filterJson) {
    try {
      filterBody.filter = JSON.parse(opts.filterJson);
    } catch (e) {
      out(`--filter JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
  }
  if (opts.sortStr) {
    filterBody.sorts = parseSortStr(opts.sortStr, props);
  }

  const records = await restQueryAllRecords(dbId, Object.keys(filterBody).length > 0 ? filterBody : undefined);

  // 应用过滤
  let filtered = records;

  // 关键词过滤（标题+属性+正文）
  if (opts.keywords.length > 0) {
    // 优先用 search API 获取匹配的页面 ID 集合，避免逐条搜正文
    let searchMatchIds = null;
    try {
      const query = opts.keywords.join(' ');
      const searchResults = await rest.search(query, { pageSize: 100 });
      searchMatchIds = new Set(searchResults.map(r => r.id));
      log(`  search API 匹配 ${searchMatchIds.size} 条`);
    } catch (e) {
      log(`  search API 失败，fallback 到逐条搜正文: ${e.message.substring(0, 60)}`);
    }

    const matched = [];
    for (const r of filtered) {
      const title = getTitle(r.properties || {}).toLowerCase();
      // 搜所有非系统属性的文本值
      const attrTexts = Object.entries(r.properties || {})
        .filter(([k, v]) => !['title','created_time','created_by','last_edited_time','last_edited_by'].includes(v?.type))
        .map(([, v]) => getPropValue(r.properties, Object.keys(r.properties).find(k => r.properties[k] === v)) || '')
        .join(' ').toLowerCase();
      const inMeta = opts.keywords.every(kw => title.includes(kw) || attrTexts.includes(kw));

      if (inMeta) {
        matched.push(r);
        continue;
      }

      // search API 有结果时，用 ID 集合判断是否匹配正文
      if (searchMatchIds !== null) {
        if (searchMatchIds.has(r.id)) matched.push(r);
      } else {
        // fallback：逐条搜正文
        const inBody = await searchInBody(r.id, opts.keywords);
        if (inBody) matched.push(r);
      }
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
 *
 * 优化策略（基于官方文档）：
 * 1. 先获取 dbInfo（用于 sort 属性名映射），再构建 filterBody
 * 2. 支持 --sort 直接通读（如 --sort created_time:asc 3），一步完成排序+正文读取
 * 3. 标题从正文 markdown 中提取 fallback（剪藏页面 properties 通常无 title）
 * 4. 正文优先使用 Markdown API（一次请求），失败 fallback 到块读取
 */
async function modeReadRecords(dbId, opts) {
  const count = opts.count || 1;

  if (!opts.raw) log(`正在查询数据库记录（取 ${count} 条）...`);

  // 先获取 dbInfo（用于 sort 属性名映射和属性展示）
  const dbInfo = await restGetDatabase(dbId);
  const dbProps = dbInfo?.properties || {};

  // 构建 filterBody：将 --from/--filter/--sort 转为服务端参数
  const filterBody = {};
  if (opts.from) {
    const ts = Math.floor(new Date(opts.from + 'T00:00:00+08:00').getTime() / 1000);
    filterBody.after_created_at = ts;
  }
  if (opts.filterJson) {
    try {
      filterBody.filter = JSON.parse(opts.filterJson);
    } catch (e) {
      out(`--filter JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
  }
  if (opts.sortStr) {
    filterBody.sorts = parseSortStr(opts.sortStr, dbProps);
  }

  const records = await restQueryAllRecords(dbId, Object.keys(filterBody).length > 0 ? filterBody : undefined);

  // 应用与 modeList 相同的过滤逻辑
  let filtered = records;

  if (opts.keywords.length > 0) {
    // 优先用 search API 获取匹配的页面 ID 集合
    let searchMatchIds = null;
    try {
      const query = opts.keywords.join(' ');
      const searchResults = await rest.search(query, { pageSize: 100 });
      searchMatchIds = new Set(searchResults.map(r => r.id));
      log(`  search API 匹配 ${searchMatchIds.size} 条`);
    } catch (e) {
      log(`  search API 失败，fallback 到逐条搜正文: ${e.message.substring(0, 60)}`);
    }

    const matched = [];
    for (const r of filtered) {
      const title = getTitle(r.properties || {}).toLowerCase();
      const attrTexts = Object.entries(r.properties || {})
        .filter(([k, v]) => !['title','created_time','created_by','last_edited_time','last_edited_by'].includes(v?.type))
        .map(([, v]) => getPropValue(r.properties, Object.keys(r.properties).find(k2 => r.properties[k2] === v)) || '')
        .join(' ').toLowerCase();
      const inMeta = opts.keywords.every(kw => title.includes(kw) || attrTexts.includes(kw));

      if (inMeta) { matched.push(r); continue; }

      if (searchMatchIds !== null) {
        if (searchMatchIds.has(r.id)) matched.push(r);
      } else {
        const inBody = await searchInBody(r.id, opts.keywords);
        if (inBody) matched.push(r);
      }
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

  const outputParts = [];

  for (let i = 0; i < target.length; i++) {
    const r = target[i];
    let title = getTitle(r.properties || {});
    const time = formatTime(r.created_time);

    // 正文（优先使用 Markdown API，失败 fallback 到手动块转换）
    // 先读正文，以便从中提取标题 fallback
    let formatted = '';
    try {
      try {
        const mdResult = await rest.getPageMarkdown(r.id);
        if (mdResult?.markdown) {
          formatted = mdResult.markdown;

          // 从 markdown 内容提取标题 fallback
          if (title === '(无标题)') {
            const mdTitle = extractTitleFromMd(formatted);
            if (mdTitle) title = mdTitle;
          }
        }
      } catch (_) {
        // Markdown API 不可用，fallback
      }
      if (!formatted) {
        const blocks = await restGetAllBlocks(r.id);
        const expandedBlocks = await expandNestedBlocks(blocks);

        // 块模式也尝试从正文提取标题
        if (title === '(无标题)') {
          const heading = extractTitleFromBlocks(expandedBlocks);
          if (heading) title = heading;
        }

        if (expandedBlocks.length > 0) {
          formatted = formatBlocksToMd(expandedBlocks);
        }
      }
    } catch (e) {
      formatted = `(正文读取失败: ${e.message.substring(0, 60)})`;
    }

    // 标题已确定，输出元数据
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

    if (formatted) outputParts.push(`\n${formatted}`);

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
    const searchOpts = { pageSize: 20 };
    if (opts.searchFilter) {
      searchOpts.filter = { property: 'object', value: opts.searchFilter };
    }
    const results = await rest.search(query, searchOpts);

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
      const pageType = r.page_type || '';
      const parentType = r.parent?.type || '?';

      let parentInfo = '';
      if (parentType === 'database_id') parentInfo = ` | 数据库: ${r.parent.database_id?.substring(0, 8)}...`;
      else if (parentType === 'space_id') parentInfo = ' | 工作区根目录';
      else if (parentType === 'page_id') parentInfo = ` | 父页: ${r.parent.page_id?.substring(0, 8)}...`;

      const typeTag = pageType ? `[${objType}/${pageType}]` : `[${objType}]`;
      out(`  ${i + 1}. ${typeTag} ${title}`);
      out(`     ID: ${r.id}`);
      out(`     更新: ${formatTime(r.last_edited_time)}${parentInfo}`);

      if (i < results.length - 1) out('');
    }
  } catch (e) {
    out(`搜索失败: ${e.message}`);
  }
}

/**
 * 模式 E2：--semantic 语义搜索（自然语言向量检索）
 */
async function modeSemantic(query, opts) {
  if (!query) { out('请提供语义搜索内容: --semantic "自然语言查询"'); return; }

  if (!opts.raw) log(`正在语义搜索: "${query}"`);

  try {
    const results = await rest.semanticSearch(query, {
      pageSize: 10,
      scoreThreshold: 0.3,
    });

    if (opts.raw) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      out(`\n未找到与 "${query}" 语义相关的内容。`);
      return;
    }

    out(`\n找到 ${results.length} 条语义匹配结果:\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const score = r.score != null ? (r.score * 100).toFixed(1) + '%' : '?';
      const snippet = r.snippet || '(无摘要)';

      out(`  ${i + 1}. ${r.page_title || '(无标题)'}`);
      out(`     ID: ${r.page_id}`);
      out(`     匹配度: ${score}`);
      out(`     摘要: ${snippet.substring(0, 100)}`);
      if (r.url) out(`     链接: ${r.url}`);

      if (i < results.length - 1) out('');
    }
  } catch (e) {
    out(`语义搜索失败: ${e.message}`);
  }
}

// ============== 主入口 ==============
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --help 优先处理
  if (opts.help) {
    out(HELP_TEXT.trim());
    process.exit(0);
  }

  // Token 解析（--token > 环境变量 > .env）
  const token = _resolveToken(opts.token);
  if (!token) {
    out('错误: 缺少 FlowUs 授权 token');
    out('');
    out('解决方法（按优先级）:');
    out('  1. 使用 --token <你的token> 参数传入');
    out('  2. 设置环境变量 FLOWUS_TOKEN');
    out('  3. 在当前目录创建 .env 文件，内容: FLOWUS_TOKEN=你的token');
    process.exit(1);
  }

  // 配置客户端（纯 REST，不再依赖 MCP）
  rest.configure({ token: token });

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

  // 模式 E：--semantic 语义搜索
  if (opts.semanticQuery) {
    await modeSemantic(opts.semanticQuery, opts);
    return;
  }

  // 确定目标数据库
  const dbId = opts.dbId || DEFAULT_DB_ID;
  if (!dbId) {
    out('错误: 未指定目标数据库');
    out('');
    out('解决方法（任选其一）:');
    out('  1. 使用 --db <数据库ID> 指定');
    out('  2. 设置环境变量 FLOWUS_DEFAULT_DB=<数据库ID>');
    out('  3. 使用 --search <关键词> 先搜索定位数据库');
    process.exit(1);
  }
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
