/**
 * FlowUs REST API 客户端
 *
 * 封装 FlowUs REST API (api.flowus.cn/v2) 的通信细节：
 *   - Bearer Token 认证
 *   - 自动分页（cursor 翻页，全量数据收集）
 *   - 错误处理和重试
 *   - 请求频率控制
 *
 * 依赖：仅 Node.js 内置模块（https）
 * 用法：
 *   const rest = require('./lib/rest-client');
 *   rest.configure({ token: 'your-token' });
 *   const page = await rest.get('/pages/xxx');
 *   const records = await rest.queryDatabase('db-id', { page_size: 100 });
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const https = require('https');

// ============== 配置 ==============
const DEFAULT_CONFIG = {
  /** REST API 主机名 */
  host: 'api.flowus.cn',
  /** API 基础路径 */
  basePath: '/v2',
  /** Bearer Token */
  token: '',
  /** 请求超时（毫秒） */
  timeout: 30000,
  /** GET 请求最大重试次数 */
  maxRetries: 3,
  /** 重试基础延迟（毫秒） */
  baseDelayMs: 2000,
};

// ============== 内部状态 ==============
let _config = { ...DEFAULT_CONFIG };

/**
 * 日志输出到 stderr
 * @param {string} msg
 */
function log(msg) {
  try { process.stderr.write('[rest] ' + msg + '\n'); } catch (_) { /* ignore */ }
}

// ============== 底层 HTTP 方法 ==============

/**
 * 构建完整 URL 路径
 * @param {string} path - API 路径，如 '/pages/xxx' 或 'pages/xxx'
 * @returns {string} 完整路径
 */
function _buildPath(path) {
  let p = path.startsWith('/') ? path : '/' + path;
  if (!p.startsWith(_config.basePath)) {
    p = _config.basePath + p;
  }
  return p;
}

/**
 * 构建认证请求头
 * @param {object} [extraHeaders] - 额外的请求头
 * @returns {object}
 */
function _buildHeaders(extraHeaders) {
  const headers = {
    'Authorization': `Bearer ${_config.token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(extraHeaders || {}),
  };
  return headers;
}

/**
 * 发送 HTTPS 请求的底层方法
 *
 * @param {string} method - HTTP 方法：GET / POST / PATCH / DELETE
 * @param {string} path - API 路径
 * @param {object} [options]
 * @param {object|string} [options.body] - 请求体（对象会自动 JSON.stringify）
 * @param {object} [options.headers] - 额外请求头
 * @param {object} [options.query] - URL 查询参数
 * @param {number} [options.timeout] - 单次超时
 * @returns {Promise<{status: number, body: object, headers: object}>}
 */
function _request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const apiPath = _buildPath(path);
    let urlPath = apiPath;

    // 处理查询参数
    if (options.query && Object.keys(options.query).length > 0) {
      const qs = Object.entries(options.query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      urlPath += (urlPath.includes('?') ? '&' : '?') + qs;
    }

    // 处理请求体
    let bodyStr = null;
    if (options.body) {
      bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const headers = _buildHeaders({
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr, 'utf-8') } : {}),
      ...(options.headers || {}),
    });

    const reqOptions = {
      hostname: _config.host,
      path: urlPath,
      method: method.toUpperCase(),
      headers,
      timeout: options.timeout || _config.timeout,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try {
          parsedBody = data ? JSON.parse(data) : {};
        } catch (e) {
          parsedBody = { raw: data.substring(0, 500) };
        }

        const result = {
          status: res.statusCode,
          body: parsedBody,
          headers: res.headers,
        };

        // HTTP 错误也返回结果，让调用方决定如何处理
        resolve(result);
      });
    });

    req.on('error', (err) => {
      reject(new Error(`NETWORK_ERROR: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('REQUEST_TIMEOUT'));
    });

    if (bodyStr) {
      req.write(bodyStr, 'utf-8');
    }
    req.end();
  });
}

// ============== 辅助函数 ==============

/**
 * 异步等待
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查响应是否为错误状态
 * @param {{status: number, body: object}} resp
 * @throws {Error} 当 status >= 400 时抛出描述性错误
 */
