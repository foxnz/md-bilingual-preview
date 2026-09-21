'use strict';

/**
 * OpenAI 兼容接口的翻译客户端。
 *
 * 走的是同一个 /chat/completions，但中转站后面挂着不同厂商：gpt-* 转发到 OpenAI，
 * claude-* 转发到 Anthropic。两边认的可选参数不是一套（见 buildRequestBody），
 * 所以请求体按模型名挑着发，剩下的分歧靠 400 自动摘参数兜底。
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

/** 模型是不是 Anthropic 家的。中转站按模型名路由，claude-* 最终落到 Anthropic 接口。 */
function looksLikeAnthropicModel(model) {
  return /(^|[^a-z])claude([^a-z]|$)/i.test(model || '');
}

/**
 * Claude 也是推理模型，只是档位不同：Anthropic 最低一档是 low，没有 none。
 * 发 none 会被判成非法值直接 400，所以这里统一折成 low——翻译任务本来也不需要想。
 */
function applyReasoning(body, effort, model) {
  if (effort === 'off') return false;
  const anthropic = looksLikeAnthropicModel(model);
  let value = effort;
  if (effort === 'auto') {
    if (anthropic) value = 'low';
    else if (looksLikeReasoningModel(model)) value = 'none';
    else return false;
  }
  if (anthropic && value === 'none') value = 'low';
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

/**
 * 输出额度用尽的信号。OpenAI 写 finish_reason='length'，
 * 转发到 Anthropic 的网关常回 stop_reason='max_tokens'——两种都要认。
 */
function isTruncationReason(reason) {
  return reason === 'length' || reason === 'max_tokens';
}

/** 从一份（流式或非流式的）响应结构里找结束原因，找不到返回 undefined。 */
function finishReasonOf(parsed) {
  for (const path of [['choices', 0, 'finish_reason'], ['choices', 0, 'stop_reason'], ['stop_reason']]) {
    const reason = getPath(parsed, path);
    if (typeof reason === 'string' && reason) return reason;
  }
  return undefined;
}

function decodeEventStream(body) {
  const pieces = [];
  let finishReason;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') break;
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    // 结束原因通常在最后一个 chunk 上，后来的覆盖先前的
    const reason = finishReasonOf(parsed);
    if (reason) finishReason = reason;
    const delta = getPath(parsed, ['choices', 0, 'delta', 'content']);
    if (typeof delta === 'string' && delta) { pieces.push(delta); continue; }
    const msg = getPath(parsed, ['choices', 0, 'message', 'content']);
    if (typeof msg === 'string' && msg) pieces.push(msg);
  }
  return { content: pieces.join(''), finishReason };
}

/**
 * 输出额度不够时的话术。
 *
 * 这条单独拎出来是因为它最容易被误诊：被截断的响应是一段语法不合法的半截 JSON，
 * 不特判的话只会报「JSON 解析失败」，把人引去查响应格式，而真正要动的是 token 额度。
 */
const TRUNCATION_HINT =
  '响应被 max_tokens 截断了（服务端给的结束原因是 length/max_tokens），译文没写完。\n' +
  '调大 mdBilingual.maxResponseTokens——经验比例是不低于 mdBilingual.maxCharsPerBatch × 0.8，' +
  '或者反过来调小 mdBilingual.maxCharsPerBatch / maxSegmentsPerBatch。';

/**
 * @returns {{content: string, finishReason: string|undefined, truncated: boolean}}
 */
