#!/usr/bin/env node
'use strict';

/**
 * 429 复现回路。
 *
 * 走的是插件的真实代码路径：真实的 segment()、真实的 translateBatch()、
 * 真实的 settings.json 配置、真实的目标文档。只把 VS Code 外壳换掉。
 *
 * key 的来源（按顺序，读到即止）：
 *   1. 环境变量 MDB_KEY
 *   2. 文件 ~/.config/md-bilingual/key
 * key 从不打印、不写入产物、不进任何日志。输出只有状态码和网关给的话。
 *
 * 用法：
 *   node tools/repro.js                    跑全部变体
 *   node tools/repro.js --only A           只跑变体 A
 *   node tools/repro.js --poll 120         每 120s 重跑变体 A，直到变绿
 *
 * 退出码：0 = 变体 A 通过（绿）；1 = 变体 A 失败（红）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { segment, batch } = require('../src/segment');
const { translateBatch, TranslateError } = require('../src/translate');

const SETTINGS = path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
const KEY_FILE = path.join(os.homedir(), '.config/md-bilingual/key');
const DOC = process.env.MDB_DOC ||
  '/Users/mingmingzhang/Documents/GitHub/mingagenticai/insurance-agent/docs/video-clip-retrieval-api.md';

function readKey() {
  if (process.env.MDB_KEY) return process.env.MDB_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return undefined; }
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; }
}

/** 复刻插件 resolveConfig 的回落逻辑：mdBilingual.* 留空则用 mdTranslator.*。 */
function buildConfig(s) {
  const pick = (a, b, dflt) => {
    for (const v of [s['mdBilingual.' + a], s['mdTranslator.' + b]]) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return dflt;
  };
  return {
    apiBaseUrl: String(pick('apiBaseUrl', 'apiBaseUrl', '')).trim(),
    model: String(pick('model', 'model', '')).trim(),
    targetLanguage: String(pick('targetLanguage', 'targetLanguage', 'Simplified Chinese')).trim(),
    temperature: s['mdBilingual.temperature'] ?? 1,
    maxSegmentsPerBatch: s['mdBilingual.maxSegmentsPerBatch'] ?? 20,
    maxCharsPerBatch: s['mdBilingual.maxCharsPerBatch'] ?? 6000,
    maxResponseTokens: s['mdBilingual.maxResponseTokens'] ?? 16000,
    requestTimeoutMs: s['mdBilingual.requestTimeoutMs'] ?? 120000,
    reasoningEffort: s['mdBilingual.reasoningEffort'] ?? 'auto',
    useJsonResponseFormat: s['mdBilingual.useJsonResponseFormat'] ?? false,
    maxRetries: 0,          // 回路里不重试，要的是单次请求的原始信号
  };
}

function short(e) {
  const m = e instanceof TranslateError ? e.message : String((e && e.message) || e);
  return m.replace(/\s+/g, ' ').slice(0, 150);
}

async function run(name, purpose, opts, blocks) {
  const started = Date.now();
  process.stdout.write(`  ${name}  ${purpose.padEnd(40)}`);
  try {
    const { translations, missing } = await translateBatch(opts, blocks);
    const ms = Date.now() - started;
    console.log(`绿  ${ms}ms  译出 ${translations.size}/${blocks.length} 段${missing.length ? `（缺 ${missing.length}）` : ''}`);
    const sample = translations.values().next().value;
    if (sample) console.log(`       样例：${String(sample).replace(/\s+/g, ' ').slice(0, 60)}`);
    return true;
  } catch (e) {
    const ms = Date.now() - started;
    const status = e instanceof TranslateError && e.status ? e.status : '—';
    console.log(`红  ${ms}ms  HTTP ${status}  ${short(e)}`);
    return false;
  }
}

(async () => {
  const key = readKey();
  if (!key) {
    console.error(
      '\n没找到 API Key。二选一：\n' +
      '  export MDB_KEY=...\n' +
      `  mkdir -p ~/.config/md-bilingual && chmod 700 ~/.config/md-bilingual\n` +
      `  （把 key 写进 ${KEY_FILE}，然后 chmod 600 它）\n`);
    process.exit(2);
  }

  const cfg = buildConfig(readSettings());
  if (!cfg.apiBaseUrl || !cfg.model) {
    console.error('\nsettings.json 里没读到 apiBaseUrl / model。\n');
    process.exit(2);
  }

  const md = fs.readFileSync(DOC, 'utf8');
  const all = segment(md).filter(b => b.translatable);
  const groups = batch(all, cfg.maxSegmentsPerBatch, cfg.maxCharsPerBatch);
  const realBatch = groups[0].map(b => ({ id: `s${b.index}`, kind: b.kind, text: b.text }));
  const oneSegment = [realBatch[0]];

  console.log(`\n网关   ${cfg.apiBaseUrl}`);
  console.log(`模型   ${cfg.model}`);
  console.log(`文档   ${path.basename(DOC)} → ${all.length} 段待译，分 ${groups.length} 批`);
  console.log(`变体 A 用第 1 批真实内容：${realBatch.length} 段 / ${realBatch.reduce((n, b) => n + b.text.length, 0)} 字符\n`);

  const base = { ...cfg, apiKey: key };
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : undefined;

  const variants = [
    ['A', '插件当前的真实请求（这就是 bug）', base, realBatch],
    ['B', 'max_tokens 16000 → 1024', { ...base, maxResponseTokens: 1024 }, realBatch],
    ['C', '不发 reasoning_effort', { ...base, reasoningEffort: 'off' }, realBatch],
    ['D', '只发 1 段（最小请求）', { ...base, maxResponseTokens: 512 }, oneSegment],
  ];

  const pollIdx = process.argv.indexOf('--poll');
  if (pollIdx !== -1) {
    const every = Number(process.argv[pollIdx + 1] || 120) * 1000;
    console.log(`— 轮询模式：每 ${every / 1000}s 重跑变体 A，直到变绿（Ctrl+C 停止）—\n`);
    for (let n = 1; ; n++) {
      process.stdout.write(`  [${new Date().toLocaleTimeString()}] 第 ${n} 次  `);
      const ok = await run('A', '', base, realBatch);
      if (ok) { console.log('\n  配额恢复了。\n'); process.exit(0); }
      await new Promise(r => setTimeout(r, every));
    }
  }

  console.log('— 变体 —');
  const results = {};
  for (const [name, purpose, opts, blocks] of variants) {
    if (only && name !== only) continue;
    results[name] = await run(name, purpose, opts, blocks);
  }

  console.log('\n— 读法 —');
  if (results.D === false) {
    console.log('  连最小请求都红 → 纯粹是网关上游配额耗尽，跟请求形状无关。');
    console.log('  插件这边没有可改的东西，只能等冷却。用 --poll 盯着。');
  } else if (results.A === false && results.D === true) {
    console.log('  最小请求绿、真实请求红 → 跟请求形状有关，插件这边可以改。');
    if (results.B) console.log('  变体 B 绿 → 是 max_tokens 太大占配额，调小 mdBilingual.maxResponseTokens。');
    if (results.C) console.log('  变体 C 绿 → 是 reasoning_effort 参数的问题，设 mdBilingual.reasoningEffort=off。');
  } else if (results.A === true) {
    console.log('  变体 A 绿 → 当前配额可用，bug 此刻不复现。');
  }
  console.log('');

  process.exit(results.A === false ? 1 : 0);
})();
