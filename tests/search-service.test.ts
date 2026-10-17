import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { BROWSER_DEFAULTS } from '../src/config.ts';
import { BrowserSearchService } from '../src/search-service.ts';
import { SEARCH_SECRETS, providerOrder, type SearchProviderId } from '../src/search-settings.ts';
import { BrowserWorld } from '../src/world.ts';
import { coerceGroupValues, setByPath } from 'cortico/core/config-schema.ts';
import { SEARCH_CONFIG_GROUP } from '../src/search-settings.ts';

interface Call { path: string; body: Record<string, unknown>; authorization: string }
let calls: Call[];
let respond: (call: Call, res: ServerResponse) => void;
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
};
const fixture = (path: string) => ({ results: [{
  title: 'Example report', url: 'https://example.org/report',
  ...(path.startsWith('/v1/') ? { summary: 'Long summary', snippet: 'Short snippet', site_name: 'Example source', rerank_score: 2 } : { content: 'Relevant passage', score: 0.8 }),
}] });
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const call = { path: req.url!, body: JSON.parse(body), authorization: req.headers.authorization ?? '' };
  calls.push(call);
  respond(call, res);
});
let request: typeof fetch;
let cfg: typeof BROWSER_DEFAULTS;
let keys: Record<string, string>;
let service: BrowserSearchService;
let pages: SearchProviderId[];
const ctx = (signal?: AbortSignal) => ({ signal } as ToolCallContext);
const page = async (id: SearchProviderId): Promise<ToolOutcome> => { pages.push(id); return { text: 'page results target: page-one' }; };

