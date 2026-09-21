'use strict';

/**
 * OpenAI 兼容接口的翻译客户端。
 *
 * 只读取内容、只发 HTTP 请求，不碰文件系统。
 */

class TranslateError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TranslateError';
    this.status = status;
  }
}

const SYSTEM_PROMPT = [
  'You translate Markdown blocks. You are given a JSON object with a target language and a list of blocks.',
  'Return ONLY a JSON object of this exact shape: {"translations":[{"id":"s1","text":"..."}]}.',
  'Translate every block. Each input id must appear exactly once. Never invent ids.',
  '',
  'Preserve Markdown structure exactly:',
  '- Keep heading markers (#, ##, ...), list markers (-, *, 1.), blockquote markers (>) and their indentation.',
  '- For tables, keep the same number of columns, the same pipe layout, and leave the delimiter row untouched.',
  '- Keep inline code spans (`like this`) verbatim — translate neither the backticks nor what is inside them.',
  '- Keep URLs, file paths, anchors and link destinations verbatim. Translate only the visible link text.',
  '- Keep identifiers, API names, HTTP verbs, field names, brand names and code tokens verbatim.',
  '- Keep emphasis markers (**bold**, *italic*) around the corresponding translated words.',
  '- Preserve line breaks inside a block. Do not merge a multi-line block into one line.',
  '',
  'Translate natural-language prose only. Do not add commentary, notes, or code fences around the JSON.',
].join('\n');

function looksLikeReasoningModel(model) {
  return /(^|[^a-z])(o[1-9]|gpt-5|codex|reason|thinking|deepseek-r)/i.test(model || '');
}

function applyReasoning(body, effort, model) {
  if (effort === 'off') return false;
  let value = effort;
  if (effort === 'auto') {
    if (!looksLikeReasoningModel(model)) return false;
    value = 'none';
  }
  body.reasoning_effort = value;
  return true;
}

function getPath(value, path) {
  let cur = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

function looksLikeEventStream(contentType, body) {
  if (contentType && contentType.includes('text/event-stream')) return true;
  return /^\s*data:\s/m.test(body);
}

function decodeEventStream(body) {
  const pieces = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') break;
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    const delta = getPath(parsed, ['choices', 0, 'delta', 'content']);
    if (typeof delta === 'string' && delta) { pieces.push(delta); continue; }
    const msg = getPath(parsed, ['choices', 0, 'message', 'content']);
    if (typeof msg === 'string' && msg) pieces.push(msg);
  }
  return pieces.join('');
}

function decodeAssistantContent(body, contentType) {
  if (looksLikeEventStream(contentType, body)) {
    const content = decodeEventStream(body);
    if (!content.trim()) throw new TranslateError('服务端返回了流式响应，但没有任何内容。');
    return content;
  }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { throw new TranslateError(`服务端返回的不是合法 JSON：${e.message}`); }
  const content = getPath(parsed, ['choices', 0, 'message', 'content']);
  if (typeof content !== 'string' || !content.trim()) {
    throw new TranslateError('服务端响应里没有 assistant 消息内容。');
  }
  return content;
}

function extractJsonObject(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new TranslateError('服务端响应里找不到 JSON 对象。');
  }
  return candidate.slice(first, last + 1);
}

/**
 * 解析译文。缺失或多余的 id 不抛错——调用方对缺失的段落保留原文。
 * @returns {{translations: Map<string,string>, missing: string[]}}
 */
