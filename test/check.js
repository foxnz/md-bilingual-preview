'use strict';

/**
 * 不依赖 VS Code 的自检：分段器、响应解析、渲染。
 * 跑法：node test/check.js [某个.md文件]
 */

const fs = require('fs');
const assert = require('assert');
const { segment, batch, hasProse } = require('../src/segment');
const {
  parseTranslations, decodeAssistantContent, looksLikeReasoningModel, applyReasoning,
  isRetryable, retryAfterMs, backoffMs, buildErrorMessage, providerDetail,
  looksLikeAnthropicModel, buildRequestBody, dropOptionalParam,
  salvageTranslationItems, relaxRequestBody, renameMaxTokens, budgetWarning,
  looksLikeDeepSeekModel,
} = require('../src/translate');
const { renderMarkdown } = require('../src/webview');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('\n— 分段器 —');

t('围栏代码块不翻译，且内容原样保留', () => {
  const blocks = segment('前言\n\n```js\nconst x = "英文不该被翻译";\n```\n\n后记');
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[1].kind, 'code');
  assert.strictEqual(blocks[1].translatable, false);
  assert.ok(blocks[1].text.includes('const x'));
  assert.strictEqual(blocks[0].translatable, true);
  assert.strictEqual(blocks[2].translatable, true);
});

t('代码块里的空行不会把它切开', () => {
  const blocks = segment('```py\na = 1\n\nb = 2\n```');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'code');
});

t('波浪号围栏同样识别', () => {
  const blocks = segment('~~~\nraw\n~~~');
  assert.strictEqual(blocks[0].kind, 'code');
});

t('围栏内的三反引号不会提前收尾', () => {
  const blocks = segment('````md\n```js\nx\n```\n````');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'code');
});

t('frontmatter 只认文件开头', () => {
  const top = segment('---\ntitle: Hello\n---\n\n正文');
  assert.strictEqual(top[0].kind, 'frontmatter');
  assert.strictEqual(top[0].translatable, false);
  const mid = segment('正文\n\n---\n\n更多');
  assert.ok(mid.every(b => b.kind !== 'frontmatter'));
});

t('分隔线不当成正文', () => {
  const blocks = segment('a\n\n---\n\nb');
  const rule = blocks.find(b => b.kind === 'rule');
  assert.ok(rule);
  assert.strictEqual(rule.translatable, false);
});

t('表格识别为整块', () => {
  const blocks = segment('| Name | Meaning |\n| --- | --- |\n| id | the id |');
  assert.strictEqual(blocks[0].kind, 'table');
  assert.strictEqual(blocks[0].translatable, true);
});

t('标题、列表、引用各归各类', () => {
  assert.strictEqual(segment('## Hello')[0].kind, 'heading');
  assert.strictEqual(segment('- one\n- two')[0].kind, 'list');
  assert.strictEqual(segment('> quoted')[0].kind, 'quote');
});

t('纯 URL / 链接定义不送翻译', () => {
  assert.strictEqual(segment('[ref]: https://example.com/a')[0].translatable, false);
  assert.strictEqual(hasProse('https://example.com/some/path'), false);
  assert.strictEqual(hasProse('`justCode`'), false);
  assert.strictEqual(hasProse('See `code` here'), true);
});

t('HTML 注释不翻译', () => {
  assert.strictEqual(segment('<!-- TODO: fix this -->')[0].translatable, false);
});

t('hash 只跟内容有关，可用于缓存', () => {
  const a = segment('同一段文字')[0];
  const b = segment('同一段文字')[0];
  assert.strictEqual(a.hash, b.hash);
  assert.notStrictEqual(a.hash, segment('不同的文字')[0].hash);
});

t('分批同时受段数和字符数约束', () => {
  const segs = Array.from({ length: 10 }, (_, i) => ({ text: 'x'.repeat(100), index: i }));
  assert.strictEqual(batch(segs, 3, 100000).length, 4);
  assert.strictEqual(batch(segs, 100, 250).length, 5);
  assert.strictEqual(batch([], 10, 100).length, 0);
});

