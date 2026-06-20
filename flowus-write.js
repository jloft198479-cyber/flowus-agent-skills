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
// MCP 不再需要：FlowUs MCP Server 不提供 API-putMarkdown 工具，写入统一用 REST 块模式

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
/** 默认父级数据库（可通过环境变量 FLOWUS_DEFAULT_PARENT 覆盖，或通过 --parent 指定） */
const DEFAULT_PARENT_DB = process.env.FLOWUS_DEFAULT_PARENT || '';

// ============== 日志 ==============
function log(msg) {
  try { process.stderr.write('[write] ' + msg + '\n'); } catch (_) { /* ignore */ }
}
function out(msg) {
  console.log(msg);
}

// ============== 帮助信息 ==============
const HELP_TEXT = `
FlowUs 写入脚本 v4.0（纯 REST 块模式 + 块编辑 + 文件上传 + 数据库管理）

写入模式:
  统一使用 REST 块模式（mdToBlocks + appendBlocks），不依赖 MCP

块级编辑:
  --edit-block <blockId> --text "新内容"    更新块内容（段落/标题/代码等）
  --edit-block <blockId> --checked true     更新待办块的勾选状态
  --delete-block <blockId> --force          删除单个块

文件上传:
  --upload <本地文件路径> --parent <pageId>  上传文件到页面（图片自动插入 image 块）

数据库管理:
  --create-db <pageId> --title "数据库名" --db-props '{"名称":{"type":"title"},"状态":{"type":"select"}}'
  --create-db <pageId> --title "数据库名" --db-props-file props.json --inline  创建行内数据库
  --update-db <dbId> --db-props '{"新字段":{"type":"rich_text"}}'  添加数据库属性
  --update-db <dbId> --db-props '{"旧字段":null}'  删除数据库属性（传 null）
  --update-db <dbId> --title "新名称" --description "描述"  更新标题和描述
  --update-db <dbId> --set-icon "🗂️" --set-cover "url"  更新图标封面
  --update-db <dbId> --restore  从回收站恢复已删除数据库
  --delete-db <dbId> --force               删除数据库

属性管理:
  --update-prop <pageId> --set-title "标题"    更新页面标题
  --update-prop <pageId> --set-select "状态:已完成"  更新 select 字段
  --update-prop <pageId> --set-checkbox "完成:true"  更新复选框
  --update-prop <pageId> --set-text "描述:内容"    更新富文本字段
  --update-prop <pageId> --set-icon "📝" --set-cover "url"  更新图标封面

删除:
  --delete <pageId/blockId> --force  删除页面或块（软删除，移入回收站可恢复）

用法:
  node flowus-write.js <文件.md> [标题]           上传文件
  node flowus-write.js --db <id> <文件> [标题]     指定目标数据库（--db 是 --parent 的别名）
  node flowus-write.js --db <id> --title "标题" --text "正文"  直接文本写入
  node flowus-write.js --parent-type page <文件>  父级为普通页面
  node flowus-write.js --update <文件> [标题]     更新已有页面
  node flowus-write.js --dry-run <文件>           只解析不写入

参数:
  --db <id>           目标数据库 ID（--parent 的别名）
  --title <标题>       页面标题
  --text <内容>        页面正文内容
  --icon <emoji>      页面图标
  --cover <url>       页面封面
  --db-props-file <文件>  从 JSON 文件读取数据库属性（避免 PowerShell 转义问题）
  --inline            创建行内数据库（is_inline: true）
  --token <授权码>     FlowUs 授权 token
  --help              显示此帮助信息

支持的 Markdown 格式:
  # ## ### 标题    **粗体** *斜体* \`代码\`
  \`\`\`代码块\`\`\`   > 引用   >! 标注   --- 分隔线
  - 无序列表   1. 有序列表   - [x] 待办   | 表格
  ![图片](url)  [书签](url)

Token:
  --token <授权码>  传入 token（优先级最高）
  FLOWUS_TOKEN      环境变量
  .env 文件         当前目录下 FLOWUS_TOKEN=xxx
`;

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
    // 块级编辑（--edit-block / --delete-block）
    editBlockId: null,  // --edit-block <blockId>
    deleteBlockId: null, // --delete-block <blockId>
    editBlockText: null, // --text 配合 --edit-block 使用
    editChecked: null,   // --checked true/false 配合 --edit-block 使用
    // 文件上传（--upload）
    uploadFilePath: null, // --upload <本地文件路径>
    // 数据库管理（--create-db / --update-db / --delete-db）
    createDbParentId: null, // --create-db <pageId>
    updateDbId: null,       // --update-db <dbId>
    deleteDbId: null,       // --delete-db <dbId>
    dbProps: null,          // --db-props <JSON>
    dbPropsFile: null,      // --db-props-file <文件路径>
    inlineDb: false,        // --inline（创建行内数据库）
    dbDescription: null,    // --description <描述>（更新数据库描述）
    dbRestore: false,       // --restore（恢复已删除的数据库，设置 in_trash: false）
    token: null,        // --token <授权码>
    help: false,        // --help
  };

  let positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--parent' || a === '--db') {
      opts.parentDbId = argv[++i];
    } else if (a === '--token') {
      opts.token = argv[++i] || '';
    } else if (a === '--parent-type') {
      opts.parentType = argv[++i];
    } else if (a === '--update') {
      opts.updateMode = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--blocks') {
      opts.blocksMode = true;
    } else if (a === '--text') {
      // PowerShell 中 \n 不会解释为换行符，需要手动转换
      const textVal = (argv[++i] || '').replace(/\\n/g, '\n');
      // --edit-block 模式下 --text 表示块内容更新
      if (opts.editBlockId) {
        opts.editBlockText = textVal;
      } else {
        opts.textContent = textVal;
      }
    } else if (a === '--title') {
      opts.title = argv[++i] || '';
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
    } else if (a === '--edit-block') {
      opts.editBlockId = argv[++i] || '';
    } else if (a === '--delete-block') {
      opts.deleteBlockId = argv[++i] || '';
    } else if (a === '--checked') {
      opts.editChecked = argv[++i] || '';
    } else if (a === '--upload') {
      opts.uploadFilePath = argv[++i] || '';
    } else if (a === '--create-db') {
      opts.createDbParentId = argv[++i] || '';
    } else if (a === '--update-db') {
      opts.updateDbId = argv[++i] || '';
    } else if (a === '--delete-db') {
      opts.deleteDbId = argv[++i] || '';
    } else if (a === '--db-props') {
      opts.dbProps = argv[++i] || '';
    } else if (a === '--db-props-file') {
      opts.dbPropsFile = argv[++i] || '';
    } else if (a === '--inline') {
      opts.inlineDb = true;
    } else if (a === '--description') {
      opts.dbDescription = argv[++i] || '';
    } else if (a === '--restore') {
      opts.dbRestore = true;
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
  'objective-c': 'Objective-C',
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
  '.toml', '.ini', '.cfg', '.conf', '.env', '.gitignore',
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
  // 创建时必须含 type: 'text'，否则 FlowUs API 会静默丢弃 content
  if (!annotations) {
    return { type: 'text', text: { content } };
  }
  // 显式需要格式化时附加 annotations
  const anno = { ...DEFAULT_ANNOTATIONS, ...annotations };
  if (!VALID_COLORS.has(anno.color)) anno.color = 'default';
  return {
    type: 'text',
    text: { content, link: null },
    annotations: anno,
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
 * 重要：FlowUs REST API 的写入格式使用 { object: "block", type, [typeName]: {...} }
 *   读取返回时服务端使用 { type, data: {...} } 格式
 *   写入时必须用类型名键（如 paragraph、heading_1），不能用 data 键
 *   使用 data 键时 API 不会报错，但会静默丢弃 rich_text 中的文本内容
 *
 * @param {string} type - 块类型（如 'paragraph', 'heading_1', 'code'）
 * @param {object} data - 块数据
 * @returns {object} { object: "block", type, [typeName]: data }
 */
function block(type, data) {
  return { object: 'block', type, [type]: data };
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
 * 预处理 Markdown：清洗 MDX/HTML 组件标签，保留纯 Markdown 内容
 *
 * 处理规则：
 * - MDX 提示组件（<Warning>, <Tip>, <Note> 等）→ 转为 callout 格式（>! ⚠️ 内容）
 * - 容器型 MDX 组件（<CardGroup>, <Card>, <Tabs>, <Tab> 等）→ 剥离标签，保留内部文本
 * - HTML 注释 → 移除
 * - 转义字符 \* \_ \# → 还原为 * _ #（代码块外）
 * - 代码块内不做任何处理
 */
function preprocessMd(md) {
  const lines = md.split(/\r?\n/);
  const result = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块边界跟踪——代码块内不做任何处理
    if (line.match(/^```/)) {
      inCodeBlock = !inCodeBlock;
      // 清洗代码块语言标识后的 MDX 属性（如 ```bash theme={null} → ```bash）
      if (!inCodeBlock) {
        result.push(line);
      } else {
        const cleanedLang = line
          .replace(/\\=/g, '=')                          // 还原转义的 =
          .replace(/\s+theme\s*=\s*\{[^}]*\}/g, '')      // theme={null}
          .replace(/\s+theme\s*=\s*\S+/g, '')             // theme=xxx（其他格式）
          .replace(/\s+title\s*=\s*"[^"]*"/g, '')         // title="xxx"
          .replace(/\s+title\s*=\s*\S+/g, '')             // title=xxx
          .replace(/\s+cols\s*=\s*\{[^}]*\}/g, '')        // cols={2}
          .replace(/\s+cols\s*=\s*\S+/g, '')              // cols=xxx
          .replace(/\s*\{[^}]*\}\s*$/, '')                // 残留 {...}
          .trim();
        result.push(cleanedLang);
      }
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // HTML 注释 → 移除
    if (line.match(/^<!--.*-->$/)) continue;
    if (line.match(/^<!--/)) {
      while (i < lines.length && !lines[i].match(/-->/)) i++;
      continue;
    }

    // MDX 提示组件 → 转为 callout（>! 格式）
    const calloutMatch = line.match(/^<(Warning|Tip|Note|Caution|Info|Danger)\s*>(.*)$/i);
    if (calloutMatch) {
      const type = calloutMatch[1];
      const rest = calloutMatch[2] ? calloutMatch[2].trim() : '';
      const iconMap = { Warning: '⚠️', Tip: '💡', Note: '📝', Caution: '🔴', Info: 'ℹ️', Danger: '🚨' };
      const icon = iconMap[type] || '📌';
      const contentLines = rest ? [rest] : [];
      while (i + 1 < lines.length && !lines[i + 1].match(new RegExp(`^</${type}>`, 'i'))) {
        i++;
        const inner = lines[i].replace(/<[^>]+>/g, '').trim();
        if (inner) contentLines.push(inner);
      }
      if (i + 1 < lines.length) i++; // 跳过 </Tag>
      result.push(`>! ${icon} ${contentLines.join(' ')}`);
      continue;
    }

    // MDX 容器组件 → 跳过（含复杂 JSX 属性的标签，直接按行跳过）
    if (line.match(/^<(CardGroup|Tabs|Steps|Accordion)\b/i)) continue;
    if (line.match(/^<\/(CardGroup|Tabs|Steps|Accordion|Card|Tab|Step|AccordionItem)>\s*$/i)) continue;
    if (line.match(/^\s*<Card\b/i)) continue;  // <Card 含复杂 JSX，整行跳过
    if (line.match(/^\s*<\/Card>\s*$/i)) continue;
    if (line.match(/^\s*<Tab\b/i)) continue;
    if (line.match(/^\s*<\/Tab>\s*$/i)) continue;
    // 多行 JSX 开标签（以 > 结尾的行，如 }>）
    if (line.match(/^\s*>\s*$/)) continue;

    // 其他行：移除残留 HTML/MDX 标签，还原转义字符
    let cleaned = line
      .replace(/<Card\b[^>]*>/gi, '')
      .replace(/<\/Card>/gi, '')
      .replace(/<Tab\b[^>]*>/gi, '')
      .replace(/<\/Tab>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*\}>\s*$/gm, '')  // JSX 闭标签残留 }>
      .replace(/\}>/g, '')            // 行内 }> 残留
      .trim();

    // 转义字符还原（代码块外）
    cleaned = cleaned.replace(/\\([*_#`~[\]()!|])/g, '$1');

    if (cleaned) result.push(cleaned);
  }

  return result.join('\n');
}

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
  // 预处理：清洗 MDX/HTML 标签，还原转义字符
  const cleaned = preprocessMd(md);
  const lines = cleaned.split(/\r?\n/);
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

    // ---- 6.6. 公式：单行块 $$...$$、行内 $...$、多行块 $$\n...\n$$ ----
    // 单行块公式 $$...$$（需在行内 $...$ 之前检查，避免误匹配）
    const singleBlockEq = line.match(/^\$\$(.+)\$\$$/);
    if (singleBlockEq) {
      blocks.push(block('equation', { expression: singleBlockEq[1] }));
      i++;
      continue;
    }
    // 行内公式 $...$
    const inlineEqMatch = line.match(/^\$(.+)\$$/);
    if (inlineEqMatch && !line.startsWith('$$')) {
      blocks.push(block('equation', { expression: inlineEqMatch[1] }));
      i++;
      continue;
    }
    // 多行块公式 $$ ... $$
    const blockEqStart = line.match(/^\$\$\s*$/);
    if (blockEqStart) {
      i++;
      const eqLines = [];
      while (i < lines.length && !lines[i].match(/^\$\$\s*$/)) {
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

    // ---- 10.5. 嵌入块 ![embed](url) 或 ![embed:caption](url) ----
    const embedMatch = line.match(/^!\[embed(?::([^\]]*))?\]\(([^)]+)\)\s*$/i);
    if (embedMatch) {
      blocks.push(block('embed', {
        url: embedMatch[2],
        caption: embedMatch[1] ? parseInline(embedMatch[1]) : [],
      }));
      i++; continue;
    }

    // ---- 10.6. 页面/数据库链接块 [page:页面ID](id) 或 [db:数据库ID](id) ----
    const linkMatch = line.match(/^\[(page|db|database):([^\]]+)\]\(([^)]+)\)\s*$/i);
    if (linkMatch) {
      const prefix = linkMatch[1].toLowerCase();
      const targetId = linkMatch[3];
      // link_to_page 根据前缀区分 page_id / database_id
      if (prefix === 'db' || prefix === 'database') {
        blocks.push(block('link_to_page', {
          type: 'database_id',
          database_id: targetId,
        }));
      } else {
        blocks.push(block('link_to_page', {
          type: 'page_id',
          page_id: targetId,
        }));
      }
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
  // 过滤分隔行（|---|---| 或 |:---:|:---:|）
  const dataLines = tblLines.filter(l => !/^[\s|:-]+$/.test(l));
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
    // 优先用 search API（精确匹配标题，无需全量拉取）
    const results = await rest.search(title, {
      pageSize: 10,
      filter: { value: 'page', property: 'object' },
    });

    for (const r of results) {
      const props = r.properties || {};
      const titleProp = props.title || props['标题'] || props.Name || props.name;
      if (!titleProp) continue;

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

    // search 未命中，fallback 到 queryDatabase（仅 database 父级有效）
    if (dbId) {
      try {
        const dbResults = await rest.queryDatabase(dbId);
        for (const r of dbResults) {
          const props = r.properties || {};
          const titleProp = props.title || props['标题'] || props.Name || props.name;
          if (!titleProp) continue;
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
      } catch (e2) {
        // database 查询失败（如父级是 page），静默忽略
      }
    }

    return null;
  } catch (e) {
    log(`查找页面失败: ${e.message.substring(0, 60)}`);
    return null;
  }
}

/**
 * 创建新页面（REST 版）
 *
 * 官方文档：POST /v2/pages
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
/**
 * 获取数据库中标题属性的实际名称
 * FlowUs V2 API 要求 properties 的 key 是数据库中的实际属性名（可能是中文），
 * 不能硬编码为 "title"
 */
async function _getTitlePropName(databaseId) {
  try {
    const db = await rest.get(`/databases/${databaseId}`);
    const props = db?.properties || {};
    for (const [name, def] of Object.entries(props)) {
      if (def.type === 'title') return name;
    }
  } catch (_) { /* fallback */ }
  return 'title'; // fallback 到默认值
}

/**
 * 自动检测父级类型（page 或 database）
 *
 * 当用户只传了 --parent <id> 但没指定 --parent-type 时调用。
 * 依次尝试 GET /pages/{id} 和 GET /databases/{id} 判断类型。
 *
 * @param {string} id - 父级 ID
 * @returns {Promise<'page'|'database'>} 默认 'database'
 */
async function detectParentType(id) {
  try {
    const r = await rest.get(`/pages/${id}`);
    if (r && r.id) {
      log(`  自动检测: ${id} 是页面 (page)`);
      return 'page';
    }
  } catch (_) { /* 不是 page */ }

  try {
    const r = await rest.get(`/databases/${id}`);
    if (r && r.id) {
      log(`  自动检测: ${id} 是数据库 (database)`);
      return 'database';
    }
  } catch (_) { /* 也不是 database */ }

  log(`  自动检测失败: ${id} 无法识别，默认按 database 处理`);
  return 'database';
}

async function createPage(options) {
  const { parentDbId, parentId, title, icon, coverUrl, parentType = 'database' } = options;

  // 构建请求体
  const body = {};

  // parent 可选：不传则创建到工作区根目录
  const effectiveParentId = parentType === 'page'
    ? (parentId || parentDbId)
    : parentDbId;

  if (effectiveParentId) {
    body.parent = parentType === 'page'
      ? { page_id: effectiveParentId }
      : { database_id: effectiveParentId };
  }

  // 可选：icon / cover
  if (icon) body.icon = { type: 'emoji', emoji: icon };
  if (coverUrl) body.cover = { type: 'external', external: { url: coverUrl } };

  // 标题处理：
  //   - database：通过 properties[titlePropName] 设置（属性名可能是中文）
  //   - page：FlowUs API 不接受 properties，创建后用 PATCH 设置标题
  if (parentType !== 'page') {
    let titlePropName = 'title';
    if (effectiveParentId) {
      titlePropName = await _getTitlePropName(effectiveParentId);
    }
    body.properties = {
      [titlePropName]: {
        type: 'title',
        title: [{ type: 'text', text: { content: title } }],
      },
    };
  }

  // 官方文档：POST /v2/pages 支持 Idempotency-Key 幂等创建
  // 相同 Idempotency-Key + 相同请求体 → 返回相同结果，避免重试导致重复创建
  // fallback：若 API 回归导致 500，去掉 header 重试一次，避免每次创建都失败
  const { randomUUID } = require('crypto');
  const idempotencyKey = randomUUID();
  let result;
  try {
    result = await rest.post('/pages', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  } catch (e) {
    if (e.message && e.message.includes('HTTP_500')) {
      result = await rest.post('/pages', body);
    } else {
      throw e;
    }
  }

  const pageId = result?.id || null;
  if (!pageId) {
    throw new Error(`创建页面失败: ${JSON.stringify(result).substring(0, 200)}`);
  }

  // parentType === 'page' 时，创建后用 PATCH 设置标题
  if (parentType === 'page' && title) {
    try {
      await rest.patch(`/pages/${pageId}`, {
        properties: {
          title: {
            type: 'title',
            title: [{ type: 'text', text: { content: title } }],
          },
        },
      });
    } catch (e) {
      log(`  ⚠️ 设置页面标题失败（页面已创建）: ${e.message.substring(0, 80)}`);
    }
  }

  return pageId;
}

/**
 * 更新页面属性（轻量更新，不重写块内容）
 *
 * 官方文档：PATCH /v2/pages/{page_id}
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
  if (updates.icon) body.icon = { type: 'emoji', emoji: updates.icon };
  if (updates.coverUrl) body.cover = { type: 'external', external: { url: updates.coverUrl } };
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
  const delayMs = options.delayMs || 300;
  let totalWritten = 0;

  // 按原始顺序逐段写入，table 块需要特殊处理（先创建 table，再追加 table_row）
  // 为了效率，将连续的非 table 块批量写入，遇到 table 则先刷出当前批次
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    // API 限制单次最多 100 个块，分批写入
    const BATCH_SIZE = 100;
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const chunk = batch.slice(i, i + BATCH_SIZE);
      try {
        const result = await rest.patch(`/blocks/${pageId}/children`, { children: chunk });
        totalWritten += result?.results?.length || 0;
        log(`  ✓ 写入 ${result?.results?.length || 0}/${chunk.length} 个块`);
      } catch (e) {
        log(`  ✗ 批次写入失败: ${e.message.substring(0, 100)}`);
        for (const b of chunk) {
          try {
            await rest.patch(`/blocks/${pageId}/children`, { children: [b] });
            totalWritten++;
          } catch (e2) {
            log(`    ✗ 单块写入失败 (${b.type}): ${e2.message.substring(0, 60)}`);
          }
          await rest.sleep(50);
        }
      }
      if (i + BATCH_SIZE < batch.length) await rest.sleep(delayMs);
    }
    batch = [];
    await rest.sleep(delayMs);
  }

  for (const b of blocks) {
    if (b.children && b.children.length > 0) {
      // 先刷出当前普通块批次
      await flushBatch();

      // 单独创建 table 块
      try {
        const tableBlock = { object: 'block', type: b.type, [b.type]: b.data };
        const createResult = await rest.patch(`/blocks/${pageId}/children`, { children: [tableBlock] });
        const tableId = createResult?.results?.[0]?.id;
        if (!tableId) {
          log(`  ✗ table 创建失败：未返回 ID`);
          continue;
        }
        totalWritten++;

        // 追加 table_row
        const rowBlocks = b.children.map(c => ({ object: 'block', type: c.type, [c.type]: c.data }));
        const rowResult = await rest.patch(`/blocks/${tableId}/children`, { children: rowBlocks });
        totalWritten += rowResult?.results?.length || 0;
        log(`  ✓ 表格: ${rowResult?.results?.length || 0} 行`);
      } catch (e) {
        log(`  ✗ 表格创建失败: ${e.message.substring(0, 100)}`);
      }
      await rest.sleep(delayMs);
    } else {
      batch.push(b);
    }
  }

  // 刷出剩余普通块
  await flushBatch();

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
 * 写入页面内容（REST 块模式）
 *
 * 策略：将 Markdown 转换为块结构，通过 REST API 追加到页面。
 * 不再使用 MCP putMarkdown（FlowUs MCP Server 不提供 API-putMarkdown 工具）。
 *
 * @param {string} pageId - 目标页面 ID
 * @param {string} markdownContent - Markdown 文本
 * @returns {Promise<void>}
 */
async function writeContent(pageId, markdownContent) {
  const blocks = mdToBlocks(markdownContent);
  if (blocks.length > 0) {
    await appendBlocks(pageId, blocks);
    log(`  ✓ REST 块模式写入 ${blocks.length} 个块`);
  }
}

// ============== 主流程模式 ==============

/**
 * 模式 A：上传文件（MD / 代码 / 其他）
 *
 * v3.0 双模式架构：
 *   - 默认（无 --blocks）：使用 putMarkdown（原始 MD → 服务端解析）
 *   - --blocks 标志：使用 REST appendBlockChildren（客户端 Block 构造）
 */
async function modeUploadMdFile(opts, token) {
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
    await writeContent(pageId, markdownContent);
    out(`\n✅ [混合模式] 完成！已发送 ${markdownContent.length} 字符（含表格后处理）`);
  }

  out(`📄 页面 ID: ${pageId}`);
  out(`🔗 https://flowus.cn/${pageId.replace(/-/g, '')}`);
}

/**
 * 模式 B：直接写入文本
 */
async function modeWriteText(opts, token) {
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
    // 非更新模式也先检查是否已存在，避免重复创建
    const canSearch = opts.parentType !== 'page';
    if (canSearch) pageId = await findPageByTitle(parentDbId, title);
    if (pageId) {
      out(`⚠️ 页面已存在 (${pageId})，将在末尾追加内容。如需替换请使用 --update`);
    } else {
      pageId = await createPage({ parentDbId, title, icon: opts.icon, coverUrl: opts.coverUrl, parentType: opts.parentType });
      out(`✅ 新建: ${pageId}`);
    }
  }

  if (opts.dryRun) {
    out(`\n[Dry Run] 将发送 ${text.length} 字符的 Markdown`);
    return;
  }

  // 使用 putMarkdown 混合模式（服务端解析，格式保真度最高）
  await rest.sleep(1500);
  await writeContent(pageId, text);
  out(`\n✅ 完成！已发送 ${text.length} 字符（含表格后处理）`);
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
      title: [{ type: 'text', text: { content: opts.setTitle } }],
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
      rich_text: [{ text: { content } }]
    };
    hasUpdates = true;
  }

  // 更新属性
  const body = {};
  if (Object.keys(properties).length > 0) body.properties = properties;
  if (opts.setIcon) { body.icon = { type: 'emoji', emoji: opts.setIcon }; hasUpdates = true; }
  if (opts.setCover) { body.cover = { type: 'external', external: { url: opts.setCover } }; hasUpdates = true; }

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
    out(`  此操作为软删除（移入回收站），可恢复。`);
    out(`  请加 --force 确认执行`);
    process.exit(1);
  }

  out(`\n🗑️  删除: ${id}`);
  try {
    // 直接用 deletePage，页面和块都适用（底层都是同一 API）
    const result = await rest.deletePage(id);
    const objType = result?.object === 'block' ? '块' : '页面';
    out(`✅ ${objType}已删除（移入回收站，可恢复）`);
    return result;
  } catch (e) {
    out(`❌ 删除失败: ${e.message}`);
    process.exit(1);
  }
}

