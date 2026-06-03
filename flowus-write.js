#!/usr/bin/env node
/**
 * FlowUs 写入脚本 v3.0
 *
 * 双模式写入架构（v3.0 升级）：
 *   - 默认模式：MCP putMarkdown（原始 MD → 服务端解析，格式保真度最高）
 *   - 备选模式：REST appendBlockChildren（客户端构造 Block，精确控制块结构）
 *
 * 写入方式选择依据（来自实战经验）：
 *   - putMarkdown: 服务端原生解析 Markdown，零格式损失，推荐用于文档上传
 *   - appendBlockChildren: 客户端逐块构造，适合需要精确控制的场景（追加/更新部分内容）
 *
 * 能力：
 *   - Markdown 文件 → FlowUs 页面（自动识别格式）
 *   - 代码文件 → FlowUs 代码块（语法高亮）
 *   - 纯文本 → FlowUs 段落
 *   - 查找或创建页面（去重）
 *   - 更新已有页面内容
 *   - 支持数据库和页面两种父级类型
 *
 * 用法：
 *   node flowus-write.js <文件路径> [标题]              # 上传文件（默认 putMarkdown）
 *   node flowus-write.js --blocks <文件> [标题]          # 使用 REST 块模式上传
 *   node flowus-write.js --text "内容" [标题]            # 直接写入文本
 *   node flowus-write.js --parent <id> <文件>            # 指定目标位置
 *   node flowus-write.js --update <文件> [标题]      # 更新已有页面
 *   node flowus-write.js --raw-file <json文件> [标题] 从文件读取原始 block JSON
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const fs = require('fs');
const path = require('path');
const rest = require('./lib/rest-client');
const mcp = require('./lib/mcp-client');  // putMarkdown 模式需要 MCP

// ============== 配置 ==============
/** Token 必须通过环境变量 FLOWUS_TOKEN 提供 */
const TOKEN = process.env.FLOWUS_TOKEN;
/** 默认父级数据库（可通过环境变量 FLOWUS_DEFAULT_PARENT 覆盖，或通过 --parent 指定） */
const DEFAULT_PARENT_DB = process.env.FLOWUS_DEFAULT_PARENT || '';

// ============== 日志 ==============
function log(msg) {
  try { process.stderr.write('[write] ' + msg + '\n'); } catch (_) { /* ignore */ }
}
function out(msg) {
  console.log(msg);
}

// ============== 参数解析 ==============
function parseArgs(argv) {
  const opts = {
    filePath: null,     // 文件路径（位置参数）
    textContent: null,  // --text 后面的文本
    rawBlocks: null,    // --raw 后面的 JSON
    rawFilePath: null,  // --raw-file 后面的文件路径
    title: null,        // 标题（位置参数2）
    parentDbId: null,   // --parent <id>
    parentType: null,   // --parent-type <database|page>
    updateMode: false,  // --update
    dryRun: false,      // --dry-run（只解析不写入）
    blocksMode: false,  // --blocks（使用 REST 块模式而非 putMarkdown）
    // 更新属性模式（--update-prop）
    updatePropId: null,
    setTitle: null,     // --set-title "新标题"
    setSelect: [],      // --set-select "字段名:值"（可多次）
    setCheckbox: [],    // --set-checkbox "字段名:true/false"
    setText: [],        // --set-text "字段名:内容"
    setIcon: null,      // --set-icon "emoji"
    setCover: null,     // --set-cover "url"
    // 删除模式（--delete）
    deleteId: null,
    force: false,       // --force
  };

  let positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parent') {
      opts.parentDbId = argv[++i];
    } else if (a === '--parent-type') {
      opts.parentType = argv[++i];
    } else if (a === '--update') {
      opts.updateMode = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--blocks') {
      opts.blocksMode = true;
    } else if (a === '--title') {
      opts.textContent = argv[++i] || '';
    } else if (a === '--raw') {
      opts.rawBlocks = argv[++i] || '';
    } else if (a === '--raw-file') {
      opts.rawFilePath = argv[++i] || '';
    } else if (a === '--icon') {
      opts.icon = argv[++i] || '';
    } else if (a === '--cover') {
      opts.coverUrl = argv[++i] || '';
    } else if (a === '--update-prop') {
      opts.updatePropId = argv[++i] || '';
    } else if (a === '--set-title') {
      opts.setTitle = argv[++i] || '';
    } else if (a === '--set-select') {
      opts.setSelect.push(argv[++i] || '');
    } else if (a === '--set-checkbox') {
      opts.setCheckbox.push(argv[++i] || '');
    } else if (a === '--set-text') {
      opts.setText.push(argv[++i] || '');
    } else if (a === '--set-icon') {
      opts.setIcon = argv[++i] || '';
    } else if (a === '--set-cover') {
      opts.setCover = argv[++i] || '';
    } else if (a === '--delete') {
      opts.deleteId = argv[++i] || '';
    } else if (a === '--force') {
      opts.force = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }

  // 位置参数：第一个是文件/内容，第二个是标题
  if (positional.length > 0 && !opts.filePath && !opts.textContent && !opts.rawBlocks) {
    opts.filePath = positional[0];
  }
  if (positional.length > 1 && !opts.title) {
    opts.title = positional[1];
  }

  return opts;
}

// ============== 常量 ==============

/** FlowUs 支持的完整语言名称映射（官方文档） */
const LANGUAGE_MAP = {
  'js': 'JavaScript', 'javascript': 'JavaScript',
  'ts': 'TypeScript', 'typescript': 'TypeScript',
  'py': 'Python', 'python': 'Python',
  'sh': 'Shell', 'shell': 'Shell', 'bash': 'Shell', 'zsh': 'Shell',
  'html': 'HTML', 'css': 'CSS', 'json': 'JSON', 'xml': 'XML',
  'yaml': 'YAML', 'yml': 'YAML', 'sql': 'SQL',
  'go': 'Go', 'rust': 'Rust', 'java': 'Java',
  'c': 'C', 'cpp': 'C++', 'csharp': 'C#', 'c#': 'C#',
  'php': 'PHP', 'ruby': 'Ruby', 'swift': 'Swift',
  'kotlin': 'Kotlin', 'scala': 'Scala', 'r': 'R',
  'markdown': 'Markdown', 'md': 'Markdown',
  'plaintext': 'Plain Text', 'plain': 'Plain Text', 'plain text': 'Plain Text', 'text': 'Plain Text',
  'dart': 'Dart', 'lua': 'Lua', 'perl': 'Perl',
  'powershell': 'PowerShell', 'vb': 'VB.NET',
  'objective-c': 'Objective-C', 'swift': 'Swift',
  'dockerfile': 'Dockerfile', 'makefile': 'MakeFile',
  'mermaid': 'Mermaid', 'latex': 'LaTeX', 'tex': 'LaTeX',
  'diff': 'diff', 'nginx': 'Nginx',
};