console.log('\n— 响应解析 —');

t('正常 JSON', () => {
  const { translations, missing } = parseTranslations('{"translations":[{"id":"s1","text":"你好"}]}', ['s1']);
  assert.strictEqual(translations.get('s1'), '你好');
  assert.strictEqual(missing.length, 0);
});

t('被代码围栏包住的 JSON 也能解出来', () => {
  const { translations } = parseTranslations('```json\n{"translations":[{"id":"s1","text":"你好"}]}\n```', ['s1']);
  assert.strictEqual(translations.get('s1'), '你好');
});

t('前后有废话时仍能定位 JSON', () => {
  const { translations } = parseTranslations('好的：\n{"translations":[{"id":"s1","text":"你好"}]}\n希望有用', ['s1']);
  assert.strictEqual(translations.get('s1'), '你好');
});

t('缺 id 不抛错，报告到 missing（预览降级显示原文）', () => {
  const { translations, missing } = parseTranslations('{"translations":[{"id":"s1","text":"你好"}]}', ['s1', 's2']);
  assert.strictEqual(translations.size, 1);
  assert.deepStrictEqual(missing, ['s2']);
});

t('多余 / 重复 id 被忽略', () => {
  const { translations } = parseTranslations(
    '{"translations":[{"id":"s1","text":"甲"},{"id":"s1","text":"乙"},{"id":"s9","text":"丙"}]}', ['s1']);
  assert.strictEqual(translations.size, 1);
  assert.strictEqual(translations.get('s1'), '甲');
});

t('多行译文保留换行（列表/表格靠这个不塌）', () => {
  const { translations } = parseTranslations('{"translations":[{"id":"s1","text":"- 甲\\n- 乙"}]}', ['s1']);
  assert.strictEqual(translations.get('s1'), '- 甲\n- 乙');
});

t('非 JSON 响应抛出可读错误', () => {
  assert.throws(() => parseTranslations('服务器炸了', ['s1']), /找不到 JSON 对象/);
});

t('普通 JSON 响应体解码', () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'hi' } }] });
  const out = decodeAssistantContent(body, 'application/json');
  assert.strictEqual(out.content, 'hi');
  assert.strictEqual(out.truncated, false);
});

t('SSE 流式响应解码并拼接', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: [DONE]',
  ].join('\n');
  assert.strictEqual(decodeAssistantContent(sse, 'text/event-stream').content, '你好');
});

t('没声明 content-type 的 SSE 也能认出来', () => {
  const sse = 'data: {"choices":[{"delta":{"content":"x"}}]}\ndata: [DONE]';
  assert.strictEqual(decodeAssistantContent(sse, null).content, 'x');
});

console.log('\n— 输出被截断 —');

t('finish_reason=length 认成截断', () => {
  const body = JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"trans' } }] });
  assert.strictEqual(decodeAssistantContent(body, 'application/json').truncated, true);
});

t('转发 Anthropic 的 stop_reason=max_tokens 同样认', () => {
  const body = JSON.stringify({ stop_reason: 'max_tokens', choices: [{ message: { content: 'x' } }] });
  assert.strictEqual(decodeAssistantContent(body, 'application/json').truncated, true);
});

t('正常收尾的 stop 不算截断', () => {
  const body = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] });
  assert.strictEqual(decodeAssistantContent(body, 'application/json').truncated, false);
});

t('SSE 的截断信号在最后一个 chunk 上，也要读到', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"半"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    'data: [DONE]',
  ].join('\n');
  const out = decodeAssistantContent(sse, 'text/event-stream');
  assert.strictEqual(out.content, '半');
  assert.strictEqual(out.truncated, true);
});

t('截断且一个字都没有时，报错要指向 maxResponseTokens', () => {
  const body = JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
  assert.throws(() => decodeAssistantContent(body, 'application/json'), /maxResponseTokens/);
});