// ============== 块级编辑模式 ==============

/**
 * 模式 F：--edit-block 更新单个块内容
 *
 * 官方文档：PATCH /v2/blocks/:block_id
 * 更新块使用类型名展开格式，如 { paragraph: { rich_text: [...] } }
 *
 * 支持：
 *   - --text "新内容"：更新段落/标题/代码块的文本
 *   - --checked true/false：更新待办块的勾选状态
 */
async function modeEditBlock(opts) {
  const blockId = opts.editBlockId;
  if (!blockId) {
    out('错误: --edit-block 需要块 ID');
    process.exit(1);
  }

  // 先获取块信息，确定块类型
  out(`\n✏️  编辑块: ${blockId}`);
  let blockInfo;
  try {
    blockInfo = await rest.getBlock(blockId);
  } catch (e) {
    out(`❌ 获取块信息失败: ${e.message}`);
    process.exit(1);
  }

  const blockType = blockInfo?.type;
  if (!blockType) {
    out(`❌ 无法确定块类型`);
    process.exit(1);
  }

  out(`  块类型: ${blockType}`);

  // 构建更新数据
  const updateData = {};

  if (opts.editBlockText !== null) {
    const text = opts.editBlockText;

    if (['paragraph', 'heading_1', 'heading_2', 'heading_3', 'quote', 'callout'].includes(blockType)) {
      updateData[blockType] = { rich_text: splitRichText(text) };
    } else if (blockType === 'code') {
      updateData[blockType] = { rich_text: [{ text: { content: text } }] };
    } else if (blockType === 'to_do') {
      updateData[blockType] = { rich_text: splitRichText(text) };
    } else {
      out(`⚠️  块类型 "${blockType}" 的文本更新暂不支持，尝试通用更新`);
      updateData[blockType] = { rich_text: splitRichText(text) };
    }
  }

  if (opts.editChecked !== null) {
    if (blockType === 'to_do') {
      const checked = opts.editChecked.toLowerCase() === 'true';
      updateData[blockType] = updateData[blockType] || {};
      updateData[blockType].checked = checked;
    } else {
      out(`⚠️  --checked 仅适用于 to_do 块，当前块类型: ${blockType}`);
    }
  }

  if (Object.keys(updateData).length === 0) {
    out('错误: --edit-block 需要至少一个更新项，如 --text "新内容" 或 --checked true');
    process.exit(1);
  }

  try {
    const result = await rest.updateBlock(blockId, updateData);
    out(`✅ 块已更新`);
    return result;
  } catch (e) {
    out(`❌ 更新失败: ${e.message}`);
    process.exit(1);
  }
}