function decodeAssistantContent(body, contentType) {
  let content;
  let finishReason;

  if (looksLikeEventStream(contentType, body)) {
    ({ content, finishReason } = decodeEventStream(body));
    if (!content.trim()) {
      throw new TranslateError(isTruncationReason(finishReason)
        ? `服务端返回了流式响应，但没有任何内容。\n${TRUNCATION_HINT}`
        : '服务端返回了流式响应，但没有任何内容。');
    }
  } else {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) { throw new TranslateError(`服务端返回的不是合法 JSON：${e.message}`); }
    content = getPath(parsed, ['choices', 0, 'message', 'content']);
    finishReason = finishReasonOf(parsed);
    if (typeof content !== 'string' || !content.trim()) {
      throw new TranslateError(isTruncationReason(finishReason)
        ? `服务端响应里没有 assistant 消息内容。\n${TRUNCATION_HINT}`
        : '服务端响应里没有 assistant 消息内容。');
    }
  }

  return { content, finishReason, truncated: isTruncationReason(finishReason) };
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
 * 从半截 JSON 里捞出已经写完整的条目。
 *
 * 被 max_tokens 砍断的响应整体不合法，但断点之前的那些 {"id","text"} 都是完好的。
 * 整批丢掉太浪费——一批 40 段可能已经译完 30 段。逐字符扫描（认转义、认字符串里的
 * 花括号），凑齐一对就单独 JSON.parse 一次，解不动的那个（也就是被砍断的最后一个）跳过。
 */
function salvageTranslationItems(text) {
  const items = [];
  const anchor = text.indexOf('"translations"');
  if (anchor === -1) return items;
  const start = text.indexOf('[', anchor);
  if (start === -1) return items;

  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { items.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* 跳过这一条 */ }
        objStart = -1;
      }
      continue;
    }
    if (ch === ']' && depth === 0) break;   // 数组正常收尾
  }
  return items;
}

/**
 * 解析译文。缺失或多余的 id 不抛错——调用方对缺失的段落保留原文。
 *
 * @param {boolean} [options.truncated] 服务端说响应被截断了。此时整体解析必然失败，
 *   直接走抢救逻辑；一条都抢不出来才抛错，且话术要指向 maxResponseTokens。
 * @returns {{translations: Map<string,string>, missing: string[], truncated: boolean}}
 */
function parseTranslations(content, expectedIds, { truncated = false } = {}) {
  const candidate = (() => {
    try { return extractJsonObject(content); }
    catch (e) {
      if (truncated) throw new TranslateError(`译文一段都没写完。\n${TRUNCATION_HINT}`);
      throw e;
    }
  })();

  let items;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || !Array.isArray(parsed.translations)) {
      throw new TranslateError('响应里没有 translations 数组。');
    }
    items = parsed.translations;
  } catch (e) {
    items = salvageTranslationItems(candidate);
    if (!items.length) {
      if (truncated) throw new TranslateError(`译文一段都没写完。\n${TRUNCATION_HINT}`);
      if (e instanceof TranslateError) throw e;
      throw new TranslateError(`译文 JSON 解析失败：${e.message}`);
    }
  }

  const expected = new Set(expectedIds);
  const translations = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    if (!expected.has(item.id) || translations.has(item.id)) continue;
    translations.set(item.id, item.text.replace(/\s+$/, ''));
  }
  const missing = expectedIds.filter(id => !translations.has(id));
  return { translations, missing, truncated };
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