/** 代码文件扩展名集合 */
const CODE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss', '.less', '.json', '.xml',
  '.yaml', '.yml', '.sql', '.go', '.java', '.cpp', '.c', '.h',
  '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.r',
  '.dart', '.lua', '.pl', '.pm', '.ps1', '.psm1', '.bat', '.cmd',
  '.dockerfile', '.makefile', '.cmake', '.proto', '.graphql', '.gql',
  '.vue', '.svelte', '.ex', '.exs', '.erl', '.hs', '.ml', '.mli',
  '.clj', '.cljs', '.coffee', '.lisp', '.el', '.vim', '.tf', '.hcl',
  '.toml', 'ini', '.cfg', '.conf', '.env', '.gitignore',
]);

/** 合法的颜色值 */
const VALID_COLORS = new Set([
  'default', 'gray', 'brown', 'orange', 'yellow', 'green',
  'blue', 'purple', 'pink', 'red',
]);

/** 默认注解（无格式） */
const DEFAULT_ANNOTATIONS = Object.freeze({
  bold: false, italic: false, strikethrough: false,
  underline: false, code: false, color: 'default',
});

// ============== 富文本工具 ==============

/**
 * 创建单个 rich_text 对象
 * @param {string} content - 文本内容
 * @param {object} [annotations] - 注解覆盖
 * @returns {object}
 */
function rt(content, annotations) {
  const anno = annotations ? { ...DEFAULT_ANNOTATIONS, ...annotations } : { ...DEFAULT_ANNOTATIONS };
  // 校验颜色值
  if (!VALID_COLORS.has(anno.color)) anno.color = 'default';
  // 提取链接（用于 href 字段）
  const link = null; // 行内解析中单独处理链接时覆盖此值
  return {
    type: 'text',
    text: { content, link },
    annotations: anno,
    plain_text: content,   // 官方文档必填：纯文本副本
    href: null,            // 官方文档必填：链接（null 表示无链接）
  };
}

/**
 * 将长文本拆分为多个 rich_text 段（每段 ≤ 2000 字符）
 * @param {string} content
 * @param {object} [annotations]
 * @returns {Array}
 */
function splitRichText(content, annotations) {
  if (content.length <= 2000) return [rt(content, annotations)];
  const chunks = [];
  for (let i = 0; i < content.length; i += 2000) {
    chunks.push(rt(content.slice(i, i + 2000), annotations));
  }
  return chunks;
}

// ============== Block 格式工厂 ==============

/**
 * 创建 FlowUs REST API 写入格式的 block 对象
 *
 * 重要：FlowUs REST API 的写入格式使用 { type, data: {... } }
 *   （读取返回时服务端会转换为 { type, [typename]:{...} } 格式）
 *   这是经过实测验证的写入格式，官方文档展示的是读取格式
 *
 * @param {string} type - 块类型（如 'paragraph', 'heading_1', 'code'）
 * @param {object} data - 块数据
 * @returns {object} { type, data }
 */
function block(type, data) {
  return { type, data };
}

/**
 * 解析行内 Markdown 格式（粗体/斜体/行内代码），返回 rich_text 数组
 * 正则处理顺序：**bold** > *italic* > `code`
 * @param {string} text
 * @returns {Array}
 */
