import type { WebUiPanel, WebUiDisablable } from 'cortico/web/shared/client-panel.ts';
import { SEARCH_LABELS, type SearchProviderId, type SearchSettingsState } from '../search-settings.ts';

export const searchPanel: WebUiPanel = {
  async mount(ctx) {
    const { ui } = ctx;
    const card = ui.sheet({ title: '搜索引擎', desc: '拖拽或用箭头排序。默认使用第一个已启用且配置完整的引擎；保存后下次调用生效。' });
    ctx.root.append(card.el);
    const message = ui.msgline();
    card.body.append(message);
    let state: SearchSettingsState;
    try { state = await ctx.invoke<SearchSettingsState>('state'); }
    catch { message.textContent = '读取搜索设置失败，请重新打开页面。'; return; }
    if (ctx.signal.aborted) return;
    let dirty = false;
    let dragging: SearchProviderId | null = null;
    let busy = false;
    const controls: WebUiDisablable[] = [];
    const keys: HTMLInputElement[] = [];
    ctx.guardLeave(() => dirty || keys.some(input => input.value !== '') ? '搜索设置或密钥尚未保存。' : null);
    ctx.own({ dispose: () => { for (const key of keys) key.value = ''; } });

    const list = ui.h('div');
    list.setAttribute('aria-label', '搜索引擎优先级');
    const move = (id: SearchProviderId, position: number) => {
      if (busy) return;
      const from = state.order.indexOf(id);
      if (from === position) return;
      state.order.splice(from, 1);
      state.order.splice(Math.max(0, Math.min(position, state.order.length)), 0, id);
      dirty = true;
      draw();
    };
    const draw = () => {
      list.replaceChildren();
      state.order.forEach((id, index) => {
        const row = ui.rowbar();
        row.draggable = true;
        row.style.padding = '8px 0';
        row.addEventListener('dragstart', event => {
          if (busy) { event.preventDefault(); return; }
          dragging = id;
          event.dataTransfer?.setData('text/plain', id);
        }, { signal: ctx.signal });
        row.addEventListener('dragover', event => { if (dragging && !busy) event.preventDefault(); }, { signal: ctx.signal });
        row.addEventListener('drop', event => { event.preventDefault(); if (dragging) move(dragging, index); dragging = null; }, { signal: ctx.signal });
        row.addEventListener('dragend', () => { dragging = null; }, { signal: ctx.signal });
        const enabled = ui.checkbox(`${index + 1}. ${SEARCH_LABELS[id]}`, { checked: state.enabled[id], disabled: busy, onChange: checked => { state.enabled[id] = checked; dirty = true; } });
        row.append(enabled.el, ui.pill(id === 'deepseek' || id === 'tavily' ? state.configured[id] ? '密钥已配置' : '未配置，自动选择时跳过' : '无需密钥', id === 'deepseek' || id === 'tavily' ? state.configured[id] ? 'on' : 'off' : 'plain'), ui.h('span', 'grow'));
        const up = ui.button('↑', { size: 'sm', onClick: () => move(id, index - 1) });
        const down = ui.button('↓', { size: 'sm', onClick: () => move(id, index + 1) });
        up.setAttribute('aria-label', `上移 ${SEARCH_LABELS[id]}`);
        down.setAttribute('aria-label', `下移 ${SEARCH_LABELS[id]}`);
        up.disabled = busy || index === 0;
        down.disabled = busy || index === state.order.length - 1;
        row.append(up, down);
        list.append(row);
      });
    };
    draw();
    const fallback = ui.checkbox('失败后按顺序自动切换', { checked: state.fallbackEnabled, onChange: checked => { state.fallbackEnabled = checked; dirty = true; } });
    const depth = ui.select({ options: [{ value: 'basic', label: '基础（basic）' }, { value: 'advanced', label: '深入（advanced，使用更多额度）' }], value: state.tavilySearchDepth, onChange: value => { state.tavilySearchDepth = value as 'basic' | 'advanced'; dirty = true; } });
    controls.push(fallback.input, depth);
    card.body.append(list, fallback.el, ui.h('p', 'sh-desc', '仅超时、限流或服务不可用时切换；无结果、密钥无效、额度不足或取消时停止。显式指定引擎的调用不自动切换。'), ui.field('Tavily 搜索深度', depth));

    const save = ui.button('保存搜索设置', { variant: 'primary', onClick: () => { void (async () => {
      busy = true; draw();
      const hold = ui.disable(...controls, save);
      message.textContent = '';
      try {
        await ctx.setConfig('world:browser:search', {
          'worlds.browser.search.order': state.order.join(','),
          'worlds.browser.search.fallbackEnabled': state.fallbackEnabled,
          'worlds.browser.search.tavily.searchDepth': state.tavilySearchDepth,
          ...Object.fromEntries(state.order.map(id => [`worlds.browser.search.${id}.enabled`, state.enabled[id]])),
        });
        if (ctx.signal.aborted) return;
        dirty = false;
        message.textContent = '搜索设置已保存，下次调用生效。';
      } catch { if (!ctx.signal.aborted) message.textContent = '保存搜索设置失败，改动仍保留在页面中。'; }
      finally { hold.dispose(); busy = false; if (!ctx.signal.aborted) draw(); }
    })(); } });
    card.body.append(save);

    const keyCard = ui.sheet({ title: '搜索 API key', desc: '密钥分别保存到部署 .env，只显示配置状态。搜索与抓取会使用对应服务的额度。' });
    ctx.root.append(keyCard.el);
    for (const id of ['deepseek', 'tavily'] as const) {
      const input = ui.input({ type: 'password', placeholder: `输入 ${SEARCH_LABELS[id]} API key` });
      input.autocomplete = 'new-password';
      input.spellcheck = false;
      keys.push(input);
      const status = ui.msgline(state.configured[id] ? '密钥已配置' : '未配置');
      const button = ui.button('保存密钥', { onClick: () => { void (async () => {
        const value = input.value.trim();
        if (!value) { status.textContent = '请输入 API key。'; return; }
        const hold = ui.disable(input, button);
        try {
          const next = await ctx.invoke<SearchSettingsState>('save-key', [{ engine: id, value }]);
          input.value = '';
          if (ctx.signal.aborted) return;
          state.configured = next.configured;
          status.textContent = '密钥已保存。';
          draw();
        } catch { if (!ctx.signal.aborted) status.textContent = '保存密钥失败，请检查部署 .env 是否可写。'; }
        finally { hold.dispose(); }
      })(); } });
      keyCard.body.append(ui.field(`${SEARCH_LABELS[id]} API key`, input), button, status);
    }
  },
};