function buildErrorMessage(status, body, dropped) {
  const detail = providerDetail(body);
  if (status === 400) {
    const tried = dropped && dropped.length
      ? `\n已经依次去掉 ${dropped.join('、')} 重试过，仍然 400——问题不在这些可选参数上。` +
        `\n最可能是模型名写错了：确认 mdBilingual.model 在网关的模型清单里（node tools/probe.js 能列出来）。`
      : '';
    return (detail ? `请求失败（400）：${detail}` : '请求失败（400）。') + tried;
  }
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
 * 400 时按这个顺序逐个摘掉再试。都是可选参数，去掉只影响成本和稳定性，不影响译文正确性。
 * 顺序按「最可能不被接受」排：reasoning_effort 各家档位不统一，temperature 被 Anthropic
 * 新模型整个移除了，response_format 只有部分网关支持。
 */
const OPTIONAL_PARAMS = ['reasoning_effort', 'temperature', 'response_format'];

function dropOptionalParam(body) {
  for (const key of OPTIONAL_PARAMS) {
    if (key in body) {
      delete body[key];
      return key;
    }
  }
  return undefined;
}

/**
 * OpenAI 侧的新模型（gpt-5 系列、o 系列）不再接受 max_tokens，只认 max_completion_tokens，
 * 收到旧名字直接 400。这个参数不是可选的——摘掉等于放弃长度控制——所以改名而不是删掉。
 * 只在服务端报错里点了名时才改：中转站两种名字都可能认，主动改反而可能踩另一边的坑。
 */
function renameMaxTokens(body) {
  if (!('max_tokens' in body)) return undefined;
  body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
  return 'max_tokens→max_completion_tokens';
}

/**
 * 400 之后把请求改得更保守一点，返回这次改了什么；没有可改的了返回 undefined。
 * 先看服务端有没有点名 max_completion_tokens，没有才按固定顺序摘可选参数。
 */
function relaxRequestBody(body, detail) {
  if (/max_completion_tokens/i.test(detail || '')) {
    const renamed = renameMaxTokens(body);
    if (renamed) return renamed;
  }
  return dropOptionalParam(body);
}

function buildRequestBody(opts, blocks) {
  const body = {
    model: opts.model,
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
  // Anthropic 从 Claude 4.6 起把采样参数整个移除了，claude-* 收到 temperature 会直接 400，
  // 而 400 是不重试的状态码——一发就是硬失败。不发等于用模型自己的默认值，翻译不靠温度调。
  if (!looksLikeAnthropicModel(opts.model)) body.temperature = opts.temperature;
  if (opts.useJsonResponseFormat) body.response_format = { type: 'json_object' };
  applyReasoning(body, opts.reasoningEffort, opts.model);
  return body;
}

/**
 * 输出额度够不够装下一批的译文。事后看报错不如事前说一声——额度不足是必然失败，
 * 不是偶发问题，没必要等它跑一遍再来解释。
 *
 * 0.8 这个系数的来路：英文约 4 字符 1 token，译成中文 token 数大致与原文持平到 1.5 倍，
 * 再加上 JSON 的引号、id 和转义开销。取 0.8 是留了余量的保守线。
 *
 * @returns {string|undefined} 有问题时返回给用户看的话，没问题返回 undefined
 */
function budgetWarning(cfg) {
  const chars = Number(cfg.maxCharsPerBatch);
  const tokens = Number(cfg.maxResponseTokens);
  if (!Number.isFinite(chars) || !Number.isFinite(tokens)) return undefined;
  const needed = Math.ceil(chars * 0.8);
  if (tokens >= needed) return undefined;
  return `配置装不下：每批最多送 ${chars} 字符，但 mdBilingual.maxResponseTokens 只有 ${tokens}，` +
    `译文多半写不完就被截断。\n建议把 maxResponseTokens 调到 ${needed} 以上，` +
    `或把 maxCharsPerBatch 调到 ${Math.floor(tokens / 0.8)} 以下。`;
}

/**
 * 翻译一批段落。
 * @param {object} opts
 * @param {Array<{id:string, kind:string, text:string}>} blocks
 * @returns {Promise<{translations: Map<string,string>, missing: string[]}>}
 */
async function translateBatch(opts, blocks) {
  if (!blocks.length) return { translations: new Map(), missing: [] };

  const body = buildRequestBody(opts, blocks);
  const dropped = [];

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

      // 有的模型不认某个参数（claude 和 gpt 各有各的脾气），改一处立刻再试。
      // 每处只给一次机会，都不算入退避重试次数；改无可改还 400 就是真的请求不合法。
      while (!response.ok && response.status === 400) {
        const key = relaxRequestBody(body, providerDetail(text));
        if (!key) break;
        dropped.push(key);
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
      const { content, truncated } = decodeAssistantContent(text, response.headers.get('content-type'));
      return parseTranslations(content, blocks.map(b => b.id), { truncated });
    }

    lastError = new TranslateError(buildErrorMessage(response.status, text, dropped), response.status);
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
  budgetWarning,
  // 导出供测试
  parseTranslations,
  salvageTranslationItems,
  decodeAssistantContent,
  extractJsonObject,
  looksLikeReasoningModel,
  looksLikeAnthropicModel,
  applyReasoning,
  buildRequestBody,
  dropOptionalParam,
  relaxRequestBody,
  renameMaxTokens,
  isRetryable,
  retryAfterMs,
  backoffMs,
  buildErrorMessage,
  providerDetail,
};
