#!/usr/bin/env node
'use strict';

/**
 * 网关探测：你的 key 能用哪些模型，哪些当前可用。
 *
 * key 只从环境变量读，不作为命令行参数，不打印、不落盘。
 *
 *   read -rs MDB_KEY && export MDB_KEY && node tools/probe.js
 *
 * 用 `read -rs` 输入，key 不会进 shell 历史。跑完 `unset MDB_KEY` 清掉。
 */

const KEY = process.env.MDB_KEY;
// DeepSeek 的 OpenAI 兼容端点没有 /v1 这一段，端点就是 https://api.deepseek.com/chat/completions
const BASE = (process.env.MDB_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

if (!KEY) {
  console.error('没读到 MDB_KEY。用法：\n  read -rs MDB_KEY && export MDB_KEY && node tools/probe.js\n');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function detail(body) {
  try {
    const j = JSON.parse(body);
    return (j.error && j.error.message) || j.message || JSON.stringify(j).slice(0, 120);
  } catch {
    return body.trim().slice(0, 120);
  }
}

function verdict(status, body) {
  const d = detail(body);
  if (status === 200) return ['可用', d ? '' : ''];
  if (status === 401) return ['key 无效', d];
  if (status === 403) return ['不允许', d];
  if (status === 404) return ['模型不存在', d];
  if (status === 429) return ['限流中', d];
  return [`HTTP ${status}`, d];
}

async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers });
  const body = await res.text();
  if (!res.ok) {
    console.log(`  GET /models → HTTP ${res.status}：${detail(body)}`);
    return [];
  }
  try {
    const ids = (JSON.parse(body).data || []).map(m => m.id);
    console.log(`  你的 key 可见 ${ids.length} 个模型：`);
    for (const id of ids) console.log(`    ${id}`);
    return ids;
  } catch {
    console.log('  /models 返回的不是预期结构：' + body.slice(0, 200));
    return [];
  }
}

async function probe(model) {
  const started = Date.now();
  try {
    const body = {
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    };
    // DeepSeek 默认开思考，不关掉的话这个「最小请求」会慢得没有参考价值
    if (/(^|[^a-z])deepseek([^a-z]|$)/i.test(model)) body.thinking = { type: 'disabled' };
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const body = await res.text();
    const [label, note] = verdict(res.status, body);
    const ms = Date.now() - started;
    console.log(`  ${model.padEnd(34)} ${label.padEnd(12)} ${ms}ms  ${note}`);
    return res.status === 200;
  } catch (e) {
    console.log(`  ${model.padEnd(34)} 网络错误      ${e.message}`);
    return false;
  }
}

(async () => {
  console.log(`\n网关：${BASE}\n`);
  console.log('— 模型清单 —');
  const ids = await listModels();

  // /models 拿不到时（分组不允许列举）用候选名单兜底，脚本仍然能给出结论。
  const FALLBACK = [
    'deepseek-flash',
    'deepseek-v4-pro',
    'gpt-5.3-codex-spark',
    'claude-sonnet-5',
    'claude-opus-5',
  ];

  const targets = process.argv.slice(2);
  let toProbe = targets.length ? targets : ids;
  if (!toProbe.length) {
    console.log('\n  拿不到模型列表，改用候选名单逐个试。');
    toProbe = FALLBACK;
  }
  // 当前配的模型一定要在被测之列
  const configured = process.env.MDB_MODEL || 'deepseek-flash';
  if (!toProbe.includes(configured)) toProbe = [configured, ...toProbe];

  console.log('\n— 逐个实际发一次最小请求 —');
  const usable = [];
  for (const model of toProbe) {
    if (await probe(model)) usable.push(model);
  }

  console.log('\n— 结论 —');
  if (usable.length) {
    console.log(`  当前可用 ${usable.length} 个。把下面这行填进 settings.json：`);
    console.log(`    "mdBilingual.model": "${usable[0]}"`);
  } else {
    console.log('  当前没有可用模型。若全是「限流中」，是网关上游配额耗尽，只能等冷却。');
  }
  console.log('');
})();