function parseInline(text) {
  // 防御：空值或非字符串输入返回空文本段
  if (text == null || typeof text !== 'string') {
    text = String(text == null ? '' : text);
  }
  const segments = [];
  // 匹配 **bold** 或 *italic* 或 `code`（排除已匹配的）
  const re = /(\*\*[^*]+\*\*|\*(?!\*)[^*]+\*|`[^`]+`)/g;
  let idx = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    // 前面的纯文本
    if (m.index > idx) {
      segments.push(rt(text.slice(idx, m.index)));
    }

    const raw = m[0];
    let anno = {};

    if (raw.startsWith('**') && raw.endsWith('**')) {
      anno.bold = true;
      segments.push(rt(raw.slice(2, -2), anno));
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      anno.italic = true;
      segments.push(rt(raw.slice(1, -1), anno));
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      anno.code = true;
      segments.push(rt(raw.slice(1, -1), anno));
    }

    idx = re.lastIndex;
  }

  if (idx < text.length) {
    segments.push(rt(text.slice(idx)));
  }

  return segments.length > 0 ? segments : [rt(text)];
}

// ============== Markdown → Block 解析器 ==============

/**
 * 将 Markdown 文本解析为 FlowUs block 数组
 *
 * 支持的格式：
 *   ```code``` → code block
 *   # / ## / ### → heading
 *   > → quote
 *   - / * → bulleted_list_item
 *   1. → numbered_list_item
 *   - [ ] / - [x] → to_do
 *   --- → divider
 *   | | | → table (+ table_row)
 *   ![alt](url) → image
 *   [text](url) → bookmark
 *   >! callout → callout（用 >! 前缀区分普通引用）
 *   <details> → toggle 折叠块
 *   $...$ / $$...$$ → equation 公式
 *   普通文本 → paragraph
 *
 * @param {string} md - Markdown 文本
 * @returns {Array} block 数组
 */
function mdToBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 跳过空行
    if (!line.trim()) { i++; continue; }

    // ---- 1. 代码块 ``` ----
    // 支持多词语言名（如 FlowUs 导出的 "Plain Text"）和单词语言名（如 "javascript"）
    const codeMatch = line.match(/^```([\w\-+.#]*)\s*(.*)?$/);
    if (codeMatch) {
      // 合并所有捕获组作为语言标识（支持 "Plain Text" 等含空格的名称）
      const rawLang = (codeMatch[1] || '') + (codeMatch[2] ? ' ' + codeMatch[2].trim() : '');
      const langKey = rawLang.trim().toLowerCase() || 'plain';
      const lang = LANGUAGE_MAP[langKey] || (rawLang.trim() || 'Plain Text');
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```

      blocks.push(makeCodeBlock(codeLines.join('\n'), lang));
      continue;
    }

    // ---- 2. Callout (>! 开头) ----
    if (line.startsWith('>!') || line.startsWith('> !')) {
      const iconMatch = line.match(/^>!\s*(\S{1,4})\s*/);
      const icon = iconMatch ? iconMatch[1].trim() : '';
      const calloutLines = [];

      while (i < lines.length) {
        const cl = lines[i];
        if (cl.startsWith('>!') || cl.startsWith('> !')) {
          calloutLines.push(cl.replace(/^>!?\s*/, '').trim());
        } else if (cl.startsWith('> ') && !cl.startsWith('>!')) {
          // 普通 > 行也归入 callout（多行 callout 支持）
          calloutLines.push(cl.slice(2).trim());
        } else {
          break;
        }
        i++;
      }

      const content = calloutLines.join('\n');
      blocks.push(block('callout', {
        rich_text: parseInline(content),
        icon: icon ? { emoji: icon } : undefined,
        text_color: 'default',
        background_color: 'default',
      }));
      continue;
    }

    // ---- 3. 引用块 > ----
    if (line.startsWith('>') && !line.startsWith('>!') && !line.startsWith('> !')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, '').trim());
        i++;
      }
      blocks.push(block('quote', {
        rich_text: parseInline(quoteLines.join('\n')),
        text_color: 'default',
        background_color: 'default',
      }));
      continue;
    }

    // ---- 4. 无序列表 - / * ----
    const bulletMatch = line.match(/^(\s{0,4})[-*]\s+(.*)/);
    if (bulletMatch && !line.startsWith('---')) {
      const items = collectListItems(lines, i, /^[-*]\s+(.*)/);
      items.forEach(item => {
        // 检查 to_do 格式: - [ ] 或 - [x]
        const todoMatch = item.match(/^\[(x| )\]\s*(.*)/i);
        if (todoMatch) {
          blocks.push(block('to_do', {
            rich_text: parseInline(todoMatch[2]),
            checked: todoMatch[1].toLowerCase() === 'x',
            text_color: 'default',
            background_color: 'default',
          }));
        } else {
          blocks.push(block('bulleted_list_item', {
            rich_text: parseInline(item),
            text_color: 'default',
            background_color: 'default',
          }));
        }
      });
      i += items.length;
      continue;
    }

    // ---- 5. 有序列表 1. ----
    const numMatch = line.match(/^\s*\d+\.\s+(.*)/);
    if (numMatch) {
      const items = collectListItems(lines, i, /^\d+\.\s+(.*)/);
      items.forEach(item => {
        blocks.push(block('numbered_list_item', {
          rich_text: parseInline(item),
          text_color: 'default',
          background_color: 'default',
        }));
      });
      i += items.length;
      continue;
    }

    // ---- 6. 分隔线 ----
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push(block('divider', {}));
      i++;
      continue;
    }

    // ---- 6.5. 折叠块 <details> / <summary> 或 >+ 空行模式 ----
    const detailsMatch = line.match(/^<details>\s*$/);
    if (detailsMatch) {
      i++; // 跳过 <details>
      let summary = '';
      // 检查下一行是否是 <summary>
      if (i < lines.length && lines[i].match(/^<summary>(.*)<\/summary>/)) {
        summary = lines[i].replace(/<\/?summary>/g, '').trim();
        i++;
      }
      const toggleLines = [];
      while (i < lines.length && !lines[i].match(/^<\/details>\s*$/)) {
        toggleLines.push(lines[i]);
        i++;
      }
      i++; // 跳过 </details>
      blocks.push(block('toggle', {
        rich_text: parseInline(summary || '折叠内容'),
        text_color: 'default',
        background_color: 'default',
        // 折叠内容作为子块追加
      }));
      // 将折叠内部内容也解析为子块
      if (toggleLines.length > 0) {
        const innerBlocks = mdToBlocks(toggleLines.join('\n'));
        blocks.push(...innerBlocks);
      }
      continue;
    }

    // ---- 6.6. 行内公式 $...$ 和块公式 $$...$$ ----
    const inlineEqMatch = line.match(/^\$(.+)\$$/);
    if (inlineEqMatch && !line.startsWith('$$')) {
      blocks.push(block('equation', { expression: inlineEqMatch[1] }));
      i++;
      continue;
    }
    const blockEqStart = line.match(/^\$\s*$/);
    if (blockEqStart) {
      i++;
      const eqLines = [];
      while (i < lines.length && !lines[i].match(/^\$\s*$/)) {
        eqLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 $$
      blocks.push(block('equation', { expression: eqLines.join('\n') }));
      continue;
    }

    // ---- 7. 表格 | ----
    if (line.includes('|') && !line.startsWith('![')) {
      const tblLines = [];
      while (i < lines.length && lines[i].includes('|')) {
        tblLines.push(lines[i]);
        i++;
      }
      const tblBlock = parseTable(tblLines);
      if (tblBlock) blocks.push(tblBlock);
      continue;
    }

    // ---- 8. 标题 # ## ### ----
    const h3 = line.match(/^### (.+)$/);
    const h2 = line.match(/^## (.+)$/);
    const h1 = line.match(/^# (.+)$/);

    if (h3) {
      blocks.push(block('heading_3', { rich_text: parseInline(h3[1]), text_color: 'default', background_color: 'default' }));
      i++; continue;
    }
    if (h2) {
      blocks.push(block('heading_2', { rich_text: parseInline(h2[1]), text_color: 'default', background_color: 'default' }));
      i++; continue;
    }
    if (h1) {
      blocks.push(block('heading_1', { rich_text: parseInline(h1[1]), text_color: 'default', background_color: 'default' }));
      i++; continue;
    }

    // ---- 9. 图片 ![alt](url) ----
    const imgMatch = line.match(/^!\[([^\]]*)\]\((.+)\)\s*$/);
    if (imgMatch) {
      blocks.push(block('image', {
        type: 'external',
        external: { url: imgMatch[2] },
        caption: imgMatch[1] ? parseInline(imgMatch[1]) : [],
      }));
      i++; continue;
    }

    // ---- 10. 书签 [text](url) 独占一行 ----
    const bmMatch = line.match(/^\[([^\]]+)\]\(([^)]+)\)\s*$/);
    if (bmMatch) {
      blocks.push(block('bookmark', {
        url: bmMatch[2],
        caption: parseInline(bmMatch[1]),
      }));
      i++; continue;
    }

    // ---- 11. 普通段落（含行内格式） ----
    const content = line.trim();
    if (content) {
      const rts = parseInline(content);
      // 处理单段超过 2000 字符的情况
      if (rts.length === 1 && rts[0].text.content.length > 2000) {
        const split = splitRichText(rts[0].text.content, rts[0].annotations);
        split.forEach(s => {
          blocks.push(block('paragraph', { rich_text: [s], text_color: 'default', background_color: 'default' }));
        });
      } else {
        blocks.push(block('paragraph', { rich_text: rts, text_color: 'default', background_color: 'default' }));
      }
    }

    i++;
  }

  return blocks;
}

/**
 * 收集连续的列表项
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {RegExp} itemRe
 * @returns {string[]}
 */