function _assertOk(resp) {
  if (resp.status >= 400) {
    const body = resp.body || {};
    const code = body.code || '';
    const errMsg = body.message || body.error || JSON.stringify(body).substring(0, 200);
    throw new Error(code ? `${code} (HTTP_${resp.status}): ${errMsg}` : `HTTP_${resp.status}: ${errMsg}`);
  }
}

/**
 * 带重试的 GET 请求
 * @param {string} path
 * @param {object} [query]
 * @param {number} [retries]
 * @returns {Promise<object>} 响应 body
 */
async function _getWithRetry(path, query, retries) {
  const maxAttempts = retries !== undefined ? retries : _config.maxRetries;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await _request('GET', path, { query });

      // 429 限流：优先使用 Retry-After 头
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers?.['retry-after'], 10);
        const waitMs = (retryAfter > 0 ? retryAfter * 1000 : _config.baseDelayMs * Math.pow(2, attempt));
        if (attempt < maxAttempts) {
          log(`  GET ${path} → 429 rate_limited, ${(waitMs / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${maxAttempts})`);
          await sleep(waitMs);
          continue;
        }
      }

      if (resp.status >= 500) {
        // 服务端错误可重试
        if (attempt < maxAttempts) {
          const waitMs = _config.baseDelayMs * Math.pow(2, attempt);
          log(`  GET ${path} → ${resp.status}, ${(waitMs / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${maxAttempts})`);
          await sleep(waitMs);
          continue;
        }
        _assertOk(resp);
      }
      _assertOk(resp);
      return resp.body;
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      const isRecoverable =
        e.message.includes('HTTP_5') ||
        e.message.includes('NETWORK_ERROR') ||
        e.message.includes('TIMEOUT');
      if (isRecoverable) {
        const waitMs = _config.baseDelayMs * Math.pow(2, attempt);
        log(`  GET ${path} 失败 (${e.message}), ${(waitMs / 1000).toFixed(1)}s 后重试...`);
        await sleep(waitMs);
      } else {
        throw e;
      }
    }
  }

  throw new Error('UNEXPECTED_STATE');
}

// ============== 公开 API ==============

/**
 * GET 请求
 *
 * @param {string} path - API 路径，如 '/pages/xxx' 或 'pages/xxx'
 * @param {object} [query] - 查询参数
 * @returns {Promise<object>} 响应体（已解析为对象）
 *
 * @example
 * const page = await rest.get('/pages/d6611d46-...');
 * const children = await rest.get('/blocks/pageId/children', { page_size: 100 });
 */
async function get(path, query) {
  return _getWithRetry(path, query);
}

/**
 * POST 请求
 *
 * @param {string} path - API 路径
 * @param {object} body - 请求体
 * @param {object} [options] - 额外选项
 * @param {object} [options.headers] - 额外请求头（注意：Idempotency-Key 当前会导致 500，勿用）
 * @returns {Promise<object>} 响应体
 *
 * @example
 * const results = await rest.post('/search', { query: '关键词', page_size: 20 });
 * const page = await rest.post('/pages', body);
 */
async function post(path, body, options = {}) {
  const resp = await _request('POST', path, { body, headers: options.headers });
  _assertOk(resp);
  return resp.body;
}

/**
 * PATCH 请求（用于更新资源）
 *
 * @param {string} path - API 路径
 * @param {object} body - 请求体
 * @returns {Promise<object>} 响应体
 *
 * @example
 * await rest.patch('/pages/pageId', {
 *   properties: { 状态: { type: 'select', select: { name: '已完成' } } }
 * });
 */
async function patch(path, body) {
  const resp = await _request('PATCH', path, { body });
  _assertOk(resp);
  return resp.body;
}

/**
 * DELETE 请求
 *
 * @param {string} path - API 路径
 * @returns {Promise<object>} 响应体
 */
async function del(path) {
  const resp = await _request('DELETE', path);
  _assertOk(resp);
  return resp.body;
}

// ============== 分页工具 ==============

