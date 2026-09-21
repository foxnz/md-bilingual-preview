'use strict';

const vscode = require('vscode');
const path = require('path');
const { segment, batch } = require('./segment');
const { translateBatch, TranslateError } = require('./translate');
const { buildHtml, renderMarkdown } = require('./webview');

const SECRET_KEY = 'mdBilingual.apiKey';
const MD_EXT = new Set(['.md', '.markdown']);

/** 译文缓存：`${model}|${lang}|${blockHash}` -> 译文。只在内存里，不落盘。 */
const cache = new Map();

/** uri.toString() -> session */
const sessions = new Map();

// ---------------------------------------------------------------- 配置

/**
 * 读 mdBilingual.*，留空时回落到 mdTranslator.*（sunven 那个插件的命名空间），
 * 这样已经配好的那套东西不用重配一遍。
 */
function resolveConfig() {
  const mine = vscode.workspace.getConfiguration('mdBilingual');
  const theirs = vscode.workspace.getConfiguration('mdTranslator');
  const pick = (key, fallbackKey, fallbackValue) => {
    const v = mine.get(key);
    if (v !== undefined && v !== null && v !== '') return v;
    const t = theirs.get(fallbackKey);
    if (t !== undefined && t !== null && t !== '') return t;
    return fallbackValue;
  };
  return {
    apiBaseUrl: String(pick('apiBaseUrl', 'apiBaseUrl', '')).trim(),
    model: String(pick('model', 'model', '')).trim(),
    targetLanguage: String(pick('targetLanguage', 'targetLanguage', 'Simplified Chinese')).trim(),
    temperature: mine.get('temperature', 1),
    maxSegmentsPerBatch: mine.get('maxSegmentsPerBatch', 20),
    maxCharsPerBatch: mine.get('maxCharsPerBatch', 6000),
    maxResponseTokens: mine.get('maxResponseTokens', 16000),
    requestTimeoutMs: mine.get('requestTimeoutMs', 120000),
    concurrency: mine.get('concurrency', 1),
    maxRetries: mine.get('maxRetries', 4),
    retryBaseMs: mine.get('retryBaseMs', 2000),
    retryMaxDelayMs: mine.get('retryMaxDelayMs', 30000),
    reasoningEffort: mine.get('reasoningEffort', 'auto'),
    useJsonResponseFormat: mine.get('useJsonResponseFormat', false),
    layout: mine.get('layout', 'side-by-side'),
    autoRefresh: mine.get('autoRefresh', true),
  };
}

async function getApiKey(context, { prompt } = {}) {
  let key = await context.secrets.get(SECRET_KEY);
  if (key || !prompt) return key;
  key = await promptForApiKey(context);
  return key;
}