t('半截 JSON 里已写完的条目要抢救出来，不是整批丢', () => {
  const cut = '{"translations":[{"id":"s1","text":"第一段"},{"id":"s2","text":"第二段"},{"id":"s3","text":"第三段没写完';
  const { translations, missing, truncated } = parseTranslations(cut, ['s1', 's2', 's3'], { truncated: true });
  assert.strictEqual(translations.get('s1'), '第一段');
  assert.strictEqual(translations.get('s2'), '第二段');
  assert.deepStrictEqual(missing, ['s3'], '没写完的那段走 missing，调用方保留原文');
  assert.strictEqual(truncated, true);
});

t('抢救时不被译文里的花括号和转义引号带偏', () => {
  const cut = '{"translations":[{"id":"s1","text":"用 {} 包起来，并写成 \\"这样\\""},{"id":"s2","text":"断';
  const items = salvageTranslationItems(cut);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 's1');
  assert.ok(items[0].text.includes('{}'));
});

t('截断且一条都抢不出来时，话术指向 maxResponseTokens 而不是 JSON 格式', () => {
  assert.throws(
    () => parseTranslations('{"translations":[{"id":"s1","text":"刚开头就断', ['s1'], { truncated: true }),
    /maxResponseTokens/);
});

t('没截断时，坏 JSON 照旧报格式错误（别把所有失败都赖给 token）', () => {
  assert.throws(() => parseTranslations('{"nope":1}', ['s1']), /没有 translations 数组/);
  assert.throws(() => parseTranslations('服务器炸了', ['s1']), /找不到 JSON 对象/);
});

console.log('\n— reasoning_effort —');

t('识别推理模型', () => {
  assert.ok(looksLikeReasoningModel('gpt-5.3-codex-spark'));
  assert.ok(looksLikeReasoningModel('o3-mini'));
  assert.ok(!looksLikeReasoningModel('gpt-4o-mini'));
});

t('auto 只对推理模型发参数', () => {
  const a = {};
  assert.strictEqual(applyReasoning(a, 'auto', 'gpt-5.3-codex-spark'), true);
  assert.strictEqual(a.reasoning_effort, 'none');
  const b = {};
  assert.strictEqual(applyReasoning(b, 'auto', 'gpt-4o-mini'), false);
  assert.strictEqual(b.reasoning_effort, undefined);
});

t('off 一律不发', () => {
  const body = {};
  assert.strictEqual(applyReasoning(body, 'off', 'gpt-5.3-codex-spark'), false);
  assert.strictEqual(body.reasoning_effort, undefined);
});

console.log('\n— claude 模型 —');

t('按模型名认出 Anthropic', () => {
  assert.ok(looksLikeAnthropicModel('claude-sonnet-5'));
  assert.ok(looksLikeAnthropicModel('claude-opus-5'));
  assert.ok(looksLikeAnthropicModel('anthropic/claude-haiku-4-5'));
  assert.ok(!looksLikeAnthropicModel('gpt-5.3-codex-spark'));
  assert.ok(!looksLikeAnthropicModel('claudette-v2'), '只是名字里有 claude 的别家模型不算');
});

t('auto 对 claude 发 low（Anthropic 没有 none 这一档）', () => {
  const body = {};
  assert.strictEqual(applyReasoning(body, 'auto', 'claude-sonnet-5'), true);
  assert.strictEqual(body.reasoning_effort, 'low');
});

t('显式 none 撞上 claude 时折成 low，而不是发出去换一个 400', () => {
  const body = {};
  applyReasoning(body, 'none', 'claude-opus-5');
  assert.strictEqual(body.reasoning_effort, 'low');
});

t('claude 上的其余档位原样发送', () => {
  const body = {};
  applyReasoning(body, 'high', 'claude-opus-5');
  assert.strictEqual(body.reasoning_effort, 'high');
});