/**
 * 分页获取所有子块（自动翻页）
 *
 * @param {string} blockId - 页面或块的 ID
 * @param {object} [options]
 * @param {number} [options.pageSize=100] - 每页数量
 * @param {number} [options.delayMs=150] - 翻页间隔（避免触发限流）
 * @returns {Promise<Array>} 所有子块数组
 *
 * @example
 * const blocks = await rest.getAllBlocks('page-id');
 */
async function getAllBlocks(blockId, options = {}) {
  const pageSize = options.pageSize || 100;
  const delayMs = options.delayMs || 150;
  const all = [];
  let cursor = null;

  do {
    const query = { page_size: pageSize };
    if (cursor) query.start_cursor = cursor;

    const resp = await _getWithRetry(`/blocks/${blockId}/children`, query);
    const results = resp.results || [];

    all.push(...results);
    cursor = resp.has_more ? resp.next_cursor : null;

    if (cursor) await sleep(delayMs);

    // 安全限制：最多翻 200 页
    if (all.length / pageSize > 200) {
      log(`  翻页超过 ${pageSize * 200} 条，停止翻页`);
      break;
    }
  } while (cursor);

  return all;
}

/**
 * 分页查询数据库记录（自动翻页，全量收集）
 *
 * @param {string} databaseId - 数据库 ID
 * @param {object} [filterBody] - 查询过滤条件（POST body）
 * @param {object} [options]
 * @param {number} [options.pageSize=100]
 * @param {number} [options.delayMs=150]
 * @returns {Promise<Array>} 所有记录数组
 *
 * @example
 * const records = await rest.queryDatabase('db-id', {
 *   filter: { property: 'status', select: { equals: '进行中' } }
 * });
 */
async function queryDatabase(databaseId, filterBody, options = {}) {
  const pageSize = options.pageSize || 100;
  const delayMs = options.delayMs || 150;
  const all = [];
  let cursor = null;

  do {
    const body = {
      ...(filterBody || {}),
      page_size: pageSize,
    };
    if (cursor) body.start_cursor = cursor;

    const resp = await post(`/databases/${databaseId}/query`, body);
    const results = resp.results || [];

    all.push(...results);
    cursor = resp.has_more ? resp.next_cursor : null;

    if (cursor) await sleep(delayMs);

    if (all.length / pageSize > 200) {
      log(`  翻页超过 ${pageSize * 200} 条，停止翻页`);
      break;
    }
  } while (cursor);

  return all;
}

/**
 * 全局搜索
 *
 * @param {string} query - 搜索关键词
 * @param {object} [options]
 * @param {number} [options.pageSize=20] - 每页结果数
 * @param {number} [options.maxPages=10] - 最大翻页数
 * @returns {Promise<Array>} 搜索结果页面数组
 *
 * @example
 * const results = await rest.search('项目计划', { pageSize: 50 });
 */
async function search(query, options = {}) {
  const pageSize = options.pageSize || 20;
  const maxPages = options.maxPages || 10;
  const all = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const body = { query, page_size: pageSize };
    if (cursor) body.start_cursor = cursor;
    // 可选过滤：按对象类型（page / database）
    if (options.filter) body.filter = options.filter;
    // 可选排序
    if (options.sort) body.sort = options.sort;

    const resp = await post('/search', body);
    const results = resp.results || [];

    all.push(...results);
    cursor = resp.has_more ? resp.next_cursor : null;

    if (!cursor) break;
  }

  return all;
}

/**
 * 获取当前 Token 对应的用户信息（连接验证）
 * 官方文档：GET /v2/users/me
 *
 * @returns {Promise<object>} { id, name, email, avatar_url, ... }
 */
async function me() {
  return get('/users/me');
}

/**
 * 以 Markdown 格式读取页面正文
 * 官方文档：GET /v2/pages/:page_id/content/markdown
 *
 * @param {string} pageId - 页面 ID
 * @returns {Promise<{page_id: string, markdown: string, last_edited_time: string}>}
 */
async function getPageMarkdown(pageId) {
  return get(`/pages/${pageId}/content/markdown`);
}