function collectListItems(lines, startIdx, itemRe) {
  const items = [];
  let i = startIdx;
  while (i < lines.length) {
    const m = lines[i].match(itemRe);
    if (!m) break;
    items.push(m[1]);
    i++;
  }
  return items;
}

/**
 * 解析 Markdown 表格为 table + table_row 结构
 * @param {string[]} tblLines
 * @returns {object|null}
 */
function parseTable(tblLines) {
  // 过滤分隔行（|---|---|）
  const dataLines = tblLines.filter(l => !/^\s*\|[\s:-|]+\|\s*$/.test(l));
  if (dataLines.length === 0) return null;

  const firstCells = dataLines[0].split('|').map(c => c.trim()).filter(c => c);
  const colCount = firstCells.length;
  if (colCount === 0) return null;

  const rows = dataLines.map(line => {
    return line.split('|').map(c => c.trim()).filter(c => c);
  }).filter(r => r.length > 0);

  const children = rows.map(row => ({
    type: 'table_row',
    data: { cells: row.map(cell => parseInline(cell)) },
  }));

  return {
    type: 'table',
    data: { table_width: colCount, has_column_header: true, has_row_header: false },
    children,
  };
}

/**
 * 创建代码块 — 注意 MCP 协议使用 `code:` 字段而非 `data:`
 * @param {string} code
 * @param {string} language
 * @returns {object}
 */
function makeCodeBlock(code, language) {
  return block('code', {
    rich_text: splitRichText(code),
    language,
  });
}

// ============== 文件类型判断 ==============

/**
 * 从扩展名获取语言名
 * @param {string} ext
 * @returns {string}
 */
function extToLanguage(ext) {
  return LANGUAGE_MAP[ext.toLowerCase().slice(1)] || 'Plain Text';
}

/**
 * 判断是否为代码文件
 * @param {string} ext
 * @returns {boolean}
 */
function isCodeExt(ext) {
  return CODE_EXTS.has(ext.toLowerCase());
}

// ============== FlowUs API 操作 ==============

/**
 * 在数据库中查找同名页面（REST 版）
 *
 * 使用 REST queryDatabase 获取全部记录后在客户端匹配标题。
 * 不使用服务端 filter 是因为不同数据库的标题属性名可能不同
 * （"title" / "标题" 等），客户端匹配更可靠。
 *
 * @param {string} dbId
 * @param {string} title
 * @returns {Promise<string|null>} page_id 或 null
 */
async function findPageByTitle(dbId, title) {
  try {
    const results = await rest.queryDatabase(dbId);

    // 遍历所有记录，从 properties 中提取标题值进行匹配
    for (const r of results) {
      const props = r.properties || {};
      // 尝试多种可能的标题属性名
      const titleProp = props.title || props['标题'] || props.Name || props.name;
      if (!titleProp) continue;

      // 提取文本值
      const val = titleProp[titleProp.type];
      let text = '';
      if (Array.isArray(val)) {
        text = val.map(v => v.plain_text || v.text?.content || '').join('');
      } else if (typeof val === 'string') {
        text = val;
      } else if (val?.name) {
        text = val.name;
      }

      if (text === title) return r.id;
    }

    return null;
  } catch (e) {
    // 父级为普通页面时 queryDatabase 必然失败（HTTP_400），不打印多余日志
    if (!e.message.includes('不是数据库')) {
      log(`查找页面失败: ${e.message.substring(0, 60)}`);
    }
    return null;
  }
}

/**
 * 创建新页面（REST 版）
 *
 * 官方文档：POST /v1/pages
 *   - parent: { database_id } 或 { page_id }
 *   - properties: { 属性名: { type, [title|rich_text|select|...] } }
 *   - icon: { emoji } （可选）
 *   - cover: { external: { url } } （可选）
 *
 * @param {object} options
 * @param {string} options.parentDbId - 父数据库 ID
 * @param {string} options.title - 页面标题
 * @param {string} [options.icon] - 图标 emoji
 * @param {string} [options.coverUrl] - 封面图片 URL
 * @returns {Promise<string>} page_id
 */
async function createPage(options) {
  const { parentDbId, parentId, title, icon, coverUrl, parentType = 'database' } = options;

  // 支持两种父级类型：database（多维表）或 page（普通页面）
  const parent = parentType === 'page'
    ? { page_id: parentId || parentDbId }
    : { database_id: parentDbId };

  const body = {
    parent,
    properties: {
      title: {
        type: 'title',
        title: [rt(title)],
      },
    },
  };

  // 可选：icon / cover
  if (icon) body.icon = { emoji: icon };
  if (coverUrl) body.cover = { external: { url: coverUrl } };

  const result = await rest.post('/pages', body);

  const pageId = result?.id || null;
  if (!pageId) {
    throw new Error(`创建页面失败: ${JSON.stringify(result).substring(0, 200)}`);
  }

  return pageId;
}

/**
 * 更新页面属性（轻量更新，不重写块内容）
 *
 * 官方文档：PATCH /v1/pages/{page_id}
 *   - 可单独更新 icon, cover, properties（部分属性）
 *   - 不影响已有的子块内容
 *
 * @param {string} pageId
 * @param {object} updates
 * @param {string} [updates.icon] - 新图标 emoji
 * @param {string} [updates.coverUrl] - 新封面 URL
 * @param {object} [updates.properties] - 要更新的属性（部分）
 * @returns {Promise<object>} 更新后的页面对象
 */
async function updatePageProperties(pageId, updates) {
  const body = {};
  if (updates.icon) body.icon = { emoji: updates.icon };
  if (updates.coverUrl) body.cover = { external: { url: updates.coverUrl } };
  if (updates.properties) body.properties = updates.properties;

  if (Object.keys(body).length === 0) {
    throw new Error('updatePageProperties: 至少需要一项更新内容');
  }

  const result = await rest.patch(`/pages/${pageId}`, body);
  log(`  属性已更新: ${Object.keys(body).join(', ')}`);
  return result;
}

/**
 * 批量追加子块到页面（REST API，自动分批，每批 ≤ 100 个）
 *
 * 使用 REST API 而非 MCP 进行写入，原因：
 *   - 格式统一：所有块（含 code）都用 {type, data} 结构
 *   - 行为可预测：文档完善，限速规则明确
 *   - 无需格式转换：mdToBlocks() 输出即为 REST 格式
 *
 * @param {string} pageId
 * @param {Array} blocks - block 数组，统一 {type, data} 格式
 * @param {object} [options]
 * @param {number} [options.batchSize=100] - 每批数量
 * @param {number} [options.delayMs=300] - 批间延迟（避免 100次/分的写入限速）
 * @returns {Promise<number>} 成功写入的块数
 */