const BLOCK = [{ id: 's1', kind: 'paragraph', text: 'hello' }];
const OPTS = { targetLanguage: 'Simplified Chinese', temperature: 1, maxResponseTokens: 4000, reasoningEffort: 'auto' };

t('claude 的请求体不带 temperature（Anthropic 新模型收到就 400）', () => {
  const body = buildRequestBody({ ...OPTS, model: 'claude-sonnet-5' }, BLOCK);
  assert.ok(!('temperature' in body));
  assert.strictEqual(body.max_tokens, 4000);
  assert.strictEqual(body.messages.length, 2);
});

t('OpenAI 侧照旧带 temperature', () => {
  const body = buildRequestBody({ ...OPTS, model: 'gpt-5.3-codex-spark' }, BLOCK);
  assert.strictEqual(body.temperature, 1);
  assert.strictEqual(body.reasoning_effort, 'none');
});

t('json mode 只在开启时出现', () => {
  const off = buildRequestBody({ ...OPTS, model: 'claude-sonnet-5' }, BLOCK);
  assert.ok(!('response_format' in off));
  const on = buildRequestBody({ ...OPTS, model: 'claude-sonnet-5', useJsonResponseFormat: true }, BLOCK);
  assert.deepStrictEqual(on.response_format, { type: 'json_object' });
});

t('400 时按固定顺序逐个摘掉可选参数', () => {
  const body = buildRequestBody(
    { ...OPTS, model: 'gpt-5.3-codex-spark', useJsonResponseFormat: true }, BLOCK);
  assert.strictEqual(dropOptionalParam(body), 'reasoning_effort');
  assert.strictEqual(dropOptionalParam(body), 'temperature');
  assert.strictEqual(dropOptionalParam(body), 'response_format');
  assert.strictEqual(dropOptionalParam(body), undefined, '摘光了要停下来，不能死循环');
  assert.strictEqual(body.model, 'gpt-5.3-codex-spark', '必填字段不许动');
  assert.ok(Array.isArray(body.messages));
});

t('服务端点名 max_completion_tokens 时改名而不是删掉', () => {
  const body = buildRequestBody({ ...OPTS, model: 'gpt-5.3-codex-spark' }, BLOCK);
  const detail = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
  assert.strictEqual(relaxRequestBody(body, detail), 'max_tokens→max_completion_tokens');
  assert.ok(!('max_tokens' in body));
  assert.strictEqual(body.max_completion_tokens, 4000, '额度要原样搬过去，不能丢');
});

t('改过名之后不会反复改，接着摘可选参数', () => {
  const body = buildRequestBody({ ...OPTS, model: 'gpt-5.3-codex-spark' }, BLOCK);
  const detail = 'Use max_completion_tokens instead.';
  relaxRequestBody(body, detail);
  assert.strictEqual(relaxRequestBody(body, detail), 'reasoning_effort', '第二次要往下走，不能死循环');
  assert.strictEqual(renameMaxTokens(body), undefined);
});

t('服务端没提这事就别动 max_tokens（中转站两种名字都可能认）', () => {
  const body = buildRequestBody({ ...OPTS, model: 'gpt-5.3-codex-spark' }, BLOCK);
  assert.strictEqual(relaxRequestBody(body, 'some other 400'), 'reasoning_effort');
  assert.strictEqual(body.max_tokens, 4000);
});

t('摘光仍 400 时，报错要指向模型名而不是参数', () => {
  const msg = buildErrorMessage(400, '{"error":{"message":"model not found"}}',
    ['reasoning_effort', 'temperature']);
  assert.ok(msg.includes('model not found'));
  assert.ok(msg.includes('mdBilingual.model'));
});

console.log('\n— DeepSeek —');

t('按模型名认出 DeepSeek', () => {
  assert.ok(looksLikeDeepSeekModel('deepseek-flash'));
  assert.ok(looksLikeDeepSeekModel('deepseek-v4-pro'));
  assert.ok(!looksLikeDeepSeekModel('gpt-5.3-codex-spark'));
  assert.ok(!looksLikeDeepSeekModel('claude-sonnet-5'));
});