/**
 * 模式 G：--delete-block 删除单个块
 *
 * 官方文档：DELETE /v2/blocks/:block_id
 * 软删除，块移入回收站可恢复
 */
async function modeDeleteBlock(opts) {
  const blockId = opts.deleteBlockId;
  if (!blockId) {
    out('错误: --delete-block 需要块 ID');
    process.exit(1);
  }

  if (!opts.force) {
    out(`\n⚠️  确认删除块: ${blockId}`);
    out(`  此操作为软删除（移入回收站），可恢复。`);
    out(`  请加 --force 确认执行`);
    process.exit(1);
  }

  out(`\n🗑️  删除块: ${blockId}`);
  try {
    const result = await rest.deleteBlock(blockId);
    out(`✅ 块已删除（移入回收站，可恢复）`);
    return result;
  } catch (e) {
    out(`❌ 删除失败: ${e.message}`);
    process.exit(1);
  }
}

// ============== 文件上传模式 ==============

/**
 * 模式 H：--upload 上传本地文件到 FlowUs 页面
 *
 * 官方文档：
 *   1. POST /v2/files/upload-url → 获取预签名 URL
 *   2. PUT 文件到预签名 URL
 *   3. 追加 image/file 块到页面
 *
 * 图片文件 → image 块（内联显示）
 * 其他文件 → file 块（附件形式）
 */