beforeEach(async () => {
  calls = []; pages = [];
  respond = (call, res) => json(res, fixture(call.path));
  for (;;) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    if (port >= 1024 && ![2049,3659,4045,5060,5061,6000,6566,10080].includes(port) && !(port >= 6665 && port <= 6699)) break;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  request = (input, init) => fetch(`${base}${new URL(String(input)).pathname}`, init);
  cfg = structuredClone(BROWSER_DEFAULTS);
  cfg.search.order = 'deepseek,tavily,bing,sogou,baidu';
  keys = { [SEARCH_SECRETS.deepseek]: 'fixture-secret-one', [SEARCH_SECRETS.tavily]: 'fixture-secret-two' };
  service = new BrowserSearchService({ cfg, request, secret: name => keys[name] ?? '', storeSecret: (name, value) => { keys[name] = value; } });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('搜索路由与协议', () => {
  it('升级保留旧默认引擎；新排序去重并补全引擎', async () => {
    cfg.search.order = '';
    cfg.searchEngine = 'sogou';
    expect(providerOrder('tavily,tavily,bad', 'bing')).toEqual(['tavily', 'deepseek', 'bing', 'sogou', 'baidu']);
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('(sogou)');
    expect(pages).toEqual(['sogou']); expect(calls).toHaveLength(0);
  });

  it('DeepSeek 不依赖浏览器可用，输出来源与长摘要', async () => {
    const world = new BrowserWorld({ cfg, timezone: 'UTC', request, secret: name => keys[name] ?? '' });
    const tool = world.tools().find(t => t.name === 'browser_search')!;
    const out = await tool.handler({ query: 'report', count: 4 }, ctx()) as ToolOutcome;
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('Long summary'); expect(out.text).toContain('Example source');
    expect(calls[0].path).toBe('/v1/tools/search');
    expect(calls[0].body).toEqual({ query: 'report', count: 4, need_content: false });
    expect(calls[0].authorization).toBe('Bearer fixture-secret-one');
    expect(out.text).not.toContain('fixture-secret');
    await world.stop();
  });

  it('Tavily 使用独立密钥与深度，映射正文摘要', async () => {
    cfg.search.tavily.searchDepth = 'advanced';
    const out = await service.search({ query: 'report', engine: 'tavily' }, ctx(), page);
    expect(out.text).toContain('Relevant passage'); expect(out.text).toContain('(tavily)');
    expect(calls[0].path).toBe('/search'); expect(calls[0].body.search_depth).toBe('advanced');
    expect(calls[0].body.include_answer).toBe(false);
    expect(calls[0].authorization).toBe('Bearer fixture-secret-two');
  });

  it('排序与启用状态热生效，缺密钥的 API 自动跳过', async () => {
    delete keys[SEARCH_SECRETS.deepseek];
    cfg.search.tavily.enabled = false;
    await service.search({ query: 'report' }, ctx(), page);
    expect(pages).toEqual(['bing']); expect(calls).toHaveLength(0);
    cfg.search.order = 'baidu,bing,sogou,tavily,deepseek';
    await service.search({ query: 'report' }, ctx(), page);
    expect(pages).toEqual(['bing', 'baidu']);
  });

  it('自动切换默认关闭，服务报错只调用首选引擎', async () => {
    respond = (_call, res) => json(res, { error: 'fixture-secret-one' }, 503);
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.failed).toBe(true); expect(out.text).toContain('503'); expect(out.text).not.toContain('fixture-secret');
    expect(calls).toHaveLength(1); expect(pages).toHaveLength(0);
  });

  it.each([408, 429, 500, 504])('可切换的 HTTP %s 依次尝试下一家并报告实际引擎', async status => {
    cfg.search.fallbackEnabled = true;
    respond = (call, res) => call.path.startsWith('/v1/') ? json(res, {}, status) : json(res, fixture(call.path));
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.failed).toBeUndefined(); expect(out.text).toContain('(tavily)'); expect(out.text).toContain('已尝试');
    expect(calls.map(c => c.path)).toEqual(['/v1/tools/search', '/search']);
  });

  it.each([400, 401, 402, 403, 422, 432, 433])('HTTP %s 停止，不消耗备用引擎额度', async status => {
    cfg.search.fallbackEnabled = true;
    respond = (_call, res) => json(res, {}, status);
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.failed).toBe(true); expect(calls).toHaveLength(1); expect(pages).toHaveLength(0);
  });

  it('超时切换；显式指定时不切换', async () => {
    cfg.search.fallbackEnabled = true; cfg.requestTimeoutMs = 100;
    respond = (call, res) => { if (!call.path.startsWith('/v1/')) json(res, fixture(call.path)); };
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('超时'); expect(out.text).toContain('(tavily)');
    calls = [];
    const explicit = await service.search({ query: 'report', engine: 'deepseek' }, ctx(), page);
    expect(explicit.failed).toBe(true); expect(calls).toHaveLength(1);
  });

  it('成功无结果不切换', async () => {
    cfg.search.fallbackEnabled = true;
    respond = (_call, res) => json(res, { results: [] });
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.failed).toBeUndefined(); expect(out.text).toContain('没有搜索结果'); expect(calls).toHaveLength(1);
  });

  it('无效响应切换；无效 URL 及重复结果不进入回执', async () => {
    cfg.search.fallbackEnabled = true;
    respond = (call, res) => call.path.startsWith('/v1/') ? json(res, { broken: true }) : json(res, { results: [
      { title: 'bad', url: 'javascript:alert(1)' }, { title: 'good', url: 'https://example.org', content: 'text' }, { title: 'duplicate', url: 'https://example.org/' },
    ] });
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('good'); expect(out.text).not.toContain('javascript:'); expect(out.text).not.toContain('duplicate');
  });

  it('网络断开及超大响应可切换，响应正文有读取上限', async () => {
    cfg.search.fallbackEnabled = true;
    respond = (call, res) => call.path.startsWith('/v1/') ? res.destroy() : json(res, fixture(call.path));
    expect((await service.search({ query: 'report' }, ctx(), page)).text).toContain('(tavily)');
    calls = [];
    respond = (call, res) => call.path.startsWith('/v1/') ? json(res, { content: 'x'.repeat(4 * 1024 * 1024) }) : json(res, fixture(call.path));
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('4 MiB'); expect(out.text).toContain('(tavily)');
    expect(calls).toHaveLength(2);
  });

  it('声明的配置可经宿主校验保存，顺序与开关立即生效', async () => {
    const result = coerceGroupValues(SEARCH_CONFIG_GROUP, {
      'worlds.browser.search.order': 'tavily,deepseek,bing,sogou,baidu',
      'worlds.browser.search.tavily.enabled': false,
      'worlds.browser.search.deepseek.enabled': false,
      'worlds.browser.search.bing.enabled': false,
      'worlds.browser.search.fallbackEnabled': true,
    });
    if ('error' in result) throw new Error(result.error);
    const root = { worlds: { browser: cfg } };
    for (const [path, value] of Object.entries(result.values)) setByPath(root, path, value);
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('(sogou)'); expect(calls).toHaveLength(0);
  });

  it('取消当前请求后不再调用下一家', async () => {
    cfg.search.fallbackEnabled = true;
    const controller = new AbortController();
    respond = () => controller.abort();
    const out = await service.search({ query: 'report' }, ctx(controller.signal), page);
    expect(out.failed).toBe(true); expect(out.text).toContain('取消'); expect(calls).toHaveLength(1);
    await service.search({ query: 'report' }, ctx(controller.signal), page);
    expect(calls).toHaveLength(1);
  });

  it('停止 World 时取消 API 请求，恢复后可重新调用', async () => {
    cfg.search.fallbackEnabled = true;
    respond = () => service.stop();
    const out = await service.search({ query: 'report' }, ctx(), page);
    expect(out.text).toContain('取消'); expect(calls).toHaveLength(1);
    service.start();
    respond = (call, res) => json(res, fixture(call.path));
    expect((await service.search({ query: 'report' }, ctx(), page)).failed).toBeUndefined();
  });

  it('显式缺密钥、禁用或未知引擎直接失败', async () => {
    delete keys[SEARCH_SECRETS.deepseek];
    cfg.search.tavily.enabled = false;
    for (const engine of ['deepseek', 'tavily', 'unknown']) {
      expect((await service.search({ query: 'report', engine }, ctx(), page)).failed).toBe(true);
    }
    expect(calls).toHaveLength(0); expect(pages).toHaveLength(0);
  });

  it('没有启用引擎时不发送请求；空查询和过长 DeepSeek 查询也停止', async () => {
    expect((await service.search({ query: '' }, ctx(), page)).failed).toBe(true);
    expect((await service.search({ query: '字'.repeat(129) }, ctx(), page)).failed).toBe(true);
    for (const id of service.state().order) cfg.search[id].enabled = false;
    expect((await service.search({ query: 'report' }, ctx(), page)).text).toContain('没有可用');
    expect(calls).toHaveLength(0);
  });

  it('API 故障可退回网页引擎；失败网页的 target 保留在最终回执', async () => {
    cfg.search.fallbackEnabled = true;
    respond = (_call, res) => json(res, {}, 503);
    const out = await service.search({ query: 'report' }, ctx(), async id => {
      pages.push(id);
      return id === 'bing' ? { text: '导航失败 target: leftover', failed: true } : { text: 'page result' };
    });
    expect(pages).toEqual(['bing', 'sogou']); expect(out.text).toContain('target: leftover'); expect(out.text).toContain('(sogou)');
  });
});

