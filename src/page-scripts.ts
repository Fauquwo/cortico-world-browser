/**
 * 注入页面的 JS 片段。都是纯函数表达式，由 `browser_js` 的同一条 `/eval` 通道执行。
 *
 * 上游没有现成的提取代码——`SKILL.md` 只写「eval 递归遍历可穿透 Shadow DOM 与 iframe」这条
 * 技术事实，实现留给了用它的人。这里自己写。
 */

/** `browser_read` 的读页函数：递归穿 Shadow DOM 与同源 iframe，返回正文与链接。 */
const READ_SOURCE = `(selector, maxChars) => {
  const out = { title: document.title, url: location.href, ready: document.readyState, text: '', links: [], truncated: false };
  const root = selector ? document.querySelector(selector) : (document.body || document.documentElement);
  if (!root) { out.error = '这个选择器在页面上找不到: ' + selector; return out; }
  const blocks = ' div p li tr h1 h2 h3 h4 h5 h6 section article header footer nav ul ol table blockquote pre form main aside figure figcaption dl dd dt br hr td th ';
  const links = [];
  const seen = new Set();
  let buf = '';
  let truncated = false;
  const addText = (value) => {
    const text = String(value === null || value === undefined ? '' : value).replace(/\\s+/g, ' ').trim();
    if (!text) return;
    if (buf.length + text.length + 1 > maxChars) { truncated = true; return; }
    buf += (buf.length > 0 && buf.charAt(buf.length - 1) !== '\\n' ? ' ' : '') + text;
  };
  const visit = (node, depth) => {
    if (truncated || depth > 12) return;
    if (node.nodeType === 1) {
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') return;
      const isBlock = blocks.indexOf(' ' + tag + ' ') >= 0;
      if (isBlock) buf += '\\n';
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      if (tag === 'a' && el.href) {
        const label = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        if (label && !seen.has(el.href) && links.length < 60) { seen.add(el.href); links.push({ text: label, url: el.href }); }
      }
      if (tag === 'iframe' || tag === 'frame') {
        try { const doc = el.contentDocument; if (doc) visit(doc, depth + 1); } catch (err) {}
      } else {
        for (const child of el.childNodes) visit(child, depth + 1);
      }
      if (isBlock) buf += '\\n';
      return;
    }
    if (node.nodeType === 3) addText(node.nodeValue);
  };
  visit(root, 0);
  out.text = buf.replace(/[ \\t]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{2,}/g, '\\n').trim();
  out.links = links;
  out.truncated = truncated;
  return out;
}`;

/** 读页表达式的完整源码。 */
export function readExpression(selector: string | null, maxChars: number): string {
  return `(${READ_SOURCE})(${JSON.stringify(selector)}, ${Math.max(200, Math.floor(maxChars))})`;
}

/**
 * `browser_type` 的填表函数。
 * 走原型上的原生 value setter：直接 `el.value = x` 在受控组件（React / Vue）里会被框架的值跟踪
 * 判成「没变」而忽略，原生 setter 走的是同一个入口但绕过了框架的劫持。
 */
const TYPE_SOURCE = `(selector, value, submit) => {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: '这个选择器在页面上找不到: ' + selector };
  const tag = el.tagName.toLowerCase();
  let applied = '';
  if (tag === 'select') {
    const match = Array.prototype.slice.call(el.options).find((o) => o.value === value || o.text.trim() === value);
    if (!match) return { ok: false, error: '这个 select 里没有这个选项: ' + value };
    el.value = match.value;
    applied = 'select';
  } else if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    applied = 'value';
  } else if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    applied = 'contenteditable';
  } else {
    el.focus();
    el.textContent = value;
    applied = 'text';
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const current = el.value === undefined || el.value === null ? el.textContent : el.value;
  const out = { ok: true, applied: applied, value: String(current === null || current === undefined ? '' : current).slice(0, 200) };
  if (submit) {
    const form = el.form || (el.closest ? el.closest('form') : null);
    if (form && form.requestSubmit) { form.requestSubmit(); out.submitted = 'form'; }
    else {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      out.submitted = 'enter';
    }
  }
  return out;
}`;

/** 填表表达式的完整源码。 */
export function typeExpression(selector: string, value: string, submit: boolean): string {
  return `(${TYPE_SOURCE})(${JSON.stringify(selector)}, ${JSON.stringify(value)}, ${submit ? 'true' : 'false'})`;
}