function parseTranslations(content, expectedIds) {
  let parsed;
  try { parsed = JSON.parse(extractJsonObject(content)); }
  catch (e) {
    if (e instanceof TranslateError) throw e;
    throw new TranslateError(`译文 JSON 解析失败：${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.translations)) {
    throw new TranslateError('响应里没有 translations 数组。');
  }
  const expected = new Set(expectedIds);
  const translations = new Map();
  for (const item of parsed.translations) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    if (!expected.has(item.id) || translations.has(item.id)) continue;
    translations.set(item.id, item.text.replace(/\s+$/, ''));
  }
  const missing = expectedIds.filter(id => !translations.has(id));
  return { translations, missing };
}

/** 从响应体里抠出服务端给的人话。兼容 {error:{message}} 和 {code,message} 两种形状。 */
function providerDetail(body) {
  try {
    const parsed = JSON.parse(body);
    const nested = getPath(parsed, ['error', 'message']);
    if (typeof nested === 'string') return nested;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch { /* 落到下面按纯文本处理 */ }
  return body.trim().slice(0, 300) || undefined;
}

function buildErrorMessage(status, body) {
  const detail = providerDetail(body);
  if (status === 401 || status === 403) {
    return `鉴权失败（${status}）。你的 API Key 无效或已过期，用命令「Markdown 双语预览：设置 API Key」重设。${detail ? '\n服务端说：' + detail : ''}`;
  }
  if (status === 429) {
    return `服务端限流（429），已按退避策略重试过仍未成功。\n` +
      `这不是 key 的问题——key 无效会返回 401。是网关侧暂时没有可用配额。\n` +
      `可以：调小 mdBilingual.concurrency（建议 1）、调大 mdBilingual.maxRetries、` +
      `或换一个 mdBilingual.model 试试。${detail ? '\n服务端说：' + detail : ''}`;
  }
  return detail ? `请求失败（${status}）：${detail}` : `请求失败（${status}）。`;
}

/** 这些状态码值得重试：限流和服务端临时故障。 */
function isRetryable(status) {
  return status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** 服务端明确说了等多久就听它的。支持秒数和 HTTP 日期两种写法。 */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** 指数退避加抖动。抖动是为了避免多个并发批次在同一刻齐刷刷重试。 */
function backoffMs(attempt, baseMs, capMs) {
  const exponential = baseMs * Math.pow(2, attempt);
  return Math.min(capMs, exponential) + Math.floor(Math.random() * 500);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 发一次请求。每次尝试独享一份超时预算，重试不会把预算耗光。 */
async function postCompletion(opts, body) {
  const url = `${opts.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 翻译一批段落。
 * @param {object} opts
 * @param {Array<{id:string, kind:string, text:string}>} blocks
 * @returns {Promise<{translations: Map<string,string>, missing: string[]}>}
 */
async function translateBatch(opts, blocks) {
  if (!blocks.length) return { translations: new Map(), missing: [] };

  const body = {
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.maxResponseTokens,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          targetLanguage: opts.targetLanguage,
          blocks: blocks.map(b => ({ id: b.id, kind: b.kind, text: b.text })),
        }),
      },
    ],
  };
  if (opts.useJsonResponseFormat) body.response_format = { type: 'json_object' };
  let sentReasoning = applyReasoning(body, opts.reasoningEffort, opts.model);

  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 4;
  const baseMs = Number.isFinite(opts.retryBaseMs) ? opts.retryBaseMs : 2000;
  const capMs = Number.isFinite(opts.retryMaxDelayMs) ? opts.retryMaxDelayMs : 30000;
  const notify = typeof opts.onRetry === 'function' ? opts.onRetry : () => {};

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    let text;
    try {
      ({ response, text } = await postCompletion(opts, body));

      // 有的网关不认 reasoning_effort，去掉立刻再试一次（不算入重试次数）。
      if (!response.ok && response.status === 400 && sentReasoning) {
        delete body.reasoning_effort;
        sentReasoning = false;
        ({ response, text } = await postCompletion(opts, body));
      }
    } catch (error) {
      // 网络层失败和超时也值得重试
      const message = error && error.name === 'AbortError'
        ? `请求超时（${opts.requestTimeoutMs}ms）。可以调大 mdBilingual.requestTimeoutMs，或调小每批段落数。`
        : (error && error.message ? error.message : '未知的网络错误。');
      lastError = new TranslateError(message);
      if (attempt < maxRetries) {
        const wait = backoffMs(attempt, baseMs, capMs);
        notify({ attempt: attempt + 1, maxRetries, waitMs: wait, reason: message });
        await sleep(wait);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      const content = decodeAssistantContent(text, response.headers.get('content-type'));
      return parseTranslations(content, blocks.map(b => b.id));
    }

    lastError = new TranslateError(buildErrorMessage(response.status, text), response.status);
    if (!isRetryable(response.status) || attempt >= maxRetries) throw lastError;

    // 服务端说了等多久就听它的，没说就指数退避。
    // 但一律受 retryMaxDelayMs 夹制：限流的网关经常回一个很大的 Retry-After
    // （几百上千秒），照单全收会让插件静默睡死，界面看着和崩了没区别。
    // 截断后大概率还是 429，但那是一条能看见的失败，不是一个看不见的挂起。
    const asked = retryAfterMs(response);
    const wait = asked === undefined ? backoffMs(attempt, baseMs, capMs) : Math.min(asked, capMs);
    notify({
      attempt: attempt + 1,
      maxRetries,
      waitMs: wait,
      askedMs: asked !== undefined && asked > capMs ? asked : undefined,
      status: response.status,
      reason: providerDetail(text) || `HTTP ${response.status}`,
    });
    await sleep(wait);
  }

  throw lastError || new TranslateError('重试次数用尽。');
}

module.exports = {
  translateBatch,
  TranslateError,
  // 导出供测试
  parseTranslations,
  decodeAssistantContent,
  extractJsonObject,
  looksLikeReasoningModel,
  applyReasoning,
  isRetryable,
  retryAfterMs,
  backoffMs,
  buildErrorMessage,
  providerDetail,
};
