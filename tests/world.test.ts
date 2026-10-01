import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { RelayError, classifyRelayError } from '../src/cdp-client.ts';
import type { BrowserConfigSection } from '../src/config.ts';
import { BROWSER } from '../src/definition.ts';
import { OwnBrowser, chromeProfileDir, devToolsActivePortFile, ownBrowserArgs } from '../src/own-browser.ts';
import type { BrowserWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let servers: Server[] = [];
let worlds: BrowserWorld[] = [];

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'browser-world-'));
  servers = [];
  worlds = [];
});

afterEach(async () => {
  for (const world of worlds) await world.stop().catch(() => {});
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchDir, { recursive: true, force: true });
});

// ——— 假的 cdp-proxy：真的 HTTP 服务，行为可按用例改 ———

interface FakeProxy {
  port: number;
  /** 浏览器里此刻开着的页面。 */
  pages: Array<{ targetId: string; url: string; title: string }>;
  /** `/eval` 回什么（按我们那层包装的形状：{ ok, value } 或 { ok: false, error }）。 */
  evalReply: (expression: string) => unknown;
  /** 设了就让 `/eval` 以这个状态码回 `{ error: 'Uncaught' }`。 */
  evalStatus: number | null;
  /** proxy 在跑但浏览器没连上。 */
  browserDown: boolean;
  /** `/health` 里报的"实际连着的 CDP 端口"。给 0 表示不报这一项。 */
  chromePort: number;
  /** `/new` 收到的正文（我们只该发 `about:blank`：建 tab 与导航是两步）。 */
  openBodies: string[];
  /** `/navigate` 收到的地址。 */
  navBodies: string[];
  /** 设了就让 `/navigate` 先拖这么久——用来验导航那一段用的是更宽的超时。 */
  navDelayMs: number;
  /** 设了就让 `/navigate` 回这个状态码 + `CDP 命令超时: Page.navigate`（站点打不开的现场）。 */
  navStatus: number | null;
  evalBodies: string[];
  hits: string[];
  closed: string[];
}