/**
 * 语义搜索（自然语言向量检索）
 * 官方文档：POST /v2/search/semantic
 *
 * @param {string} query - 自然语言查询
 * @param {object} [options]
 * @param {number} [options.pageSize=10] - 返回结果数量
 * @param {number} [options.scoreThreshold=0.0] - 相似度阈值
 * @param {string} [options.spaceId] - 指定空间 ID
 * @returns {Promise<Array>} search_result 数组，含 page_id/page_title/score/snippet/url
 */
async function semanticSearch(query, options = {}) {
  const body = {
    query,
    page_size: options.pageSize || 10,
  };
  if (options.scoreThreshold) body.score_threshold = options.scoreThreshold;
  if (options.spaceId) body.space_id = options.spaceId;

  const resp = await post('/search/semantic', body);
  // 语义搜索也支持分页，但通常结果较少，只取第一页
  // 如需全量可传 page_size 上限
  return resp.results || [];
}

/**
 * 删除页面（软删除，移入回收站）
 * 官方文档：DELETE /v2/pages/:page_id
 *
 * @param {string} pageId
 * @returns {Promise<object>} { object: "page", id, in_trash: true }
 */
async function deletePage(pageId) {
  return del(`/pages/${pageId}`);
}

/**
 * 删除块（软删除，子块一并移入回收站）
 * 官方文档：DELETE /v2/blocks/:block_id
 *
 * @param {string} blockId
 * @returns {Promise<object>} { object: "block", id, in_trash: true }
 */
async function deleteBlock(blockId) {
  return del(`/blocks/${blockId}`);
}

/**
 * 更新块内容（部分更新）
 * 官方文档：PATCH /v2/blocks/:block_id
 *
 * 注意：更新块使用类型名展开格式，不是 { type, data } 格式。
 * 例如更新段落块：{ paragraph: { rich_text: [...] } }
 *
 * @param {string} blockId
 * @param {object} data - 按块类型展开的部分更新内容（如 { paragraph: { rich_text: [...] } }）
 * @returns {Promise<object>} 更新后的 block 对象
 */
async function updateBlock(blockId, data) {
  return patch(`/blocks/${blockId}`, data);
}

/**
 * 获取文件上传地址
 * 官方文档：POST /v2/files/upload-url
 *
 * @param {object} params
 * @param {string} params.filename - 文件名
 * @param {string} params.contentType - MIME 类型
 * @param {number} params.contentLength - 文件大小（字节）
 * @param {string} params.pageId - 所属页面 ID
 * @returns {Promise<object>} { id, upload_url, oss_name, file_url, expiry_time, method, headers }
 */
async function getUploadUrl(params) {
  return post('/files/upload-url', {
    filename: params.filename,
    content_type: params.contentType,
    content_length: params.contentLength,
    parent: { type: 'page_id', page_id: params.pageId },
  });
}

/**
 * 获取单个块
 * 官方文档：GET /v2/blocks/:block_id
 *
 * @param {string} blockId
 * @returns {Promise<object>} block 对象
 */
async function getBlock(blockId) {
  return get(`/blocks/${blockId}`);
}

/**
 * 创建数据库
 * 官方文档：POST /v2/databases
 *
 * @param {object} params
 * @param {object} params.parent - { page_id: 'xxx' } 父页面
 * @param {string} params.title - 数据库标题（rich_text 格式）
 * @param {object} params.properties - 属性 schema 定义
 * @param {object} [params.icon] - 图标
 * @param {object} [params.cover] - 封面
 * @returns {Promise<object>} 创建的数据库对象
 */
async function createDatabase(params) {
  return post('/databases', params);
}

/**
 * 更新数据库 schema
 * 官方文档：PATCH /v2/databases/:database_id
 *
 * @param {string} databaseId
 * @param {object} updates - { title, properties, icon, cover } 中的一项或多项
 * @returns {Promise<object>} 更新后的数据库对象
 */
async function updateDatabase(databaseId, updates) {
  return patch(`/databases/${databaseId}`, updates);
}

