/**
 * FlowUs MCP 协议客户端
 *
 * 封装 FlowUs MCP Server (Streamable HTTP) 的通信细节：
 *   - Session 管理（initialize + session-id 复用）
 *   - 冷启动预热（指数退避）
 *   - 请求重试（指数退避，自动 re-init）
 *   - 统一 UTF-8 编码
 *
 * 依赖：仅 Node.js 内置模块（https）
 * 用法：
 *   const mcp = require('./lib/mcp-client');
 *   await mcp.warmUp();
 *   const result = await mcp.mcpCall('API-getPage', { page_id: 'xxx' });
 */

'use strict';

// ============== 编码设置 ==============
process.stdout.setDefaultEncoding('utf-8');
process.stderr.setDefaultEncoding('utf-8');

const https = require('https');

// ============== 配置 ==============
const DEFAULT_CONFIG = {
  /** MCP Server 主机名 */
  host: 'mcp.flowus.cn',
  /** API 路径模板，{token} 会被替换 */
  pathTemplate: '/message?token={token}',
  /** 预热重试次数 */
  warmupRetries: 3,
  /** 正式请求最大重试次数 */
  maxRetries: 5,
  /** 重试基础延迟（毫秒），后续按 2^n 递增 */
  baseDelayMs: 3000,
};

// ============== 内部状态 ==============
let _sessionId = '';
let _config = { ...DEFAULT_CONFIG };

/**
 * 日志输出到 stderr（不污染 stdout 的 JSON/文本数据）
 * @param {string} msg
 */
function log(msg) {
  try { process.stderr.write('[mcp] ' + msg + '\n'); } catch (_) { /* ignore */ }
}

// ============== 底层 HTTP 请求 ==============

/**
 * 发送原始 HTTP POST 请求到 MCP Server
 * @param {string} bodyStr - JSON 字符串
 * @returns {Promise<object>} 解析后的 JSON 响应
 * @throws {Error} 网络错误或 HTTP 5xx
 */