t('auto 显式关掉思考（默认是开的，不发 = 全力思考）', () => {
  const body = buildRequestBody({ ...OPTS, model: 'deepseek-flash' }, BLOCK);
  assert.deepStrictEqual(body.thinking, { type: 'disabled' });
  assert.ok(!('reasoning_effort' in body), '关掉之后再发强度没有意义');
});

t('none 同样是关掉，不是发 reasoning_effort=none', () => {
  const body = {};
  applyReasoning(body, 'none', 'deepseek-flash');
  assert.deepStrictEqual(body.thinking, { type: 'disabled' });
  assert.strictEqual(body.reasoning_effort, undefined,
    'DeepSeek 的 reasoning_effort 只管强度，关不掉思考');
});

t('明确要思考时才打开开关并带上强度', () => {
  const body = {};
  applyReasoning(body, 'high', 'deepseek-flash');
  assert.deepStrictEqual(body.thinking, { type: 'enabled' });
  assert.strictEqual(body.reasoning_effort, 'high');
});

t('off 在 DeepSeek 上什么都不发（等于用服务端默认，也就是思考全开）', () => {
  const body = {};
  assert.strictEqual(applyReasoning(body, 'off', 'deepseek-flash'), false);
  assert.ok(!('thinking' in body));
  assert.ok(!('reasoning_effort' in body));
});

t('DeepSeek 照常带 temperature（关掉思考后这参数才生效）', () => {
  const body = buildRequestBody({ ...OPTS, model: 'deepseek-flash' }, BLOCK);
  assert.strictEqual(body.temperature, 1);
  assert.strictEqual(body.max_tokens, 4000, 'DeepSeek 用的是 max_tokens，不是 max_completion_tokens');
});

t('400 兜底能摘掉 thinking（别家网关不认这个参数）', () => {
  const body = buildRequestBody({ ...OPTS, model: 'deepseek-flash' }, BLOCK);
  assert.strictEqual(dropOptionalParam(body), 'thinking', 'reasoning_effort 不在体内，直接轮到它');
  assert.strictEqual(dropOptionalParam(body), 'temperature');
});

console.log('\n— 限流重试 —');

t('429 和 5xx 重试，4xx 不重试', () => {
  assert.ok(isRetryable(429));
  assert.ok(isRetryable(503));
  assert.ok(isRetryable(500));
  assert.ok(!isRetryable(401), '401 是 key 的问题，重试没意义');
  assert.ok(!isRetryable(400));
  assert.ok(!isRetryable(404));
});

t('Retry-After 秒数优先于退避算法', () => {
  const headers = new Map([['retry-after', '12']]);
  assert.strictEqual(retryAfterMs({ headers: { get: k => headers.get(k) } }), 12000);
});

t('Retry-After 支持 HTTP 日期', () => {
  const future = new Date(Date.now() + 20000).toUTCString();
  const ms = retryAfterMs({ headers: { get: () => future } });
  assert.ok(ms > 15000 && ms <= 21000, '实际 ' + ms);
});

t('没有 Retry-After 时返回 undefined，交给退避', () => {
  assert.strictEqual(retryAfterMs({ headers: { get: () => null } }), undefined);
});

t('退避是指数增长且有上限', () => {
  const a = backoffMs(0, 2000, 30000);
  const b = backoffMs(3, 2000, 30000);
  assert.ok(a >= 2000 && a < 2600, '第 0 次约 2s，实际 ' + a);
  assert.ok(b >= 16000 && b < 16600, '第 3 次约 16s，实际 ' + b);
  assert.ok(backoffMs(20, 2000, 30000) <= 30500, '必须被上限夹住');
});