async function appendBlocks(pageId, blocks, options = {}) {
  const batchSize = options.batchSize || 100;
  const delayMs = options.delayMs || 300;
  let totalWritten = 0;

  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize);
    // 直接使用 REST API，无需格式转换
    log(`  写入批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(blocks.length / batchSize)} (${batch.length} 个块)`);

    try {
      const result = await rest.patch(`/blocks/${pageId}/children`, { children: batch });

      // REST 返回 { results: [...] }
      const count = result?.results?.length || batch.length;
      totalWritten += count;
      log(`  ✓ 成功 ${count}/${batch.length}`);
    } catch (e) {
      log(`  ✗ 批次写入失败: ${e.message.substring(0, 100)}`);
      // 逐个重试失败的批次
      for (const b of batch) {
        try {
          await rest.patch(`/blocks/${pageId}/children`, { children: [b] });
          totalWritten++;
        } catch (e2) {
          log(`    ✗ 单块写入失败 (${b.type}): ${e2.message.substring(0, 60)}`);
        }
        await rest.sleep(50); // 单块间小间隔
      }
    }

    // 批间延迟（避免触发 100次/分的写入限速）
    if (i + batchSize < blocks.length) {
      await rest.sleep(delayMs);
    }
  }

  return totalWritten;
}

/**
 * 清空页面的所有子块（REST 版，用于更新模式）
 * 先用 REST 获取所有子块，再逐一 DELETE
 *
 * @param {string} pageId
 * @returns {Promise<number>} 删除的数量
 */
async function clearPageBlocks(pageId) {
  try {
    const blocks = await rest.getAllBlocks(pageId);
    if (blocks.length === 0) return 0;

    log(`  清空 ${blocks.length} 个旧块...`);
    let deleted = 0;
    for (const b of blocks) {
      try {
        await rest.del(`/blocks/${b.id}`);
        deleted++;
      } catch (e) {
        // 忽略删除失败（可能是系统保护块）
      }
      await rest.sleep(50); // 删除间延迟
    }
    return deleted;
  } catch (e) {
    log(`  清空失败: ${e.message.substring(0, 60)}`);
    return 0;
  }
}

// ============== putMarkdown 写入路径（v3.0 核心） ==============

/**
 * 从 Markdown 中提取所有表格，返回处理后的文本和表格数据
 *
 * 原因：FlowUs 的 putMarkdown 服务端解析器不支持 GFM 表格语法，
 *       表格行（| col | col |）会被当作普通 paragraph 块。
 *       因此需要提取表格，在 putMarkdown 后用 REST API 补入真正的 table 块。
 *
 * @param {string} md - 原始 Markdown 文本
 * @returns {{ processedMd: string, tables: Array<{index: number, headerLine: string, rows: string[]}> }}
 */
function extractTables(md) {
  const lines = md.split('\n');
  const tables = [];      // 提取的表格列表
  const output = [];      // 处理后的行（不含表格）
  let i = 0;

  while (i < lines.length) {
    // 检测表格起始行（包含 | 且不是图片行）
    if (lines[i].includes('|') && !lines[i].startsWith('![')) {
      // 收集连续的表格行
      const tblLines = [];
      while (i < lines.length && lines[i].includes('|') && !lines[i].startsWith('![')) {
        tblLines.push(lines[i]);
        i++;
      }

      // 过滤分隔行（|---|---|），保留数据行
      const dataLines = tblLines.filter(l => !/^\s*\|[\s:-|]+\|\s*$/.test(l));
      if (dataLines.length >= 2) {
        // 至少有表头 + 1 行数据才算有效表格
        const placeholder = `\n<!-- TABLE_${tables.length} -->\n`;
        tables.push({
          index: tables.length,
          rawLines: tblLines,         // 原始行（含分隔线）
          dataLines,                   // 数据行（不含分隔线）
          placeholder: ` TABLE_${tables.length} `,  // 用于后续检测的标记
        });
        output.push(placeholder);
        log(`    提取表格 #${tables.length}: ${dataLines.length} 行`);
      } else {
        // 不够构成表格，原样保留
        output.push(...tblLines);
      }
      continue;
    }

    output.push(lines[i]);
    i++;
  }

  return { processedMd: output.join('\n'), tables };
}

/**
 * 通过 MCP putMarkdown 写入页面内容（v3.0 默认模式）
 *
 * 原理：将原始 Markdown 文本直接发送给 FlowUs 服务端解析，
 *       由服务端负责将 MD 转换为原生块结构。
 *
 * 核心优势（来自实战经验验证）：
 *   - 零格式损失：服务端原生解析器完整支持大部分 Markdown 语法
 *   - 无客户端 bug：绕过 mdToBlocks 解析器的所有潜在问题
 *   - 自动优化：服务端自动处理块合并、嵌套、特殊字符转义等
 *
 * 已知限制：
 *   - ❌ 不支持 GFM 表格语法（表格行变 paragraph，需后处理补入 table 块）
 *   - ❌ 不支持 HTML <table> 标签（同样变纯文本 paragraph）
 *
 * 对比 appendBlockChildren（REST 块模式）：
 *   - putMarkdown: 原始 MD → 服务端解析 → 页面（推荐，格式保真度高）
 *   - appendBlockChildren: 客户端构造 Block → API 逐块写入（适合精确控制）
 *
 * @param {string} pageId - 目标页面 ID
 * @param {string} markdownContent - 原始 Markdown 文本
 * @returns {Promise<object>} API 返回结果
 */
async function writeViaPutMarkdown(pageId, markdownContent) {
  // 配置 MCP 客户端
  mcp.configure({ token: TOKEN });

  // 预热连接（建立 Session，指数退避重试）
  log('  正在建立 MCP 连接（putMarkdown 模式）...');
  const warmOk = await mcp.warmUp();
  if (!warmOk) {
    throw new Error('MCP Server 连接失败，无法使用 putMarkdown 模式');
  }

  // 调用 putMarkdown API（核心调用）
  log(`  发送 Markdown 到服务端解析 (${markdownContent.length} 字符)...`);
  const result = await mcp.mcpCall('API-putMarkdown', {
    page_id: pageId,
    body: { markdown: markdownContent },
  });

  log('  ✓ putMarkdown 写入完成');
  return result;
}