/**
 * 删除数据库
 * 官方文档：DELETE /v2/databases/:database_id
 *
 * @param {string} databaseId
 * @returns {Promise<object>} { id, in_trash: true }
 */
async function deleteDatabase(databaseId) {
  return del(`/databases/${databaseId}`);
}

/**
 * 上传文件到 FlowUs（两步流程）
 * 1. 调用 getUploadUrl 获取预签名 URL
 * 2. PUT 文件内容到预签名 URL
 * 3. 返回 file_url 用于后续追加 image/file 块
 *
 * 官方文档：POST /v2/files/upload-url → PUT 到返回的 upload_url
 *
 * @param {object} params
 * @param {string} params.filePath - 本地文件路径
 * @param {string} params.pageId - 所属页面 ID
 * @param {string} [params.filename] - 文件名（默认取路径 basename）
 * @param {string} [params.contentType] - MIME 类型（默认自动检测）
 * @returns {Promise<{id: string, file_url: string, oss_name: string}>} 上传结果
 */
async function uploadFile(params) {
  const fs = require('fs');
  const filePath = params.filePath;
  const filename = params.filename || require('path').basename(filePath);

  // 自动检测 MIME 类型
  const MIME_MAP = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.csv': 'text/csv',
    '.zip': 'application/zip', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const ext = require('path').extname(filename).toLowerCase();
  const contentType = params.contentType || MIME_MAP[ext] || 'application/octet-stream';

  // 读取文件
  const fileBuffer = fs.readFileSync(filePath);
  const contentLength = fileBuffer.length;

  log(`上传文件: ${filename} (${contentLength} bytes, ${contentType})`);

  // 第 1 步：获取预签名 URL
  const uploadInfo = await getUploadUrl({
    filename,
    contentType,
    contentLength,
    pageId: params.pageId,
  });

  if (!uploadInfo?.upload_url) {
    throw new Error(`获取上传 URL 失败: ${JSON.stringify(uploadInfo).substring(0, 200)}`);
  }

  log(`  预签名 URL 已获取，上传中...`);

  // 第 2 步：PUT 文件到预签名 URL
  const uploadUrl = uploadInfo.upload_url;
  const uploadHeaders = uploadInfo.headers || {};

  await new Promise((resolve, reject) => {
    const urlObj = new URL(uploadUrl);
    const req = require('https').request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': contentLength,
        ...uploadHeaders,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`  上传成功 (HTTP ${res.statusCode})`);
          resolve();
        } else {
          reject(new Error(`上传失败: HTTP ${res.statusCode} ${body.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });

  return {
    id: uploadInfo.id,
    file_url: uploadInfo.file_url,
    oss_name: uploadInfo.oss_name,
  };
}

// ============== 配置管理 ==============

/**
 * 配置 REST 客户端
 * @param {object} config
 * @param {string} config.token - Bearer Token（必需）
 * @param {string} [config.host] - API 主机名
 * @param {string} [config.basePath] - API 基础路径
 * @param {number} [config.timeout] - 请求超时
 * @param {number} [config.maxRetries] - 最大重试次数
 * @param {number} [config.baseDelayMs] - 重试基础延迟
 */
function configure(config) {
  if (!config || !config.token) {
    throw new Error('configure() 必须提供 token');
  }
  _config = { ...DEFAULT_CONFIG, ...config };
}

/**
 * 获取当前配置（只读副本）
 * @returns {object}
 */
function getConfig() {
  return { ..._config };
}

// ============== 导出 ==============
module.exports = {
  // HTTP 方法
  get,
  post,
  patch,
  del,

  // 高级方法
  getAllBlocks,
  getBlock,
  queryDatabase,
  search,
  me,
  getPageMarkdown,
  semanticSearch,
  deletePage,
  deleteBlock,
  updateBlock,
  getUploadUrl,
  uploadFile,
  createDatabase,
  updateDatabase,
  deleteDatabase,

  // 配置
  configure,
  getConfig,

  // 辅助
  sleep,

  // 常量
  DEFAULT_CONFIG,
};