async function fakeProxy(): Promise<FakeProxy> {
  let seq = 0;
  const state: FakeProxy = {
    port: 0,
    pages: [],
    evalReply: () => ({ ok: true, value: null }),
    evalStatus: null,
    browserDown: false,
    chromePort: 0,
    openBodies: [],
    navBodies: [],
    navDelayMs: 0,
    navStatus: null,
    evalBodies: [],
    hits: [],
    closed: [],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    state.hits.push(path);
    const body = (): Promise<string> =>
      new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk: Buffer) => {
          text += String(chunk);
        });
        req.on('end', () => resolve(text));
      });
    const json = (value: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    void (async () => {
      if (path === '/health') {
        json({
          status: 'ok',
          connected: !state.browserDown,
          browser: { id: 'chrome', label: 'Chrome', source: 'preference' },
          managedTabs: state.pages.length,
          chromePort: state.chromePort,
        });
        return;
      }
      if (state.browserDown) {
        json({ error: 'Chrome 未开启远程调试端口' }, 500);
        return;
      }
      if (path === '/targets') {
        json(state.pages.map((page) => ({ ...page, type: 'page' })));
        return;
      }
      if (path === '/new') {
        const target = (await body()).trim();
        state.openBodies.push(target);
        seq += 1;
        const targetId = `T${seq}`;
        state.pages.push({ targetId, url: target, title: `页面${seq}` });
        json({ targetId });
        return;
      }
      if (path === '/info') {
        const page = state.pages.find((item) => item.targetId === url.searchParams.get('target'));
        json({ title: page?.title ?? '', url: page?.url ?? '', ready: 'complete' });
        return;
      }
      if (path === '/eval') {
        const sent = await body();
        state.evalBodies.push(sent);
        if (state.evalStatus !== null) {
          json({ error: 'Uncaught' }, state.evalStatus);
          return;
        }
        json({ value: state.evalReply(sent) });
        return;
      }
      if (path === '/click' || path === '/clickAt') {
        json({ clicked: true, tag: 'button', text: '提交' });
        return;
      }
      if (path === '/setFiles') {
        const parsed = JSON.parse(await body()) as { files?: unknown[] };
        json({ success: true, files: parsed.files?.length ?? 0 });
        return;
      }
      if (path === '/scroll') {
        json({ value: `scrolled ${url.searchParams.get('direction') ?? 'down'}` });
        return;
      }
      if (path === '/screenshot') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      if (path === '/navigate') {
        const to = (await body()).trim();
        state.navBodies.push(to);
        if (state.navDelayMs > 0) await sleep(state.navDelayMs);
        if (state.navStatus !== null) {
          // 上游在宿主不回话时的原话：Page.navigate 等满它自己的 30 秒 CDP 超时。
          json({ error: 'CDP 命令超时: Page.navigate' }, state.navStatus);
          return;
        }
        const page = state.pages.find((item) => item.targetId === url.searchParams.get('target'));
        if (page) page.url = to;
        json({ frameId: 'frame-1' });
        return;
      }
      if (path === '/back') {
        json({ ok: true });
        return;
      }
      if (path === '/close') {
        const target = String(url.searchParams.get('target'));
        state.closed.push(target);
        state.pages = state.pages.filter((item) => item.targetId !== target);
        json({ success: true });
        return;
      }
      json({ error: `未知端点 ${path}` }, 404);
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  return state;
}

/** 一个指向假 proxy 的部署上下文。 */
function contextAt(port: number, patch: Partial<BrowserConfigSection> = {}) {
  const ctx = fakeWorldContext(BROWSER, { scratchDir });
  ctx.persist({ browser: 'chrome', port, ...patch });
  return ctx;
}

function startedWorld(port: number, patch: Partial<BrowserConfigSection> = {}): BrowserWorld {
  const world = BROWSER.create(contextAt(port, patch)) as BrowserWorld;
  worlds.push(world);
  return world;
}

async function call(world: BrowserWorld, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const tool = world.tools().find((item) => item.name === name);
  if (!tool) throw new Error(`没有 ${name} 这个工具`);
  const out = await tool.handler(args, {} as ToolCallContext);
  return typeof out === 'string' ? { text: out } : out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 空出来的端口：让「自己拉起」那条路有个确定的地方去听。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 一个"存在就行"的可执行文件：preflight 只检查它存不存在，不会真去跑它。
 * （真拉起浏览器那一段由实机冒烟覆盖，见设计记录。）
 */
function writeFakeExe(dir: string): string {
  const file = join(dir, 'chrome.exe');
  writeFileSync(file, 'not a real browser');
  return file;
}

/**
 * 假的"浏览器自己的调试口"：只回 `/json/version`，也就是我们探活与拿 ws 地址用的那一个口。
 * 它的 `webSocketDebuggerUrl` 指向它自己——那不是一个真的 WebSocket 服务，所以"调前台"
 * 会在这里失败，正好用来验失败那条路。
 */
async function fakeBrowserCdp(): Promise<{ port: number; wsUrl: string }> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/json/version')) {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE-UUID` }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, wsUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE-UUID` };
}

/** 一个最小的、真的是这个协议的 proxy：给自己拉起那条路当靶子。 */
function writeProxyScript(dir: string): void {  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'cdp-proxy.mjs'),
    [
      "import http from 'node:http';",
      "const port = Number(process.env.CDP_PROXY_PORT || 3456);",
      'const server = http.createServer((req, res) => {',
      "  const path = new URL(req.url, 'http://127.0.0.1').pathname;",
      "  if (path === '/health' || path === '/targets') {",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(path === '/health'",
      "      ? JSON.stringify({ status: 'ok', connected: true, browser: { id: 'chrome', label: 'Chrome' }, managedTabs: 0 })",
      "      : '[]');",
      '    return;',
      '  }',
      "  res.writeHead(404, { 'content-type': 'application/json' });",
      "  res.end('{\"error\":\"未知端点\"}');",
      '});',
      "server.listen(port, '127.0.0.1');",
    ].join('\n'),
  );
}

const PAGE_DUMP = {
  ok: true,
  value: {
    title: '甲页面',
    url: 'https://example.com/a',
    ready: 'complete',
    text: '这是一段正文。',
    links: [{ text: '更多', url: 'https://example.com/more' }],
    truncated: false,
  },
};

describe('Browser World', () => {
  it('干装载不报失败：装载器会接受它', async () => {
    const report = await dryMountWorld(BROWSER, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('工具表：十三个工具，都带 browser_ 前缀和非空标签', () => {
    const world = startedWorld(3456);
    const tools = world.tools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_open',
      'browser_read',
      'browser_js',
      'browser_click',
      'browser_type',
      'browser_upload',
      'browser_scroll',
      'browser_shot',
      'browser_navigate',
      'browser_tabs',
      'browser_focus',
      'browser_close',
      'browser_find_url',
    ]);
    for (const tool of tools) {
      expect(tool.name.startsWith('browser_')).toBe(true);
      expect(tool.tags.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
    }
  });

  it('环境提示词报占位符值：借他日常那个浏览器时，是"后台 tab"那一种', () => {
    const world = startedWorld(3456, { browser: 'edge' });
    const vars = world.envPromptVars();
    expect(vars['browser.label']).toBe('Edge');
    expect(vars['browser.kind']).toContain('操作员日常');
    expect(vars['browser.front']).toContain('后台 tab');
  });

  it('环境提示词：她自己的实例说成"会被带到最前面"', () => {
    const world = startedWorld(3456, { browser: 'chrome', ownBrowser: true, ownBrowserPort: 9223 });
    const vars = world.envPromptVars();
    expect(vars['browser.kind']).toContain('专属实例');
    expect(vars['browser.front']).toContain('带到最前面');
  });

  it('没有子进程时 stop() 是空操作', async () => {
    const world = startedWorld(3456);
    await expect(world.stop()).resolves.toBeUndefined();
  });

  describe('激活前检查', () => {
    it('skillDir 没配时说清楚要填什么', () => {
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      expect(() => BROWSER.preflight!(ctx)).toThrow(/skillDir 没配/);
    });

    it('目录不存在时指出那个目录', () => {
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({ skillDir: join(scratchDir, '没有这个目录'), browser: 'chrome' });
      expect(() => BROWSER.preflight!(ctx)).toThrow(/不存在/);
    });

    it('目录里没有 cdp-proxy.mjs 时点名它', () => {
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({ skillDir: scratchDir, browser: 'chrome' });
      expect(() => BROWSER.preflight!(ctx)).toThrow(/cdp-proxy\.mjs/);
    });

    it('browser 没配或写了别的名字时都拦下', () => {
      writeProxyScript(scratchDir);
      const bare = fakeWorldContext(BROWSER, { scratchDir });
      bare.persist({ skillDir: scratchDir });
      expect(() => BROWSER.preflight!(bare)).toThrow(/browser 没配/);

      const wrong = fakeWorldContext(BROWSER, { scratchDir });
      wrong.persist({ skillDir: scratchDir, browser: 'firefox' });
      expect(() => BROWSER.preflight!(wrong)).toThrow(/chrome \/ edge \/ chromium/);
    });

    it('配齐了就通过', () => {
      writeProxyScript(scratchDir);
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({ skillDir: scratchDir, browser: 'chrome' });
      expect(() => BROWSER.preflight!(ctx)).not.toThrow();
    });

    it('开了专属实例但没填程序/目录时，逐条点名', () => {
      writeProxyScript(scratchDir);
      const noExe = fakeWorldContext(BROWSER, { scratchDir });
      noExe.persist({ skillDir: scratchDir, browser: 'chrome', ownBrowser: true });
      expect(() => BROWSER.preflight!(noExe)).toThrow(/ownBrowserExe 没配/);

      const missingExe = fakeWorldContext(BROWSER, { scratchDir });
      missingExe.persist({
        skillDir: scratchDir,
        browser: 'chrome',
        ownBrowser: true,
        ownBrowserExe: join(scratchDir, '没有这个.exe'),
      });
      expect(() => BROWSER.preflight!(missingExe)).toThrow(/不存在/);

      const noHome = fakeWorldContext(BROWSER, { scratchDir });
      noHome.persist({
        skillDir: scratchDir,
        browser: 'chrome',
        ownBrowser: true,
        ownBrowserExe: writeFakeExe(scratchDir),
      });
      expect(() => BROWSER.preflight!(noHome)).toThrow(/ownBrowserHome 没配/);
    });

    it('专属实例只认 chrome：指了别的浏览器就拦下', () => {
      writeProxyScript(scratchDir);
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({
        skillDir: scratchDir,
        browser: 'edge',
        ownBrowser: true,
        ownBrowserExe: writeFakeExe(scratchDir),
        ownBrowserHome: join(scratchDir, 'home'),
      });
      expect(() => BROWSER.preflight!(ctx)).toThrow(/只拉了 Chrome/);
    });
  });

  describe('起停', () => {
    it('已在运行的 proxy 被复用，投一条 internal 的就绪事件，stop 不关它', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.ready']);
      expect(host.events[0].origin).toBe('internal');
      expect(host.events[0].source).toBe('browser');

      await world.stop();
      const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
      expect(res.ok).toBe(true);
    });

    it('端口上没有 proxy 时自己拉起，stop 之后关掉自己拉起的那个', async () => {
      const port = await freePort();
      writeProxyScript(scratchDir);
      const world = startedWorld(port, { skillDir: scratchDir, readyTimeoutMs: 8000 });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.ready']);
      const alive = await fetch(`http://127.0.0.1:${port}/health`);
      expect(alive.ok).toBe(true);

      await world.stop();
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    });

    it('proxy 在跑但浏览器没连上：投 browser.down，不抛错', async () => {
      const proxy = await fakeProxy();
      proxy.browserDown = true;
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
      expect(host.events[0].origin).toBe('internal');
      expect(host.events[0].text).toContain('inspect');
    });

    it('端口被别的程序占着时先说清原因，不去拉一个抢端口的', async () => {
      const busy = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      servers.push(busy);
      await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
      const port = (busy.address() as AddressInfo).port;

      writeProxyScript(scratchDir);
      const world = startedWorld(port, { skillDir: scratchDir, readyTimeoutMs: 1500 });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
      expect(host.events[0].text).toContain('端口');
      expect(host.events[0].text).toContain('别的程序');
    });

    it('拉起来的东西立刻死掉时也投 browser.down，不抛错', async () => {
      const port = await freePort();
      mkdirSync(join(scratchDir, 'scripts'), { recursive: true });
      const world = startedWorld(port, { skillDir: scratchDir, readyTimeoutMs: 1500 });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
    });
  });

  describe('工具', () => {
    it('browser_open：回 target、标题、正文与链接，表达式里带上了读页那段', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => PAGE_DUMP;
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/a' });
      expect(out.failed).toBeUndefined();
      expect(out.text).toContain('target T1');
      expect(out.text).toContain('甲页面');
      expect(out.text).toContain('这是一段正文。');
      expect(out.text).toContain('https://example.com/more');
      expect(proxy.evalBodies.at(-1)).toContain('shadowRoot');
      expect(proxy.pages[0].url).toBe('https://example.com/a');
    });

    it('browser_open 分两步：先建空白 tab 认出 id，再单独导航', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => PAGE_DUMP;
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/a' });
      expect(out.failed).toBeUndefined();
      // 建 tab 那一步只发 about:blank，地址走 /navigate：两步才认得住 id，孤儿就是这么来的。
      expect(proxy.openBodies).toEqual(['about:blank']);
      expect(proxy.navBodies).toEqual(['https://example.com/a']);
      // 认下来了：她关得掉（失败那一路也认，见下一条）。
      const closed = await call(world, 'browser_close', { target: 'T1' });
      expect(closed.failed).toBeUndefined();
      expect(closed.text).toContain('已关闭');
    });

    it('站点打不开（上游 CDP 命令超时）：说清哪一类、不贴开关那句，tab 留着且关得掉', async () => {
      const proxy = await fakeProxy();
      proxy.navStatus = 500;
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com' });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('页面没打开');
      expect(out.text).toContain('不是浏览器坏了');
      expect(out.text).not.toContain('inspect'); // 2026-09-30 那次被带偏的就是这一句
      expect(out.text).toContain('target: T1'); // 页面还开着、认得出

      const closed = await call(world, 'browser_close', { target: 'T1' });
      expect(closed.failed).toBeUndefined();
      expect(closed.text).toContain('已关闭');
    });

    it('导航那一段用的是更宽的超时：比 requestTimeoutMs 慢的导航仍然成', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => PAGE_DUMP;
      proxy.navDelayMs = 3500; // 普通调用超时是 3000 的下限，导航那一段是 35 秒
      const world = startedWorld(proxy.port, { skillDir: scratchDir, requestTimeoutMs: 3000 });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/slow' });
      expect(out.failed).toBeUndefined();
      expect(out.text).toContain('target T1');
    }, 15000);

    it('browser_read：选择器与字数上限透传进去，正文空时提示去截图', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'T1', url: 'https://example.com/a', title: '甲' }];
      proxy.evalReply = () => ({ ...PAGE_DUMP, value: { ...PAGE_DUMP.value, text: '', links: [] } });
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_read', { target: 'T1', selector: 'main article', maxChars: 2000 });
      expect(out.text).toContain('正文是空的');
      expect(proxy.evalBodies.at(-1)).toContain('main article');
      expect(proxy.evalBodies.at(-1)).toContain('2000');
    });

    it('browser_read：选择器不存在时回失败，并点名那个选择器', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => ({ ok: true, value: { ...PAGE_DUMP.value, error: '这个选择器在页面上找不到: #没有' } });
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_read', { target: 'T1', selector: '#没有' });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('#没有');
    });

    it('browser_js：值渲染出来；页面抛错时回失败', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => ({ ok: true, value: 42 });
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const ok = await call(world, 'browser_js', { target: 'T1', expression: '21 * 2' });
      expect(ok.text).toContain('42');
      expect(proxy.evalBodies.at(-1)).toContain('21 * 2');
      expect(proxy.evalBodies.at(-1)).toContain('try {');

      proxy.evalReply = () => ({ ok: false, error: 'TypeError: 某某 is not a function' });
      const bad = await call(world, 'browser_js', { target: 'T1', expression: '某某()' });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('TypeError');
    });

    it('browser_js：语法错误时告诉模型这里只收表达式', async () => {
      const proxy = await fakeProxy();
      proxy.evalStatus = 400;
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_js', { target: 'T1', expression: 'const a = 1; a' });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('只收表达式');
    });

    it('browser_click：默认 JS 点击，native 走真实鼠标那条路', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const plain = await call(world, 'browser_click', { target: 'T1', selector: 'button.submit' });
      expect(plain.text).toContain('已点击');
      expect(proxy.hits).toContain('/click');

      const native = await call(world, 'browser_click', { target: 'T1', selector: 'button.upload', native: true });
      expect(native.text).toContain('真实鼠标');
      expect(proxy.hits).toContain('/clickAt');
    });

    it('browser_type：填进去之后回执带当前值与提交方式；选项不存在时回失败', async () => {
      const proxy = await fakeProxy();
      proxy.evalReply = () => ({ ok: true, value: { ok: true, applied: 'value', value: '北京时间', submitted: 'form' } });
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_type', { target: 'T1', selector: 'input', value: '北京时间', submit: true });
      expect(out.text).toContain('北京时间');
      expect(out.text).toContain('已提交');
      expect(proxy.evalBodies.at(-1)).toContain('requestSubmit');

      proxy.evalReply = () => ({ ok: true, value: { ok: false, error: '这个 select 里没有这个选项: 乙' } });
      const bad = await call(world, 'browser_type', { target: 'T1', selector: 'select', value: '乙' });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('没有这个选项');
    });

    it('browser_upload：报挂上了几个文件', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_upload', {
        target: 'T1',
        selector: 'input[type=file]',
        files: ['C:\\work\\a.png', 'C:\\work\\b.png'],
      });
      expect(out.text).toContain('2 个文件');
    });

    it('browser_scroll：把方向透传过去', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_scroll', { target: 'T1', to: 'bottom' });
      expect(out.text).toContain('bottom');
    });

    it('browser_shot：回执挂上 PNG 附件', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'T1', url: 'https://example.com/a', title: '甲' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_shot', { target: 'T1' });
      const blob = out.blobs?.[0] as { mime: string; bytes: Uint8Array } | undefined;
      expect(out.blobs).toHaveLength(1);
      expect(blob?.mime).toBe('image/png');
      expect(Array.from(blob?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(out.text).toContain('视口');
    });

    it('browser_navigate：url 补协议，back 走后一条路', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'T1', url: 'https://example.com/a', title: '甲' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const moved = await call(world, 'browser_navigate', { target: 'T1', url: 'example.com/b' });
      expect(moved.text).toContain('已导航');
      expect(proxy.hits).toContain('/navigate');

      const back = await call(world, 'browser_navigate', { target: 'T1', back: true });
      expect(back.text).toContain('已后退');
      expect(proxy.hits).toContain('/back');
    });

    it('browser_tabs：标注哪些是她自己开的', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'HIS', url: 'https://example.com/his', title: '他开的' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('他开的');
      expect(out.text).toContain('（我开的）');
      expect(out.text).toContain('target: HIS');
    });

    it('browser_close：只关自己开的，别人的拒绝并说明', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'HIS', url: 'https://example.com/his', title: '他开的' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const refused = await call(world, 'browser_close', { target: 'HIS' });
      expect(refused.failed).toBe(true);
      expect(refused.text).toContain('不是我开的');
      expect(proxy.closed).toEqual([]);

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const mineTarget = proxy.pages.at(-1)!.targetId;
      const closed = await call(world, 'browser_close', { target: mineTarget });
      expect(closed.text).toContain('已关闭');
      expect(proxy.closed).toEqual([mineTarget]);
    });

    it('browser_find_url：原样透传那个脚本的输出；skillDir 没配时直接失败', async () => {
      const proxy = await fakeProxy();
      const dir = join(scratchDir, 'web-access');
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(
        join(dir, 'scripts', 'find-url.mjs'),
        [
          "const argv = process.argv.slice(2);",
          "if (argv.includes('找不到')) { console.error('没有找到浏览器数据目录'); process.exit(1); }",
          "console.log('[历史] 1 条（按最近访问）');",
          "console.log('  内部系统 | https://intra.example.com/dash | 2026-09-18 10:00:00 | visits=3');",
        ].join('\n'),
      );
      const world = startedWorld(proxy.port, { skillDir: dir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_find_url', { keywords: ['内部系统'], only: 'history' });
      expect(out.text).toContain('[历史] 1 条');
      expect(out.text).toContain('intra.example.com');

      const bad = await call(world, 'browser_find_url', { keywords: ['找不到'] });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('没有找到浏览器数据目录');

      const missing = await call(startedWorld(proxy.port), 'browser_find_url', { keywords: ['x'] });
      expect(missing.failed).toBe(true);
      expect(missing.text).toContain('skillDir');

      const noScript = await call(startedWorld(proxy.port, { skillDir: scratchDir }), 'browser_find_url', {
        keywords: ['x'],
      });
      expect(noScript.failed).toBe(true);
      expect(noScript.text).toContain('find-url.mjs');
    });

    it('浏览器不可用时工具回失败，并指出要去开哪个开关', async () => {
      const world = startedWorld(9); // 9 端口上不会有东西
      const out = await call(world, 'browser_tabs');
      expect(out.failed).toBe(true);
      expect(out.text).toContain('浏览器不可用');
      expect(out.text).toContain('inspect');
    });
  });

  describe('他此刻在干什么（拉取式：她问才看）', () => {
    it('第一回看只列页面，没有变化段', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a', title: '甲' },
        { targetId: 'HIS2', url: 'https://github.com/x', title: '拉取请求' },
      ];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('浏览器里现在有 2 个页面');
      expect(out.text).toContain('拉取请求');
      expect(out.text).not.toContain('[变化]');
    });

    it('他开了、转了、关掉之后，第二回看带出净变化', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a', title: '甲' },
        { targetId: 'HIS2', url: 'https://example.com/b', title: '乙' },
      ];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      // 他：把甲那页转到别的地址，把乙关掉，又新开一页。
      proxy.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a2', title: '甲改' },
        { targetId: 'HIS3', url: 'https://bilibili.com/v/x', title: '视频' },
      ];
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('[变化] 距你上次看');
      expect(out.text).toContain('转到 example.com「甲改」');
      expect(out.text).toContain('打开 bilibili.com「视频」');
      expect(out.text).toContain('关掉 example.com「乙」');
    });

    it('中间那一段没在采样：变化是两次查看之间的净变化', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      // 他开了一个又关掉，全程夹在两次查看之间。
      proxy.pages = [{ targetId: 'TMP', url: 'https://example.com/tmp', title: '一闪而过' }];
      await call(world, 'browser_tabs'); // 这一回会报「打开」
      proxy.pages = [];
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('关掉 example.com「一闪而过」');
    });

    it('她自己开的页面不算他的变化', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('（我开的）');
      expect(out.text).not.toContain('[变化]');
    });

    it('浏览器的内部页面只在列表里，不进变化段', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      proxy.pages = [{ targetId: 'NEWTAB', url: 'chrome://newtab/', title: '新标签页' }];
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('新标签页');
      expect(out.text).not.toContain('[变化]');
    });

    it('重启后的第一回看只打底，不把已经开着的页面当成他的变化', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');
      await world.stop();

      await world.start(new FakeHost());
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('甲');
      expect(out.text).not.toContain('[变化]');
    });
  });
});