function _request(bodyStr) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr, 'utf-8'),
      'Accept': 'application/json, text/event-stream',
    };
    if (_sessionId) {
      headers['mcp-session-id'] = _sessionId;
    }

    const req = https.request({
      hostname: _config.host,
      path: _config.pathTemplate.replace('{token}', _config.token),
      method: 'POST',
      headers,
      timeout: 30000, // 30 秒超时
    }, (res) => {
      // 从响应头提取 session-id
      const sid = res.headers['mcp-session-id'];
      if (sid) _sessionId = sid;

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 502) {
          reject(new Error(`HTTP_${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON_PARSE_ERROR: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      // 将网络错误统一为 NETWORK_ERROR
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        reject(new Error('NETWORK_ERROR'));
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('REQUEST_TIMEOUT'));
    });

    req.write(bodyStr, 'utf-8');
    req.end();
  });
}

// ============== Session 管理 ==============

/**
 * 初始化 MCP Session（发送 initialize 请求）
 * 调用后会设置内部 _sessionId，后续请求自动携带
 * @returns {Promise<void>}
 */
async function initSession() {
  _sessionId = ''; // 清空旧 session
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: _config.clientName || 'flowus-client',
        version: _config.clientVersion || '1.0.0',
      },
    },
  });

  await _request(initBody);
}

/**
 * 预热：在正式调用前建立稳定的 MCP Session
 * 使用指数退避策略重试，给 MCP Server 冷启动时间
 *
 * @param {object} [options] - 可选配置覆盖
 * @param {number} [options.retries] - 预热重试次数，默认 3
 * @returns {Promise<boolean>} 是否预热成功
 */
async function warmUp(options = {}) {
  const retries = options.retries !== undefined ? options.retries : _config.warmupRetries;

  log('正在连接 FlowUs MCP Server...');

  for (let i = 0; i < retries; i++) {
    try {
      await initSession();
      log('Session 已建立');
      return true;
    } catch (e) {
      if (i < retries - 1) {
        const waitMs = _config.baseDelayMs * Math.pow(2, i);
        log(`  连接失败 (${e.message})，${(waitMs / 1000).toFixed(1)}s 后重试... (${i + 1}/${retries})`);
        await sleep(waitMs);
      } else {
        log(`  预热全部失败，将在主流程中继续重试: ${e.message}`);
        return false;
      }
    }
  }

  return false;
}

// ============== MCP 工具调用 ==============

/**
 * 调用 MCP 工具（核心方法）
 *
 * 自动处理：
 *   - JSON-RPC 2.0 协议封装
 *   - 响应内容解析（result.content[0].text → JSON）
 *   - 可恢复错误的自动重试（502/503/504/session 超时）
 *   - 不可恢复错误的直接抛出
 *
 * @param {string} toolName - 工具名称，如 'API-getPage'
 * @param {object} toolArgs - 工具参数
 * @param {number} [retries] - 最大重试次数，默认使用配置值
 * @returns {Promise<object>} 解析后的工具返回结果
 * @throws {Error} 所有重试耗尽后的最后一个错误
 */
async function mcpCall(toolName, toolArgs, retries) {
  const maxAttempts = retries !== undefined ? retries : _config.maxRetries;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs || {},
        },
      });

      const res = await _request(body);

      // 处理 MCP 层面的错误响应
      if (res.error) {
        const errMsg = typeof res.error === 'object' ? JSON.stringify(res.error) : String(res.error);
        const isRecoverable =
          errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('504') ||
          errMsg.includes('No valid session') || errMsg.includes('Session') ||
          errMsg.includes('timeout');

        if (attempt < maxAttempts && isRecoverable) {
          const waitMs = _config.baseDelayMs * Math.pow(2, attempt);
          log(`  [retry ${attempt + 1}/${maxAttempts + 1}] ${errMsg.substring(0, 80)} → ${(waitMs / 1000).toFixed(1)}s 后重新初始化...`);
          await initSession();
          await sleep(waitMs);
          continue;
        }
        throw new Error(`MCP_ERROR: ${errMsg}`);
      }

      // 解析正常的响应内容
      if (res.result && res.result.content && res.result.content[0]) {
        let parsed;
        try {
          parsed = JSON.parse(res.result.content[0].text);
        } catch (_) {
          // content 不是合法 JSON，返回原始 result
          return res.result;
        }

        // 检查工具返回值是否为错误对象（如 {object:"error", status:404}）
        if (parsed && parsed.object === 'error') {
          const errMsg = parsed.message || parsed.code || JSON.stringify(parsed).substring(0, 100);
          const isRecoverable = (parsed.status >= 500 && parsed.status < 600);

          if (attempt < maxAttempts && isRecoverable) {
            const waitMs = _config.baseDelayMs * Math.pow(2, attempt);
            log(`  [retry ${attempt + 1}/${maxAttempts + 1}] ToolError ${parsed.status}: ${errMsg.substring(0, 60)} → 重试...`);
            await initSession();
            await sleep(waitMs);
            continue;
          }
          throw new Error(`TOOL_ERROR(${parsed.status || '?'}): ${errMsg}`);
        }

        return parsed;
      }

      // 无 content 数组的情况（如 initialize 响应）
      return res;

    } catch (e) {
      const msg = e.message || String(e);

      // 网络层或 HTTP 层错误，可重试
      if (msg.startsWith('HTTP_') || msg === 'NETWORK_ERROR' || msg === 'REQUEST_TIMEOUT') {
        if (attempt < maxAttempts) {
          const waitMs = _config.baseDelayMs * Math.pow(2, attempt);
          log(`  [retry ${attempt + 1}/${maxAttempts + 1}] ${msg} → ${(waitMs / 1000).toFixed(1)}s 后重试...`);
          await initSession();
          await sleep(waitMs);
          continue;
        }
      }

      // 其他错误或重试耗尽
      if (attempt === maxAttempts) throw e;
      await sleep(_config.baseDelayMs * (attempt + 1));
    }
  }

  // 不应该到达这里，但 TypeScript 需要
  throw new Error('UNEXPECTED_STATE: mcpCall exited loop without result or error');
}

/**
 * 发送原始 JSON-RPC 请求（不走 tools/call 封装）
 * 用于 initialize、ping 等非工具类请求
 *
 * @param {string} method - JSON-RPC 方法名
 * @param {object} [params] - 参数
 * @returns {Promise<object>}
 */
async function rawCall(method, params) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params: params || {},
  });
  return _request(body);
}

// ============== 辅助函数 ==============

/**
 * 异步等待
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============== 配置管理 ==============

/**
 * 配置 MCP 客户端
 * @param {object} config
 * @param {string} config.token - FlowUs 授权码（必需）
 * @param {string} [config.host] - MCP Server 主机名
 * @param {string} [config.clientName] - 客户端标识名
 * @param {string} [config.clientVersion] - 客户端版本
 * @param {number} [config.maxRetries] - 最大重试次数
 * @param {number} [config.warmupRetries] - 预热重试次数
 * @param {number} [config.baseDelayMs] - 基础延迟毫秒数
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

/**
 * 重置 session（强制下次调用重新初始化）
 */
function resetSession() {
  _sessionId = '';
}

// ============== 导出 ==============
module.exports = {
  // 核心方法
  configure,
  getConfig,
  warmUp,
  initSession,
  resetSession,
  mcpCall,
  rawCall,

  // 辅助
  sleep,

  // 常量（供外部引用）
  DEFAULT_CONFIG,
};
