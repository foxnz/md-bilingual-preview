'use strict';

const crypto = require('crypto');

/**
 * 把 Markdown 切成块。每块要么整体送去翻译，要么原样保留。
 *
 * 不翻译的块：YAML frontmatter、围栏代码块、HTML 块与注释、分隔线，
 * 以及任何不含字母的块（表格分隔行、纯符号行等）。
 */

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const RULE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const QUOTE_RE = /^\s{0,3}>/;
const LIST_RE = /^\s*(?:[-*+]\s|\d+[.)]\s)/;
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const LINK_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
const HTML_OPEN_RE = /^\s{0,3}(?:<!--|<\/?[a-zA-Z][\w-]*(?:\s|\/?>))/;

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 块里有没有值得翻译的自然语言。 */
function hasProse(text) {
  const stripped = text
    .replace(/`[^`]*`/g, ' ')              // 行内代码
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, m => m.replace(/\]\([^)]*\)/, '] '))  // 只留链接文字
    .replace(/<[^>]+>/g, ' ')              // 裸 HTML / 自动链接
    .replace(/https?:\/\/\S+/g, ' ');      // 裸 URL
  return /\p{L}/u.test(stripped);
}

function classifyText(lines) {
  const first = lines[0] || '';
  if (HEADING_RE.test(first)) return 'heading';
  if (lines.length >= 2 && first.includes('|') && TABLE_DELIM_RE.test(lines[1])) return 'table';
  if (QUOTE_RE.test(first)) return 'quote';
  if (LIST_RE.test(first)) return 'list';
  return 'paragraph';
}

/**
 * @param {string} markdown
 * @returns {Array<{index:number, kind:string, text:string, hash:string, translatable:boolean}>}
 */
function segment(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  // YAML frontmatter 只在文件开头成立
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[j])) { end = j; break; }
    }
    if (end !== -1) {
      blocks.push({ kind: 'frontmatter', text: lines.slice(0, end + 1).join('\n') });
      i = end + 1;
    }
  }

  let buffer = [];
  const flush = () => {
    while (buffer.length && buffer[buffer.length - 1].trim() === '') buffer.pop();
    if (!buffer.length) return;
    const text = buffer.join('\n');
    buffer = [];
    if (RULE_RE.test(text.trim()) && !text.includes('\n')) {
      blocks.push({ kind: 'rule', text });
    } else if (LINK_DEF_RE.test(text) && text.split('\n').every(l => !l.trim() || LINK_DEF_RE.test(l))) {
      blocks.push({ kind: 'linkdef', text });
    } else if (HTML_OPEN_RE.test(text)) {
      blocks.push({ kind: 'html', text });
    } else {
      blocks.push({ kind: classifyText(text.split('\n')), text });
    }
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);

    if (fence) {
      flush();
      const marker = fence[2];
      const chunk = [line];
      let closed = false;
      for (i++; i < lines.length; i++) {
        chunk.push(lines[i]);
        const close = FENCE_RE.exec(lines[i]);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length && !close[3].trim()) {
          closed = true;
          break;
        }
      }
      blocks.push({ kind: 'code', text: chunk.join('\n'), unclosed: !closed });
      continue;
    }

    if (line.trim() === '') { flush(); continue; }
    buffer.push(line);
  }
  flush();

  const NEVER = new Set(['frontmatter', 'code', 'rule', 'linkdef', 'html']);
  return blocks.map((b, index) => ({
    index,
    kind: b.kind,
    text: b.text,
    hash: sha1(b.text),
    translatable: !NEVER.has(b.kind) && hasProse(b.text),
  }));
}

/**
 * 按数量和字符数把待翻译段落分批。
 */
function batch(segments, maxSegments, maxChars) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (current.length && (current.length >= maxSegments || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(seg);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = { segment, batch, sha1, hasProse };