async function modeUploadFile(opts) {
  const filePath = opts.uploadFilePath;
  if (!filePath) {
    out('错误: --upload 需要文件路径');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    out(`错误: 文件不存在: ${resolvedPath}`);
    process.exit(1);
  }

  const parentDbId = opts.parentDbId || DEFAULT_PARENT_DB;
  if (!parentDbId) {
    out('错误: --upload 需要指定目标页面（--parent <pageId>）');
    process.exit(1);
  }

  const fileName = path.basename(resolvedPath);
  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);

  out(`\n📤 上传文件: ${resolvedPath}`);
  out(`📄 目标页面: ${parentDbId}`);
  out(`📝 类型: ${isImage ? '图片' : '文件'}`);

  try {
    // 上传文件
    const uploadResult = await rest.uploadFile({
      filePath: resolvedPath,
      pageId: parentDbId,
    });

    out(`✅ 文件已上传: ${uploadResult.file_url}`);

    // 追加对应的块到页面
    // 官方文档：创建文件、图片、音频或视频块时传 oss_name，不要把兼容字段 file_url 当作 external URL 使用
    let blockData;
    if (isImage) {
      blockData = {
        object: 'block',
        type: 'image',
        image: {
          type: 'file',
          file: { url: uploadResult.oss_name },
        },
      };
    } else {
      blockData = {
        object: 'block',
        type: 'file',
        file: {
          type: 'file',
          file: { url: uploadResult.oss_name },
        },
      };
    }

    const appendResult = await rest.patch(`/blocks/${parentDbId}/children`, { children: [blockData] });
    out(`✅ ${isImage ? '图片' : '文件'}块已追加到页面`);
    out(`📄 页面 ID: ${parentDbId}`);
    out(`🔗 https://flowus.cn/${parentDbId.replace(/-/g, '')}`);

    return appendResult;
  } catch (e) {
    out(`❌ 上传失败: ${e.message}`);
    process.exit(1);
  }
}