describe('抓取与密钥设置', () => {
  it.each(['deepseek', 'tavily'] as const)('%s 抓取统一为正文，截断时明确标记', async engine => {
    respond = (_call, res) => json(res, engine === 'deepseek' ? { title: 'Article', content: 'x'.repeat(250) } : { results: [{ url: 'https://example.org', raw_content: 'x'.repeat(250) }], failed_results: [] });
    const out = await service.fetchPage({ engine, url: 'https://example.org', maxChars: 200 }, ctx());
    expect(out.failed).toBeUndefined(); expect(out.text).toContain('正文已截断'); expect(out.text).toContain(`(${engine})`);
    expect(calls[0].path).toBe(engine === 'deepseek' ? '/v1/tools/fetch' : '/extract');
    expect(calls[0].body).toEqual(engine === 'deepseek' ? { url: 'https://example.org/' } : { urls: ['https://example.org/'], format: 'markdown', extract_depth: 'basic' });
    expect(pages).toHaveLength(0);
  });

  it('抓取仅按 API 引擎顺序切换，网页引擎被跳过', async () => {
    cfg.search.order = 'bing,deepseek,baidu,tavily,sogou'; cfg.search.fallbackEnabled = true;
    respond = (call, res) => call.path.startsWith('/v1/') ? json(res, {}, 504) : json(res, { results: [{ raw_content: 'body' }] });
    const out = await service.fetchPage({ url: 'https://example.org' }, ctx());
    expect(out.text).toContain('(tavily)'); expect(calls.map(c => c.path)).toEqual(['/v1/tools/fetch', '/extract']);
  });

  it('抓取失败或没有正文如实返回，不把空内容当成功', async () => {
    respond = (_call, res) => json(res, { results: [], failed_results: [{ error: 'secret body' }] });
    const out = await service.fetchPage({ url: 'https://example.org', engine: 'tavily' }, ctx());
    expect(out.failed).toBe(true); expect(out.text).not.toContain('secret body');
    for (const url of ['file:///tmp/x', 'https://user:password@example.org', 'bad']) {
      expect((await service.fetchPage({ url }, ctx())).failed).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('密钥由宿主保存并立即可用，不进入配置或状态', async () => {
    delete keys[SEARCH_SECRETS.deepseek];
    const ui = service.webUi();
    const value = 'fixture-new-secret';
    const state = await ui.invoke!('search', 'save-key', [{ engine: 'deepseek', value }]);
    expect(JSON.stringify(state)).not.toContain(value);
    expect(JSON.stringify(cfg)).not.toContain(value);
    expect(service.state().configured.deepseek).toBe(true);
    await service.search({ query: 'report' }, ctx(), page);
    expect(calls[0].authorization).toBe(`Bearer ${value}`);
    await expect(ui.invoke!('search', 'save-key', [{ engine: 'unknown', value }])).rejects.toThrow();
    await expect(ui.invoke!('search', 'save-key', [{ engine: 'deepseek', value: 'bad\nkey' }])).rejects.toThrow();
  });
});
