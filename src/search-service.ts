import type { ToolCallContext, ToolOutcome, ToolSpec, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { BrowserConfigSection } from './config.ts';
import { clampCount, isSearchEngineId, type SearchEngineId } from './search.ts';
import { SearchApi, SearchApiError, publicPageUrl } from './search-api.ts';
import { SEARCH_CONFIG_GROUP, SEARCH_DEFAULTS, SEARCH_LABELS, SEARCH_PROVIDERS, SEARCH_SECRETS, isPageProvider, isSearchProvider, providerOrder, type SearchProviderId, type SearchSettingsState } from './search-settings.ts';

export const BROWSER_FETCH_TOOL: ToolSpec = {
  name: 'browser_fetch', tags: ['read', 'snapshot'],
  description: 'Fetch a public HTTP/HTTPS page as Markdown using DeepSeek or Tavily. Uses configured engine order and optional failure fallback. Does not open a tab or use browser cookies. Use browser_open/browser_read for login, interaction or JavaScript-rendered pages. Reports the actual provider and truncation.',
  parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: {
    url: { type: 'string', description: 'Complete HTTP/HTTPS URL, without credentials.' },
    engine: { type: 'string', enum: ['deepseek', 'tavily'], description: 'Explicit choice disables automatic fallback for this call.' },
    maxChars: { type: 'integer', description: 'Maximum body characters, default 8000, between 200 and 40000.' },
  } },
};

export interface SearchServiceOptions {
  cfg: BrowserConfigSection;
  secret?: (name: string) => string;
  storeSecret?: (name: string, value: string) => void;
  request?: typeof fetch;
}

const valueOf = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const fail = (message: string): ToolOutcome => ({ failed: true, text: `[browser] ${message}` });
const clip = (value: string, count: number) => value.length > count ? `${value.slice(0, count)}…` : value;

export class BrowserSearchService {
  private readonly api: SearchApi;
  private lifecycle = new AbortController();
  constructor(private readonly opts: SearchServiceOptions) {
    opts.cfg.search ??= structuredClone(SEARCH_DEFAULTS);
    this.api = new SearchApi(opts.request);
  }

  start(): void { if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController(); }
  stop(): void { this.lifecycle.abort(); }