describe('失败归类（决定回执贴哪句话）', () => {
  it('认得出四类：命令没回话、连不上 proxy、浏览器没连上、proxy 报的其他错', () => {
    expect(classifyRelayError(new RelayError('CDP 命令超时: Page.navigate', 500))).toBe('command-timeout');
    expect(classifyRelayError(new RelayError('连不上 cdp-proxy（http://127.0.0.1:3517）：The operation was aborted due to timeout', 0))).toBe('unreachable');
    expect(classifyRelayError(new RelayError('Chrome 未开启远程调试端口', 500))).toBe('not-connected');
    expect(classifyRelayError(new RelayError('WebSocket 未连接', 500))).toBe('not-connected');
    expect(classifyRelayError(new RelayError('未知端点 /x', 404))).toBe('relay');
  });
});

/**
 * 她自己的浏览器实例（2026-10-01 加）。
 *
 * 这一组钉的是**决策与 HTTP 那半**：启动参数齐不齐、发现文件写到哪儿、实例已在跑时复用、
 * 以及"开页之后确实去调了前台"。
 *
 * 真拉起一个浏览器、以及裸 WebSocket 上的 `Target.activateTarget` 本身，单测不覆盖——
 * 那两段由 `pnpm smoke` 对着真的 Chrome 跑（见设计记录「验证」一节）。
 */