/**
 * 混合写入模式（v3.1）：putMarkdown + 表格后处理
 *
 * 策略：
 *   1. 将原始 MD 直接通过 putMarkdown 发送到服务端（非表格内容零格式损失）
 *   2. 读取页面块，检测被 putMarkdown 错误渲染为 paragraph 的表格行（含 | 的行）
 *   3. 将连续的"假表格段落"分组，删除它们，用 REST API 插入真正的 table 块
 *
 * 为什么需要后处理：
 *   FlowUs putMarkdown 服务端解析器不支持 GFM 表格语法，
 *   表格行（| col | col |）会被当作普通 paragraph 块输出。
 *   同时 HTML 注释和 <table> 标签也均不被支持/会被剥离。
 *
 * @param {string} pageId - 目标页面 ID
 * @param {string} markdownContent - 原始 Markdown 文本（用于参考，判断是否有表格）
 * @returns {Promise<void>}
 */
async function writeViaHybrid(pageId, markdownContent) {
  // 先检查原始 MD 是否包含表格（避免无表格时做不必要的后处理）
  const hasTable = /^\|.+\|$/m.test(markdownContent) || /^|.+\|$/m.test(markdownContent);

  // Step 1: putMarkdown 写入原始内容
  await writeViaPutMarkdown(pageId, markdownContent);

  // 如果没有表格，直接返回
  if (!hasTable) {
    return;
  }

  // Step 2: 等待服务端处理完成
  await rest.sleep(2000);

  // Step 3: 读取所有子块（使用 REST 获取完整列表，MCP API 有分页限制）
  log(`  📝 检测到原文包含表格，执行后处理...`);

  let allBlocks = [];
  try {
    // 必须用 REST getAllBlocks 获取完整子块列表
    // MCP 的 API-getBlockChildren 有分页限制（只返回前 ~20 个块），会遗漏大量内容
    allBlocks = await rest.getAllBlocks(pageId);
  } catch (e) {
    log(`  ⚠️ 读取子块失败，跳过表格后处理: ${e.message.substring(0, 80)}`);
    return;
  }

  if (allBlocks.length === 0) {
    log('  页面无子块，跳过表格处理');
    return;
  }

  // Step 4: 扫描所有 paragraph 块，找出"假表格段落"（内容包含 | 且看起来像表格行）
  const tableRowPattern = /^\s*\|.*\|\s*$/;           // 表格数据行：| ... |
  const separatorPattern = /^\s*\|[\s\-:|]+\|\s*$/;    // 分隔行：|---|---|

  // 收集连续的假表格段落组
  const fakeTableGroups = [];   // 每组: [{ blockIndex, blockId, content }, ...]
  let currentGroup = null;

  for (let bi = 0; bi < allBlocks.length; bi++) {
    const b = allBlocks[bi];
    if (b.type !== 'paragraph') {
      // 非段落 → 结束当前组（如果有）
      if (currentGroup && currentGroup.length >= 2) {
        fakeTableGroups.push(currentGroup);
      }
      currentGroup = null;
      continue;
    }

    // 提取段落文本（兼容 REST 格式 data: 和 MCP 格式 type_name:）
    const text = b.data?.rich_text || b[b.type]?.rich_text || b.paragraph?.rich_text || [];
    const content = Array.isArray(text)
      ? text.map(t => t.plain_text || t.text?.content || '').join('')
      : '';

    // 判断是否是假表格行
    if (tableRowPattern.test(content) || separatorPattern.test(content)) {
      if (!currentGroup) currentGroup = [];
      currentGroup.push({ blockIndex: bi, blockId: b.id, content });
    } else {
      // 非表格段落 → 结束当前组
      if (currentGroup && currentGroup.length >= 2) {
        fakeTableGroups.push(currentGroup);
      }
      currentGroup = null;
    }
  }

  // 处理末尾的组
  if (currentGroup && currentGroup.length >= 2) {
    fakeTableGroups.push(currentGroup);
  }

  if (fakeTableGroups.length === 0) {
    log('  未检测到被错误渲染的表格段落（可能 putMarkdown 已正确处理或表格格式不标准）');
    return;
  }

  log(`  📊 检测到 ${fakeTableGroups.length} 组假表格段落，开始修复...`);

  // Step 5: 逐组处理：删除假段落 → 构造真正 table 块 → 插入
  let fixedCount = 0;

  for (let gi = 0; gi < fakeTableGroups.length; gi++) {
    const group = fakeTableGroups[gi];

    // 过滤掉分隔行，只保留数据行
    const dataLines = group
      .filter(g => !separatorPattern.test(g.content))
      .map(g => g.content);

    if (dataLines.length < 2) {
      continue; // 至少需要表头+1数据行
    }

    // 用 parseTable 构造表格结构（含 table_row children）
    const tblBlock = parseTable(dataLines);
    if (!tblBlock) {
      log(`    ⚠️ 组 #${gi}: parseTable 解析失败 (${dataLines.length} 行)`);
      continue;
    }
    const tableRows = tblBlock.children || [];

    // 删除该组的所有假段落（从后往前删避免索引问题）
    const idsToDelete = group.map(g => g.blockId);
    for (let i = idsToDelete.length - 1; i >= 0; i--) {
      try { await rest.del(`/blocks/${idsToDelete[i]}`); } catch (_) { /* ignore */ }
      await rest.sleep(30);
    }

    // 两步法插入表格（FlowUs REST API 不支持嵌套 children）：
    //   Step 1: 创建空 table 块
    //   Step 2: 向 table 块追加 table_row 子块
    try {
      const emptyTable = {
        type: 'table',
        data: tblBlock.data,
        // 不带 children — 先创建空表
      };
      const createResult = await rest.patch(`/blocks/${pageId}/children`, { children: [emptyTable] });
      const createdIds = createResult.results || [];
      if (createdIds.length === 0) {
        log(`    ✗ 组 #${gi}: 创建空 table 失败（无返回 ID）`);
        continue;
      }
      const tableId = createdIds[createdIds.length - 1].id; // 最后创建的就是 table

      // Step 2: 追加 table_row 到 table 块
      if (tableRows.length > 0) {
        await rest.patch(`/blocks/${tableId}/children`, { children: tableRows });
      }

      log(`    ✓ 组 #${gi}: 已修复 (${dataLines.length} 行 → ${tblBlock.data.table_width}列, ${tableRows.length} rows)`);
      fixedCount++;
    } catch (e) {
      log(`    ✗ 组 #${gi}: 插入失败: ${e.message.substring(0, 80)}`);
    }

    await rest.sleep(100);
  }

  log(`  ✓ 表格后处理完成：${fixedCount}/${fakeTableGroups.length} 个表格已修复`);
}

// ============== 主流程模式 ==============

/**
 * 模式 A：上传文件（MD / 代码 / 其他）
 *
 * v3.0 双模式架构：
 *   - 默认（无 --blocks）：使用 putMarkdown（原始 MD → 服务端解析）
 *   - --blocks 标志：使用 REST appendBlockChildren（客户端 Block 构造）
 */