  private context(ctx: ToolCallContext): ToolCallContext {
    return { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, this.lifecycle.signal]) : this.lifecycle.signal };
  }

  private key(id: SearchProviderId): string {
    return isPageProvider(id) ? '' : (this.opts.secret?.(SEARCH_SECRETS[id]) ?? '').trim();
  }

  state(): SearchSettingsState {
    const cfg = this.opts.cfg;
    const search = cfg.search;
    const legacy = isSearchEngineId(cfg.searchEngine) ? cfg.searchEngine : 'bing';
    return {
      order: providerOrder(search.order, legacy),
      enabled: Object.fromEntries(SEARCH_PROVIDERS.map(id => [id, search[id]?.enabled ?? SEARCH_DEFAULTS[id].enabled])) as SearchSettingsState['enabled'],
      configured: { deepseek: !!this.key('deepseek'), tavily: !!this.key('tavily') },
      fallbackEnabled: search.fallbackEnabled, tavilySearchDepth: search.tavily.searchDepth,
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      panels: [{ id: 'search', title: '搜索设置', description: '引擎优先级、启用状态与 API key。' }],
      config: [SEARCH_CONFIG_GROUP],
      invoke: async (_panel, method, args) => {
        if (method === 'state') return this.state();
        if (method === 'save-key') {
          const input = args[0] as { engine?: unknown; value?: unknown } | undefined;
          if (input?.engine !== 'deepseek' && input?.engine !== 'tavily') throw new Error('未知的 API 引擎。');
          const key = valueOf(input.value);
          if (!key || key.length > 4096 || /\s/.test(key)) throw new Error('请输入有效的 API key。');
          if (!this.opts.storeSecret) throw new Error('宿主未提供密钥保存接口。');
          try { this.opts.storeSecret(SEARCH_SECRETS[input.engine], key); }
          catch { throw new Error('密钥保存失败，请检查部署 .env 是否可写。'); }
          return this.state();
        }
        throw new Error('未知的搜索设置操作。');
      },
    };
  }

  private candidates(asked: string, fetchOnly: boolean): SearchProviderId[] {
    const s = this.state();
    if (asked) {
      if (!isSearchProvider(asked) || (fetchOnly && isPageProvider(asked))) throw new SearchApiError('未知或不支持的引擎。');
      if (!s.enabled[asked]) throw new SearchApiError(`${SEARCH_LABELS[asked]} 已在设置中禁用。`);
      if (!isPageProvider(asked) && !s.configured[asked]) throw new SearchApiError(`${SEARCH_LABELS[asked]} 尚未配置 API key。`);
      return [asked];
    }
    const available = s.order.filter(id => s.enabled[id] && (!fetchOnly || !isPageProvider(id)) && (isPageProvider(id) || s.configured[id]));
    if (!available.length) throw new SearchApiError(fetchOnly ? '没有可用的抓取引擎：请启用 DeepSeek 或 Tavily 并填写 API key。' : '没有可用的搜索引擎：请在 Browser 搜索设置中启用并配置。');
    return s.fallbackEnabled ? available : available.slice(0, 1);
  }

  private async run(asked: string, fetchOnly: boolean, ctx: ToolCallContext, call: (id: SearchProviderId) => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const attempts: string[] = [];
    try {
      const ids = this.candidates(asked, fetchOnly);
      for (const id of ids) {
        if (ctx.signal?.aborted) return fail('操作已取消。');
        try {
          const result = await call(id);
          if (ctx.signal?.aborted) return fail('操作已取消。');
          const trail = attempts.length ? `\n已尝试：\n${attempts.join('\n')}` : '';
          return { ...result, text: `引擎：${SEARCH_LABELS[id]} (${id})\n${result.text}${trail}` };
        } catch (error) {
          if (ctx.signal?.aborted) return fail('操作已取消。');
          const apiError = error instanceof SearchApiError ? error : new SearchApiError('搜索执行失败。');
          attempts.push(`${SEARCH_LABELS[id]}：${apiError.message}`);
          if (!apiError.retryable) break;
        }
      }
      return fail(attempts.join('\n'));
    } catch (error) {
      return fail(error instanceof SearchApiError ? error.message : '搜索配置不可用，请检查 Browser 搜索设置。');
    }
  }

  search(args: Record<string, unknown>, ctx: ToolCallContext, page: (id: SearchEngineId, ctx: ToolCallContext) => Promise<ToolOutcome>): Promise<ToolOutcome> {
    ctx = this.context(ctx);
    const query = valueOf(args.query);
    if (!query) return Promise.resolve(fail('query 是空的：给一个要搜的词。'));
    const count = clampCount(typeof args.count === 'number' ? args.count : undefined);
    return this.run(valueOf(args.engine), false, ctx, async id => {
      if (isPageProvider(id)) {
        const out = await page(id, ctx);
        if (out.failed) throw new SearchApiError(out.text, true);
        return out;
      }
      if (id === 'deepseek' && Array.from(query).length > 128) throw new SearchApiError('DeepSeek 搜索词最多 128 个 Unicode 字符，请缩短 query。');
      const results = await this.api.search(id, this.key(id), query, count, this.opts.cfg.search.tavily.searchDepth, this.opts.cfg.requestTimeoutMs, ctx.signal);
      return { text: `搜索：${query}\n${results.length ? results.map((r, i) => `${i + 1}. ${clip(r.title, 150)}\n${r.url}\n来源：${clip(r.source, 150)}\n${clip(r.summary, 1600)}`).join('\n\n') : '没有搜索结果。'}` };
    });
  }

  fetchPage(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    ctx = this.context(ctx);
    let url: string;
    try { url = publicPageUrl(valueOf(args.url)); }
    catch (error) { return Promise.resolve(fail((error as Error).message)); }
    const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? Math.max(200, Math.min(40000, Math.floor(args.maxChars))) : 8000;
    return this.run(valueOf(args.engine), true, ctx, async id => {
      if (isPageProvider(id)) throw new SearchApiError('该引擎不支持抓取。');
      const r = await this.api.fetchPage(id, this.key(id), url, this.opts.cfg.requestTimeoutMs, ctx.signal);
      return { text: `标题：${r.title || '未提供'}\nURL：${r.url}\n\n${r.content.slice(0, maxChars)}${r.content.length > maxChars ? `\n…（正文已截断，共 ${r.content.length} 字符）` : ''}` };
    });
  }
}