async function promptForApiKey(context) {
  const value = await vscode.window.showInputBox({
    title: 'Markdown 双语预览：API Key',
    prompt: '输入 OpenAI 兼容接口的 API Key（存在 VS Code SecretStorage 里，不会写进 settings.json）',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    vscode.window.showWarningMessage('没有输入内容，API Key 未改动。');
    return undefined;
  }
  await context.secrets.store(SECRET_KEY, trimmed);
  vscode.window.showInformationMessage('API Key 已保存。');
  return trimmed;
}

// ---------------------------------------------------------------- 定位目标文件

/**
 * 找出要翻译哪个文件。
 *
 * 必须兼容自定义编辑器（例如把 *.md 关联到 markdownForHumans.editor 时，
 * activeTextEditor 是 undefined），所以按三条路依次尝试。
 */
function resolveTargetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && arg.resourceUri instanceof vscode.Uri) return arg.resourceUri;

  const editor = vscode.window.activeTextEditor;
  if (editor && MD_EXT.has(path.extname(editor.document.uri.fsPath).toLowerCase())) {
    return editor.document.uri;
  }

  const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  for (const candidate of [input && input.uri, input && input.modified]) {
    if (candidate instanceof vscode.Uri && MD_EXT.has(path.extname(candidate.fsPath).toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
}

/** 读取文件内容。已打开的文件（含未保存改动）优先用编辑器里的版本。 */
async function readText(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc.getText();
}

// ---------------------------------------------------------------- 翻译流程

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function translateSession(session, context, { force = false } = {}) {
  const { panel } = session;
  const cfg = resolveConfig();
  session.cfg = cfg;

  if (!cfg.apiBaseUrl || !cfg.model) {
    panel.webview.postMessage({
      type: 'error',
      message: '还没配置接口地址或模型。\n请设置 mdBilingual.apiBaseUrl 和 mdBilingual.model，或沿用已有的 mdTranslator.apiBaseUrl / mdTranslator.model。',
    });
    return;
  }

  const apiKey = await getApiKey(context, { prompt: true });
  if (!apiKey) {
    panel.webview.postMessage({
      type: 'error',
      message: '没有 API Key，无法翻译。\n运行命令「Markdown 双语预览：设置 API Key」后点「重新翻译」。',
    });
    return;
  }

  const runId = ++session.runId;
  const alive = () => session.runId === runId && sessions.has(session.key);

  const pending = session.blocks.filter(b => b.translatable);
  if (!pending.length) {
    panel.webview.postMessage({ type: 'status', text: '这篇文档没有需要翻译的正文。' });
    return;
  }

  panel.webview.postMessage({ type: 'clearError' });

  // 先吃缓存，只把没命中的送去翻译
  const todo = [];
  let cached = 0;
  for (const block of pending) {
    const key = `${cfg.model}|${cfg.targetLanguage}|${block.hash}`;
    if (!force && cache.has(key)) {
      panel.webview.postMessage({ type: 'translated', index: block.index, html: renderMarkdown(cache.get(key)) });
      cached++;
    } else {
      todo.push(block);
    }
  }

  if (!todo.length) {
    panel.webview.postMessage({ type: 'status', text: `完成：${cached} 段全部命中缓存。` });
    return;
  }

  const batches = batch(todo, cfg.maxSegmentsPerBatch, cfg.maxCharsPerBatch);
  const opts = { ...cfg, apiKey };
  const startedAt = Date.now();
  let done = 0;
  let failedBlocks = 0;
  let firstError;

  let retrying = '';
  const report = () => {
    if (!alive()) return;
    panel.webview.postMessage({
      type: 'status',
      text: `翻译中 ${done}/${batches.length} 批${cached ? `（${cached} 段命中缓存）` : ''}…${retrying}`,
    });
  };
  report();

  // 限流时把等待情况显示出来，否则界面看着像卡死了
  const onRetry = ({ attempt, maxRetries, waitMs, askedMs, status, reason }) => {
    retrying = `　⏳ ${status === 429 ? '被限流' : '请求失败'}，${Math.round(waitMs / 1000)}s 后重试` +
      `（第 ${attempt}/${maxRetries} 次）` +
      (askedMs ? `　服务端要求等 ${Math.round(askedMs / 1000)}s，已按 retryMaxDelayMs 截断` : '') +
      `${reason ? '：' + String(reason).slice(0, 80) : ''}`;
    report();
  };

  await runPool(batches, cfg.concurrency, async (group) => {
    if (!alive()) return;
    const payload = group.map(b => ({ id: `s${b.index}`, kind: b.kind, text: b.text }));
    try {
      const { translations, missing } = await translateBatch({ ...opts, onRetry }, payload);
      retrying = '';
      if (!alive()) return;
      for (const block of group) {
        const text = translations.get(`s${block.index}`);
        if (typeof text === 'string' && text.trim()) {
          cache.set(`${cfg.model}|${cfg.targetLanguage}|${block.hash}`, text);
          panel.webview.postMessage({ type: 'translated', index: block.index, html: renderMarkdown(text) });
        } else {
          failedBlocks++;
          panel.webview.postMessage({ type: 'failed', index: block.index, text: '（这一段没返回译文）' });
        }
      }
      if (missing.length) firstError = firstError || `有 ${missing.length} 段没拿到译文。`;
    } catch (error) {
      if (!alive()) return;
      failedBlocks += group.length;
      const message = error instanceof TranslateError ? error.message : String(error && error.message || error);
      firstError = firstError || message;
      for (const block of group) {
        panel.webview.postMessage({ type: 'failed', index: block.index, text: '（这一批翻译失败）' });
      }
    } finally {
      done++;
      report();
    }
  });

  if (!alive()) return;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = todo.length - failedBlocks;
  panel.webview.postMessage({
    type: 'status',
    text: failedBlocks
      ? `完成：${ok} 段成功，${failedBlocks} 段失败，用时 ${seconds}s`
      : `完成：${ok} 段，用时 ${seconds}s${cached ? `（另有 ${cached} 段命中缓存）` : ''}`,
  });
  if (firstError) panel.webview.postMessage({ type: 'error', message: firstError });
}

/**
 * 等 webview 报到。
 *
 * 赋值 webview.html 会把页面整个重新加载，新文档挂上 message 监听器之前
 * postMessage 的内容会被丢掉——状态、缓存命中的译文、甚至报错都会凭空消失，
 * 表现是右栏永远停在「翻译中…」。所以每次重建页面后都要等这一声 ready。
 *
 * 超时兜底是为了万一脚本没跑起来（CSP 拦了、渲染出错），
 * 宁可冒丢消息的风险也要往下走，不能让整个流程卡在这里。
 */
function waitForWebview(session, timeoutMs = 3000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.signalReady = undefined;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    session.signalReady = finish;
  });
}

