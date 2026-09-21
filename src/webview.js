'use strict';

const crypto = require('crypto');
const { marked } = require('marked');

marked.setOptions({ gfm: true, breaks: false });

function nonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Markdown → HTML。渲染失败时退回转义后的纯文本，不让一个坏块弄垮整页。 */
function renderMarkdown(text) {
  try {
    return marked.parse(text);
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#bar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#bar .name { font-weight: 600; }
#bar .status { color: var(--vscode-descriptionForeground); font-size: 0.9em; flex: 1; }
#bar button {
  font: inherit; font-size: 0.9em;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px; padding: 3px 10px; cursor: pointer;
}
#bar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
#err {
  display: none; margin: 12px 16px; padding: 10px 14px; border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.1));
  border: 1px solid var(--vscode-inputValidation-errorBorder, red);
  white-space: pre-wrap;
}
#err.show { display: block; }
#doc { padding: 4px 16px 64px; }

.row { display: grid; gap: 0 32px; align-items: start; border-bottom: 1px solid transparent; }
body.side-by-side .row { grid-template-columns: 1fr 1fr; }
body.stacked .row { grid-template-columns: 1fr; }
body.stacked .row .t { padding-top: 0; }
.row.full { grid-template-columns: 1fr; }
.row:hover { background: var(--vscode-list-hoverBackground); }

.cell { min-width: 0; overflow-wrap: anywhere; }
.cell.t { color: var(--vscode-foreground); }
body.side-by-side .cell.t { border-left: 1px solid var(--vscode-panel-border); padding-left: 32px; margin-left: -32px; }
.pending { color: var(--vscode-descriptionForeground); font-style: italic; opacity: .6; }
.failed { color: var(--vscode-descriptionForeground); font-style: italic; }

.cell :first-child { margin-top: .35em; }
.cell :last-child { margin-bottom: .35em; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; }
h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
p, li { line-height: 1.65; }
a { color: var(--vscode-textLink-foreground); }
code {
  font-family: var(--vscode-editor-font-family); font-size: .92em;
  background: var(--vscode-textCodeBlock-background); padding: .15em .35em; border-radius: 3px;
}
pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 12px 14px; border-radius: 4px; overflow-x: auto;
}
pre code { background: none; padding: 0; }
blockquote {
  margin: .5em 0; padding-left: 12px;
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  color: var(--vscode-descriptionForeground);
}
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 5px 9px; text-align: left; }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 1.2em 0; }
img { max-width: 100%; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'translated') {
    const cell = document.getElementById('t' + msg.index);
    // 整个重设 class：失败过的格子重译成功后要把 failed 的灰斜体也摘掉
    if (cell) { cell.className = 'cell t'; cell.innerHTML = msg.html; }
  } else if (msg.type === 'failed') {
    const cell = document.getElementById('t' + msg.index);
    if (cell) { cell.className = 'cell t failed'; cell.textContent = msg.text; }
  } else if (msg.type === 'status') {
    document.getElementById('status').textContent = msg.text;
  } else if (msg.type === 'error') {
    const box = document.getElementById('err');
    box.textContent = msg.message;
    box.classList.add('show');
  } else if (msg.type === 'clearError') {
    document.getElementById('err').classList.remove('show');
  } else if (msg.type === 'layout') {
    document.body.className = msg.layout;
  }
});
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('toggle').addEventListener('click', () => vscode.postMessage({ type: 'toggleLayout' }));

// 监听器已挂好，扩展端可以开始发消息了。
// 重新赋值 webview.html 会让这份文档整个重来，在新的监听器注册之前
// postMessage 的内容会被静默丢弃——所以必须等这一声再发。
vscode.postMessage({ type: 'ready' });
`;

/**
 * 构建整页骨架：原文立即可读，译文槽位先占位，翻译完成后逐块填入。
 */
function buildHtml({ cspSource, title, blocks, layout, targetLanguage }) {
  const n = nonce();
  const rows = blocks.map(block => {
    const left = renderMarkdown(block.text);
    if (!block.translatable) {
      return `<div class="row full"><div class="cell">${left}</div></div>`;
    }
    return `<div class="row">` +
      `<div class="cell">${left}</div>` +
      `<div class="cell t pending" id="t${block.index}">翻译中…</div>` +
      `</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${n}';">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${escapeHtml(layout)}">
<div id="bar">
  <span class="name">${escapeHtml(title)}</span>
  <span class="status" id="status">准备翻译成${escapeHtml(targetLanguage)}…</span>
  <button id="toggle">切换布局</button>
  <button id="refresh">重新翻译</button>
</div>
<div id="err"></div>
<div id="doc">
${rows}
</div>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { buildHtml, renderMarkdown, escapeHtml };