t('退避带抖动，避免并发批次同时重试', () => {
  const samples = new Set(Array.from({ length: 30 }, () => backoffMs(1, 2000, 30000)));
  assert.ok(samples.size > 1, '应该有随机抖动');
});

t('429 的报错话术指明不是 key 的问题', () => {
  const msg = buildErrorMessage(429, '{"code":"RATE_LIMITED","message":"All available accounts are currently rate-limited."}');
  assert.ok(msg.includes('429'));
  assert.ok(/不是 key/.test(msg), '要明确排除 key 的嫌疑');
  assert.ok(msg.includes('All available accounts'), '要带上服务端原话');
});

t('401 的报错话术指向 key', () => {
  const msg = buildErrorMessage(401, '{"code":"INVALID_API_KEY","message":"Invalid API key"}');
  assert.ok(/设置 API Key/.test(msg));
});

t('网关的 {code,message} 和 OpenAI 的 {error:{message}} 都能解出来', () => {
  assert.strictEqual(providerDetail('{"code":"X","message":"网关话术"}'), '网关话术');
  assert.strictEqual(providerDetail('{"error":{"message":"OpenAI 话术"}}'), 'OpenAI 话术');
  assert.strictEqual(providerDetail('纯文本错误'), '纯文本错误');
});

console.log('\n— 额度配平 —');

t('批大小和输出额度失衡时出警告', () => {
  const msg = budgetWarning({ maxCharsPerBatch: 20000, maxResponseTokens: 4000 });
  assert.ok(msg, '20000 字符配 4000 token 必然截断，要拦下来');
  assert.ok(msg.includes('16000'), '要给出该调到多少：' + msg);
  assert.ok(msg.includes('5000'), '也要给出另一头该调到多少：' + msg);
});

t('配平了就不出声', () => {
  assert.strictEqual(budgetWarning({ maxCharsPerBatch: 20000, maxResponseTokens: 16000 }), undefined);
  assert.strictEqual(budgetWarning({ maxCharsPerBatch: 6000, maxResponseTokens: 16000 }), undefined);
});

t('配置缺值时不瞎报', () => {
  assert.strictEqual(budgetWarning({}), undefined);
});

console.log('\n— 渲染 —');

t('Markdown 渲染出 HTML', () => {
  assert.ok(renderMarkdown('# 标题').includes('<h1'));
  assert.ok(renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |').includes('<table'));
});

t('坏输入不会弄垮渲染', () => {
  assert.strictEqual(typeof renderMarkdown('![x]('.repeat(50)), 'string');
});

// ------------------------------------------------ 真实文档
const file = process.argv[2];
if (file && fs.existsSync(file)) {
  console.log('\n— 真实文档：' + file + ' —');
  const md = fs.readFileSync(file, 'utf8');
  const blocks = segment(md);
  const kinds = {};
  for (const b of blocks) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const translatable = blocks.filter(b => b.translatable);
  const batches = batch(translatable, 20, 6000);
  console.log('  总块数 ' + blocks.length + '，其中要翻译 ' + translatable.length + '，分 ' + batches.length + ' 批');
  console.log('  分类：' + JSON.stringify(kinds));

  // 关键不变量：拼回去必须和原文等价（只差空行规整）
  const codeBlocks = blocks.filter(b => b.kind === 'code');
  console.log('  代码块 ' + codeBlocks.length + ' 个，全部标记为不翻译：' +
    (codeBlocks.every(b => !b.translatable) ? '是' : '否 ← 有问题'));
  const unclosed = blocks.filter(b => b.unclosed);
  if (unclosed.length) console.log('  ⚠ 有 ' + unclosed.length + ' 个未闭合的围栏');

  const sample = translatable.slice(0, 3).map(b => '[' + b.kind + '] ' + b.text.split('\n')[0].slice(0, 60));
  console.log('  待翻译样例：\n    ' + sample.join('\n    '));
}

console.log('\n通过 ' + pass + ' 项' + (process.exitCode ? '，有失败' : '，全部通过') + '\n');