async function render(session, context, { force = false } = {}) {
  const text = await readText(session.uri);
  session.blocks = segment(text);
  const ready = waitForWebview(session);
  session.panel.webview.html = buildHtml({
    cspSource: session.panel.webview.cspSource,
    title: path.basename(session.uri.fsPath),
    blocks: session.blocks,
    layout: session.layout,
    targetLanguage: resolveConfig().targetLanguage,
  });
  await ready;
  if (!sessions.has(session.key)) return;   // 等待期间面板可能已经被关掉
  await translateSession(session, context, { force });
}

// ---------------------------------------------------------------- 命令

async function openPreview(context, arg) {
  const uri = resolveTargetUri(arg);
  if (!uri) {
    vscode.window.showWarningMessage('没找到 Markdown 文件。请先打开一个 .md 文件，或在资源管理器里右键它。');
    return;
  }

  const key = uri.toString();
  const existing = sessions.get(key);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'mdBilingual.preview',
    `双语：${path.basename(uri.fsPath)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
  );

  const session = { key, uri, panel, blocks: [], layout: resolveConfig().layout, runId: 0, timer: undefined };
  sessions.set(key, session);

  panel.onDidDispose(() => {
    if (session.timer) clearTimeout(session.timer);
    session.runId++;            // 让还在跑的批次停止往已销毁的面板发消息
    sessions.delete(key);
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      if (session.signalReady) session.signalReady();
    } else if (msg.type === 'refresh') {
      await render(session, context, { force: true });
    } else if (msg.type === 'toggleLayout') {
      session.layout = session.layout === 'side-by-side' ? 'stacked' : 'side-by-side';
      panel.webview.postMessage({ type: 'layout', layout: session.layout });
    }
  });

  await render(session, context);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdBilingual.openPreview', arg => openPreview(context, arg)),

    vscode.commands.registerCommand('mdBilingual.refresh', async () => {
      const uri = resolveTargetUri();
      const session = uri && sessions.get(uri.toString());
      const target = session || (sessions.size === 1 ? [...sessions.values()][0] : undefined);
      if (!target) {
        vscode.window.showWarningMessage('没有打开中的双语预览面板。');
        return;
      }
      cache.clear();
      await render(target, context, { force: true });
    }),

    vscode.commands.registerCommand('mdBilingual.setApiKey', () => promptForApiKey(context)),

    vscode.commands.registerCommand('mdBilingual.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('API Key 已清除。');
    }),

    // 源文件改动 → 去抖后只重译变化的段落（未变的走缓存）
    vscode.workspace.onDidChangeTextDocument((event) => {
      const session = sessions.get(event.document.uri.toString());
      if (!session || !resolveConfig().autoRefresh) return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = undefined;
        render(session, context).catch(err => {
          session.panel.webview.postMessage({ type: 'error', message: String(err && err.message || err) });
        });
      }, 800);
    }),
  );
}

function deactivate() {
  cache.clear();
  sessions.clear();
}

module.exports = { activate, deactivate };