// ============== 数据库管理模式 ==============

/**
 * 模式 I：--create-db 创建数据库
 *
 * 官方文档：POST /v2/databases
 *   - parent: { page_id: 'xxx' }
 *   - title: [{ text: { content: '数据库名' } }]
 *   - properties: { 属性名: { type: 'title'/'select'/... } }
 */
async function modeCreateDb(opts) {
  const parentId = opts.createDbParentId;
  if (!parentId) {
    out('错误: --create-db 需要父页面 ID');
    process.exit(1);
  }

  const title = opts.title || '新数据库';
  let properties;
  const propsSource = opts.dbPropsFile || opts.dbProps;
  if (propsSource) {
    let propsJson;
    if (opts.dbPropsFile) {
      try {
        propsJson = fs.readFileSync(opts.dbPropsFile, 'utf-8');
      } catch (e) {
        out(`错误: --db-props-file 读取失败: ${e.message}`);
        process.exit(1);
      }
    } else {
      propsJson = opts.dbProps;
    }
    try {
      properties = JSON.parse(propsJson);
    } catch (e) {
      out(`错误: 数据库属性 JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
    // 补全 name 字段（官方文档要求每个属性含 name 字段）
    for (const [key, val] of Object.entries(properties)) {
      if (!val.name) val.name = key;
    }
  } else {
    // 默认属性：一个标题列
    properties = { '名称': { name: '名称', type: 'title' } };
  }

  out(`\n📊 创建数据库`);
  out(`📄 父页面: ${parentId}`);
  out(`📝 标题: ${title}`);
  out(`📋 属性: ${Object.keys(properties).join(', ')}`);
  if (opts.inlineDb) out(`📌 类型: 行内数据库 (is_inline)`);

  try {
    const result = await rest.createDatabase({
      parent: { page_id: parentId },
      title: [{ text: { content: title } }],
      properties,
      ...(opts.inlineDb ? { is_inline: true } : {}),
      ...(opts.icon ? { icon: { type: 'emoji', emoji: opts.icon } } : {}),
    });

    const dbId = result?.id;
    out(`✅ 数据库已创建: ${dbId}`);
    out(`🔗 https://flowus.cn/${(dbId || '').replace(/-/g, '')}`);
    return result;
  } catch (e) {
    out(`❌ 创建失败: ${e.message}`);
    process.exit(1);
  }
}

/**
 * 模式 J：--update-db 更新数据库 schema
 *
 * 官方文档：PATCH /v2/databases/:database_id
 *   - title: 更新标题
 *   - description: 更新描述
 *   - icon / cover: 更新图标封面
 *   - properties: 添加/修改属性；某个 schema 传 null 可删除该字段
 *   - in_trash: 切换回收站状态（--restore 恢复已删除数据库）
 */
async function modeUpdateDb(opts) {
  const dbId = opts.updateDbId;
  if (!dbId) {
    out('错误: --update-db 需要数据库 ID');
    process.exit(1);
  }

  const updates = {};
  if (opts.title) {
    updates.title = [{ text: { content: opts.title } }];
  }
  if (opts.dbDescription) {
    updates.description = [{ text: { content: opts.dbDescription } }];
  }
  if (opts.setIcon) {
    updates.icon = { type: 'emoji', emoji: opts.setIcon };
  }
  if (opts.setCover) {
    updates.cover = { type: 'external', external: { url: opts.setCover } };
  }
  if (opts.dbRestore) {
    // 恢复已删除的数据库（设置 in_trash: false）
    updates.in_trash = false;
  }
  const updatePropsSource = opts.dbPropsFile || opts.dbProps;
  if (updatePropsSource) {
    let updatePropsJson;
    if (opts.dbPropsFile) {
      try {
        updatePropsJson = fs.readFileSync(opts.dbPropsFile, 'utf-8');
      } catch (e) {
        out(`错误: --db-props-file 读取失败: ${e.message}`);
        process.exit(1);
      }
    } else {
      updatePropsJson = opts.dbProps;
    }
    try {
      updates.properties = JSON.parse(updatePropsJson);
      // 补全 name 字段（null 值表示删除该属性，跳过 name 补全）
      for (const [key, val] of Object.entries(updates.properties)) {
        if (val !== null && !val.name) val.name = key;
      }
    } catch (e) {
      out(`错误: 数据库属性 JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
  }

  if (Object.keys(updates).length === 0) {
    out('错误: --update-db 需要至少一个更新项（--title / --description / --db-props / --set-icon / --set-cover / --restore）');
    process.exit(1);
  }

  out(`\n📊 更新数据库: ${dbId}`);
  if (updates.title) out(`  标题: ${opts.title}`);
  if (updates.description) out(`  描述: ${opts.dbDescription}`);
  if (updates.icon) out(`  图标: ${opts.setIcon}`);
  if (updates.cover) out(`  封面: ${opts.setCover}`);
  if (updates.in_trash === false) out(`  恢复: 从回收站恢复`);
  if (updates.properties) {
    const propKeys = Object.keys(updates.properties);
    const deleteKeys = propKeys.filter(k => updates.properties[k] === null);
    const addKeys = propKeys.filter(k => updates.properties[k] !== null);
    if (addKeys.length) out(`  新属性/修改: ${addKeys.join(', ')}`);
    if (deleteKeys.length) out(`  删除属性: ${deleteKeys.join(', ')}`);
  }

  try {
    const result = await rest.updateDatabase(dbId, updates);
    out(`✅ 数据库已更新`);
    return result;
  } catch (e) {
    out(`❌ 更新失败: ${e.message}`);
    process.exit(1);
  }
}

/**
 * 模式 K：--delete-db 删除数据库
 *
 * 官方文档：DELETE /v2/databases/:database_id
 * 软删除，移入回收站可恢复
 */
async function modeDeleteDb(opts) {
  const dbId = opts.deleteDbId;
  if (!dbId) {
    out('错误: --delete-db 需要数据库 ID');
    process.exit(1);
  }

  if (!opts.force) {
    out(`\n⚠️  确认删除数据库: ${dbId}`);
    out(`  此操作为软删除（移入回收站），可恢复。`);
    out(`  请加 --force 确认执行`);
    process.exit(1);
  }

  out(`\n🗑️  删除数据库: ${dbId}`);
  try {
    const result = await rest.deleteDatabase(dbId);
    out(`✅ 数据库已删除（移入回收站，可恢复）`);
    return result;
  } catch (e) {
    out(`❌ 删除失败: ${e.message}`);
    process.exit(1);
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

  // 配置
  rest.configure({ token: token });

  // 自动检测父级类型：用户指定了 --parent 但没指定 --parent-type 时，
  // 自动 GET 检测是 page 还是 database，避免误判导致 properties 格式错误
  if (opts.parentDbId && !opts.parentType) {
    opts.parentType = await detectParentType(opts.parentDbId);
  }

  // 无操作模式时显示帮助
  if (!opts.filePath && !opts.textContent && !opts.rawBlocks && !opts.rawFilePath
      && !opts.updatePropId && !opts.deleteId
      && !opts.editBlockId && !opts.deleteBlockId
      && !opts.uploadFilePath
      && !opts.createDbParentId && !opts.updateDbId && !opts.deleteDbId) {
    out(HELP_TEXT.trim());
    process.exit(0);
  }

  // 分发
  if (opts.deleteDbId) {
    await modeDeleteDb(opts);
  } else if (opts.updateDbId) {
    await modeUpdateDb(opts);
  } else if (opts.createDbParentId) {
    await modeCreateDb(opts);
  } else if (opts.uploadFilePath) {
    await modeUploadFile(opts);
  } else if (opts.deleteBlockId) {
    await modeDeleteBlock(opts);
  } else if (opts.editBlockId) {
    await modeEditBlock(opts);
  } else if (opts.deleteId) {
    await modeDelete(opts);
  } else if (opts.updatePropId) {
    await modeUpdateProp(opts);
  } else if (opts.rawBlocks || opts.rawFilePath) {
    await modeWriteRaw(opts);
  } else if (opts.textContent !== null) {
    await modeWriteText(opts, token);
  } else if (opts.filePath) {
    await modeUploadMdFile(opts, token);
  }
}

main().catch(e => {
  console.error('\n❌ 错误:', e.message);
  process.exit(1);
});