async function modeUploadFile(opts) {
  const filePath = path.resolve(opts.filePath);

  if (!fs.existsSync(filePath)) {
    out(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath, ext);
  const title = opts.title || fileName;

  out(`\n📤 上传文件: ${filePath}`);
  out(`📄 标题: ${title}`);
  out(`📝 类型: ${ext || '(无扩展名)'}`);

  const parentDbId = opts.parentDbId || DEFAULT_PARENT_DB;

  // 查找或创建页面（父级为普通页面时跳过查找，直接新建）
  let pageId;
  const canSearch = opts.parentType !== 'page';
  if (opts.updateMode) {
    if (canSearch) pageId = await findPageByTitle(parentDbId, title);
    if (pageId) {
      out(`🔄 找到已有页面，更新中: ${pageId}`);
      await clearPageBlocks(pageId);
    } else {
      out(`⚠️ 未找到 "${title}"，将新建...`);
      pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
      out(`✅ 新建页面: ${pageId}`);
    }
  } else {
    if (canSearch) pageId = await findPageByTitle(parentDbId, title);
    if (pageId) {
      out(`⚠️ 页面已存在 (${pageId})，将在末尾追加内容。如需替换请使用 --update`);
    } else {
      pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
      out(`✅ 新建页面: ${pageId}`);
    }
  }

  // ============== v3.0 双模式写入 ==============
  if (opts.blocksMode) {
    // ---- 模式 B：REST appendBlockChildren（客户端构造 Block）----
    // 适用场景：需要精确控制块结构、追加/部分更新、调试解析器

    let blocks;

    if (isCodeExt(ext)) {
      const lang = extToLanguage(ext);
      log(`  [blocks] 代码文件 → code block (${lang})`);
      blocks = [makeCodeBlock(raw, lang)];
    } else if (ext === '.md' || ext === '.markdown') {
      log(`  [blocks] Markdown → mdToBlocks 解析`);
      blocks = mdToBlocks(raw);
    } else {
      if (raw.length > 5000) {
        log(`  [blocks] 大文本 → code block`);
        blocks = [makeCodeBlock(raw, 'Plain Text')];
      } else {
        log(`  [blocks] 文本 → paragraph`);
        blocks = [block('paragraph', { rich_text: splitRichText(raw), text_color: 'default', background_color: 'default' })];
      }
    }

    if (opts.dryRun) {
      out(`\n[Dry Run] [blocks 模式] 将写入 ${blocks.length} 个块:`);
      out(JSON.stringify(blocks, null, 2).substring(0, 3000));
      return;
    }

    await rest.sleep(1500);
    const written = await appendBlocks(pageId, blocks);
    out(`\n✅ [blocks 模式] 完成！共写入 ${written}/${blocks.length} 个块`);

  } else {
    // ---- 模式 A：MCP putMarkdown（默认，服务端解析）----
    // 核心优势：零格式损失，绕过所有客户端解析 bug（经验贴验证）

    let markdownContent;

    if (isCodeExt(ext)) {
      // 代码文件：用围栏包裹，让服务端识别为代码块
      const lang = extToLanguage(ext);
      log(`  [putMarkdown] 代码文件 → \`\`\`${lang} 围栏`);
      markdownContent = `\`\`\`${lang}\n${raw}\n\`\`\``;
    } else if (ext === '.md' || ext === '.markdown') {
      // Markdown 文件：直接传递原始内容
      log(`  [putMarkdown] Markdown → 原始内容直传`);
      markdownContent = raw;
    } else {
      // 其他文本：直接传递（服务端自动处理）
      log(`  [putMarkdown] 文本 → 原始内容直传`);
      markdownContent = raw;
    }

    if (opts.dryRun) {
      out(`\n[Dry Run] [putMarkdown 模式] 将发送 ${markdownContent.length} 字符的 Markdown:`);
      out(markdownContent.substring(0, 3000));
      if (markdownContent.length > 3000) out(`... (共 ${markdownContent.length} 字符)`);
      return;
    }

    // 写入（等待页面就绪 + MCP 连接）— 使用混合模式（自动处理表格）
    await rest.sleep(1500);
    await writeViaHybrid(pageId, markdownContent);
    out(`\n✅ [混合模式] 完成！已发送 ${markdownContent.length} 字符（含表格后处理）`);
  }

  out(`📄 页面 ID: ${pageId}`);
  out(`🔗 https://flowus.cn/${pageId.replace(/-/g, '')}`);
}

/**
 * 模式 B：直接写入文本
 */
async function modeWriteText(opts) {
  const text = opts.textContent;
  const title = opts.title || `笔记-${new Date().toISOString().slice(0, 10)}`;

  out(`\n📝 直接写入文本`);
  out(`📄 标题: ${title}`);

  const parentDbId = opts.parentDbId || DEFAULT_PARENT_DB;
  let pageId;

  if (opts.updateMode) {
    pageId = await findPageByTitle(parentDbId, title);
    if (pageId) {
      out(`🔄 更新已有页面: ${pageId}`);
      await clearPageBlocks(pageId);
    } else {
      pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
      out(`✅ 新建: ${pageId}`);
    }
  } else {
    pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
    out(`✅ 新建: ${pageId}`);
  }

  const blocks = mdToBlocks(text);

  if (opts.dryRun) {
    out(`\n[Dry Run] ${blocks.length} 个块`);
    return;
  }

  const written = await appendBlocks(pageId, blocks);
  out(`\n✅ 完成！写入 ${written}/${blocks.length} 个块`);
  out(`🔗 https://flowus.cn/${pageId.replace(/-/g, '')}`);
}

/**
 * 模式 C：直接写入原始 block JSON
 */
async function modeWriteRaw(opts) {
  const parentDbId = opts.parentDbId || DEFAULT_PARENT_DB;
  const title = opts.title || `Raw-${Date.now()}`;

  let blocks;

  // 优先从文件读取（避免 shell 转义问题）
  if (opts.rawFilePath) {
    try {
      const rawJson = fs.readFileSync(path.resolve(opts.rawFilePath), 'utf-8');
      blocks = JSON.parse(rawJson);
      if (!Array.isArray(blocks)) throw new Error('不是数组');
    } catch (e) {
      out(`错误: --raw-file 文件读取或解析失败: ${e.message}`);
      process.exit(1);
    }
  } else {
    try {
      blocks = JSON.parse(opts.rawBlocks);
      if (!Array.isArray(blocks)) throw new Error('不是数组');
    } catch (e) {
      out(`错误: --raw 参数必须是合法的 JSON 数组: ${e.message}`);
      process.exit(1);
    }
  }

  out(`\n📦 写入 ${blocks.length} 个原始 block`);

  const pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
  out(`✅ 页面: ${pageId}`);

  if (opts.dryRun) {
    out(`[Dry Run] 完成`);
    return;
  }

  const written = await appendBlocks(pageId, blocks);
  out(`\n✅ 完成！写入 ${written}/${blocks.length} 个块`);
}

// ============== 更新属性模式 ==============

/**
 * 模式 D：--update-prop 更新页面属性（不改正文）
 * 支持改标题、select、checkbox、rich_text、图标、封面
 */
async function modeUpdateProp(opts) {
  const pageId = opts.updatePropId;
  if (!pageId) {
    out('错误: --update-prop 需要页面 ID');
    process.exit(1);
  }

  const properties = {};
  let hasUpdates = false;

  // --set-title "新标题"
  if (opts.setTitle !== null) {
    properties.title = {
      type: 'title',
      title: [
        { type: 'text', text: { content: opts.setTitle, link: null },
          annotations: { bold: false, italic: false, strikethrough: false,
            underline: false, code: false, color: 'default' },
          plain_text: opts.setTitle, href: null }
      ]
    };
    hasUpdates = true;
  }

  // --set-select "字段名:值"
  for (const s of opts.setSelect) {
    const idx = s.indexOf(':');
    if (idx === -1) { out(`  ⚠️ --set-select 格式应为 "字段名:值"，跳过: ${s}`); continue; }
    const name = s.substring(0, idx).trim();
    const val = s.substring(idx + 1).trim();
    properties[name] = { type: 'select', select: { name: val } };
    hasUpdates = true;
  }

  // --set-checkbox "字段名:true/false"
  for (const s of opts.setCheckbox) {
    const idx = s.indexOf(':');
    if (idx === -1) { out(`  ⚠️ --set-checkbox 格式应为 "字段名:true/false"，跳过: ${s}`); continue; }
    const name = s.substring(0, idx).trim();
    const val = s.substring(idx + 1).trim().toLowerCase() === 'true';
    properties[name] = { type: 'checkbox', checkbox: val };
    hasUpdates = true;
  }

  // --set-text "字段名:内容"
  for (const s of opts.setText) {
    const idx = s.indexOf(':');
    if (idx === -1) { out(`  ⚠️ --set-text 格式应为 "字段名:内容"，跳过: ${s}`); continue; }
    const name = s.substring(0, idx).trim();
    const content = s.substring(idx + 1).trim();
    properties[name] = {
      type: 'rich_text',
      rich_text: [{ type: 'text', text: { content, link: null } }]
    };
    hasUpdates = true;
  }

  // 更新属性
  const body = {};
  if (Object.keys(properties).length > 0) body.properties = properties;
  if (opts.setIcon) { body.icon = { emoji: opts.setIcon }; hasUpdates = true; }
  if (opts.setCover) { body.cover = { external: { url: opts.setCover } }; hasUpdates = true; }

  if (!hasUpdates) {
    out('错误: --update-prop 需要至少一个更新项，如 --set-title / --set-select / --set-checkbox 等');
    out('用法: node flowus-write.js --update-prop <pageId> --set-title "新标题"');
    process.exit(1);
  }

  out(`\n📝 更新页面属性: ${pageId}`);
  if (body.properties) out(`  属性: ${Object.keys(body.properties).join(', ')}`);
  if (body.icon) out(`  图标: ${opts.setIcon}`);
  if (body.cover) out(`  封面: ${opts.setCover}`);

  try {
    const result = await rest.patch(`/pages/${pageId}`, body);
    out(`✅ 属性已更新`);
    return result;
  } catch (e) {
    out(`❌ 更新失败: ${e.message}`);
    process.exit(1);
  }
}

// ============== 删除模式 ==============

/**
 * 模式 E：--delete 删除页面或块
 * 需要 --force 确认
 */
async function modeDelete(opts) {
  const id = opts.deleteId;
  if (!id) {
    out('错误: --delete 需要页面/块 ID');
    process.exit(1);
  }

  if (!opts.force) {
    out(`\n⚠️  确认删除: ${id}`);
    out(`  此操作不可逆！`);
    out(`  请加 --force 确认执行`);
    process.exit(1);
  }

  out(`\n🗑️  删除: ${id}`);
  try {
    const result = await rest.del(`/blocks/${id}`);
    out(`✅ 已删除`);
    return result;
  } catch (e) {
    out(`❌ 删除失败: ${e.message}`);
    process.exit(1);
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

  // 配置
  rest.configure({ token: TOKEN });

  // 帮助
  if (!opts.filePath && !opts.textContent && !opts.rawBlocks && !opts.updatePropId && !opts.deleteId) {
    out(`
FlowUs 写入脚本 v3.0（双模式架构 + 属性更新 + 删除）

写入模式:
  默认模式: putMarkdown（原始 MD → 服务端解析，格式保真度最高）✅ 推荐
  --blocks:  REST 块模式（客户端构造 Block，精确控制块结构）

属性管理:
  --update-prop <pageId> --set-title "标题"    更新页面标题
  --update-prop <pageId> --set-select "状态:已完成"  更新 select 字段
  --update-prop <pageId> --set-checkbox "完成:true"  更新复选框
  --update-prop <pageId> --set-text "描述:内容"    更新富文本字段
  --update-prop <pageId> --set-icon "📝" --set-cover "url"  更新图标封面

删除:
  --delete <pageId/blockId> --force  删除页面或块（不可逆）

用法:
  node flowus-write.js <文件.md> [标题]           上传文件（默认 putMarkdown）
  node flowus-write.js --parent <id> <文件>       指定目标位置
  node flowus-write.js --parent-type page <文件>  父级为普通页面
  node flowus-write.js --update <文件> [标题]     更新已有页面
  node flowus-write.js --dry-run <文件>           只解析不写入

支持的 Markdown 格式:
  # ## ### 标题    **粗体** *斜体* \`代码\`
  \`\`\`代码块\`\`\`   > 引用   >! 标注   --- 分隔线
  - 无序列表   1. 有序列表   - [x] 待办   | 表格
  ![图片](url)  [书签](url)

环境变量:
  FLOWUS_TOKEN  授权码（必需）
`);
    process.exit(0);
  }

  // 分发
  if (opts.deleteId) {
    await modeDelete(opts);
  } else if (opts.updatePropId) {
    await modeUpdateProp(opts);
  } else if (opts.rawBlocks || opts.rawFilePath) {
    await modeWriteRaw(opts);
  } else if (opts.textContent !== null) {
    await modeWriteText(opts);
  } else if (opts.filePath) {
    await modeUploadFile(opts);
  }
}

main().catch(e => {
  console.error('\n❌ 错误:', e.message);
  process.exit(1);
});