describe('她自己的浏览器实例', () => {
  /** 一份"配齐了"的专属实例配置，指向用例自己起的假浏览器口。 */
  function ownPatch(cdpPort: number): Partial<BrowserConfigSection> {
    return {
      skillDir: scratchDir,
      browser: 'chrome',
      ownBrowser: true,
      ownBrowserExe: writeFakeExe(scratchDir),
      ownBrowserHome: join(scratchDir, 'home'),
      ownBrowserPort: cdpPort,
    };
  }

  it('启动参数：让"前台能播"的那几条都在（谁删掉谁负责）', () => {
    const args = ownBrowserArgs({ exePath: 'chrome.exe', home: 'H', cdpPort: 9223 });
    expect(args).toContain(`--user-data-dir=${chromeProfileDir('H')}`);
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--remote-allow-origins=*');
    expect(args).toContain('--autoplay-policy=no-user-gesture-required');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args.some((arg) => arg.includes('CalculateNativeWinOcclusion'))).toBe(true);
    expect(args).toContain('--no-first-run');
  });

  it('发现文件的位置：照 Chrome 自己的布局放在她的"家"里', () => {
    expect(chromeProfileDir('H')).toBe(join('H', 'Google', 'Chrome', 'User Data'));
    expect(devToolsActivePortFile('H')).toBe(join('H', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'));
  });

  it('实例已经在跑时：复用它（不 spawn），并把发现文件刷新成它现在的端口与 ws 路径', async () => {
    const cdp = await fakeBrowserCdp();
    const home = join(scratchDir, 'home');
    const own = new OwnBrowser({ exePath: writeFakeExe(scratchDir), home, cdpPort: cdp.port });

    expect(await own.ensure(new FakeHost().log, 3000)).toBeNull();
    expect(own.owned).toBe(false); // 复用来的，不该被当成"自己拉起的"

    const lines = readFileSync(devToolsActivePortFile(home), 'utf8').split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe(String(cdp.port));
    expect(lines[1]).toBe('/devtools/browser/FAKE-UUID');
  });

  it('探不到实例、程序又不在时，把原因说清楚（不抛错）', async () => {
    const free = await freePort();
    const own = new OwnBrowser({
      exePath: join(scratchDir, '没有这个.exe'),
      home: join(scratchDir, 'home'),
      cdpPort: free,
    });
    const problem = await own.ensure(new FakeHost().log, 1500);
    expect(problem).toContain('不存在');
  });

  it('proxy 连的不是她那个实例：当场说清，不静默去动别人的浏览器', async () => {
    const proxy = await fakeProxy();
    const cdp = await fakeBrowserCdp();
    proxy.chromePort = 9222; // 假 proxy 说它连的是别处
    const world = startedWorld(proxy.port, ownPatch(cdp.port));
    const host = new FakeHost();
    await world.start(host);

    expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
    expect(host.events[0].text).toContain('不是她自己的那个');
  });

  it('那个连错浏览器的旧 proxy 一直活着时，后续工具调用也不接管它', async () => {
    const proxy = await fakeProxy();
    const cdp = await fakeBrowserCdp();
    proxy.chromePort = 9222;
    const world = startedWorld(proxy.port, ownPatch(cdp.port));
    await world.start(new FakeHost());

    // 它是活的，`/targets` 答得出来——只探活不看连的是谁，就会把页面开到他浏览器里去。
    const before = proxy.hits.length;
    const out = await call(world, 'browser_open', { url: 'example.com/a' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('不是她自己的那个');
    expect(proxy.hits.slice(before)).not.toContain('/new');
  });

  it('专属实例里 browser_tabs 说"你自己的浏览器"，也不报变化段', async () => {
    const proxy = await fakeProxy();
    const cdp = await fakeBrowserCdp();
    proxy.chromePort = cdp.port;
    proxy.pages.push({ targetId: 'T9', url: 'https://example.com/', title: '甲' });
    const world = startedWorld(proxy.port, ownPatch(cdp.port));
    await world.start(new FakeHost());

    const out = await call(world, 'browser_tabs');
    expect(out.text).toContain('你自己的浏览器');
    expect(out.text).not.toContain('[变化]');
  });

  it('没配专属实例时 browser_focus 拒绝，并说清为什么', async () => {
    const proxy = await fakeProxy();
    const world = startedWorld(proxy.port, { skillDir: scratchDir });
    await world.start(new FakeHost());

    const out = await call(world, 'browser_focus', { target: 'T1' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没配专属实例');
  });

  it('开页之后会去调前台；调不成时在回执里说明，而不是当作失败', async () => {
    const proxy = await fakeProxy();
    const cdp = await fakeBrowserCdp(); // 它的 ws 地址不是真的 WebSocket 服务
    proxy.chromePort = cdp.port;
    proxy.evalReply = () => PAGE_DUMP;
    const world = startedWorld(proxy.port, ownPatch(cdp.port));
    await world.start(new FakeHost());

    const out = await call(world, 'browser_open', { url: 'example.com/a' });
    expect(out.failed).toBeFalsy();
    expect(out.text).toContain('已打开');
    expect(out.text).toContain('没能把这个页面带到前台');
  });
});
