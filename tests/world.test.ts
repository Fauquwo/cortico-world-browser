import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { BrowserConfigSection } from '../src/config.ts';
import { BROWSER } from '../src/definition.ts';
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
      if (path === '/navigate' || path === '/back') {
        json({ frameId: 'frame-1' });
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
  ctx.persist({ browser: 'chrome', port, pollIntervalMs: 1000, ...patch });
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

/** 一个最小的、真的是这个协议的 proxy：给自己拉起那条路当靶子。 */
function writeProxyScript(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
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

  it('工具表：十二个工具，都带 browser_ 前缀和非空标签', () => {
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
      'browser_close',
      'browser_find_url',
    ]);
    for (const tool of tools) {
      expect(tool.name.startsWith('browser_')).toBe(true);
      expect(tool.tags.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
    }
  });

  it('环境提示词报两个占位符值：浏览器名与动向开关', () => {
    const world = startedWorld(3456, { browser: 'edge' });
    expect(world.envPromptVars()).toEqual({ 'browser.label': 'Edge', 'browser.watching': '会' });
    const off = startedWorld(3456, { watchActivity: false });
    expect(off.envPromptVars()['browser.watching']).toBe('不会');
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

  describe('他的上网动向', () => {
    it('他新开的页面攒成一条延迟渲染项，piggyback 投递，渲染过就不再来', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      const host = new FakeHost();
      await world.start(host);

      await sleep(1400); // 第一次快照只打底
      expect(host.deferred).toHaveLength(0);

      proxy.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a', title: '甲（改过标题）' },
        { targetId: 'HIS2', url: 'https://github.com/x/pulls', title: '拉取请求' },
      ];
      await sleep(1400);

      expect(host.deferred).toHaveLength(1);
      expect(host.deferred[0].spec.type).toBe('browser.activity');
      expect(host.deferred[0].trigger).toBe('piggyback');

      const [line] = await host.renderDeferred();
      expect(line).toContain('github.com');
      expect(line).toContain('拉取请求');
      expect(line).toContain('example.com');
      expect(await host.renderDeferred()).toEqual([]); // 没有新内容就什么都不落
    });

    it('她自己开的页面不进动向', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      const host = new FakeHost();
      await world.start(host);

      await sleep(1400); // 打底
      await call(world, 'browser_open', { url: 'example.com/mine' });
      await sleep(1400);
      expect(host.deferred).toHaveLength(0);
    });

    it('wakeOnActivity 打开时改用 debounce', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir, wakeOnActivity: true });
      const host = new FakeHost();
      await world.start(host);

      await sleep(1400);
      proxy.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      await sleep(1400);
      expect(host.deferred[0]?.trigger).toBe('debounce');
    });

    it('重启后第一轮快照只打底，不把已经开着的页面当成新动向', async () => {
      const proxy = await fakeProxy();
      proxy.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      await world.start(new FakeHost());
      await sleep(1400);
      await world.stop();

      const second = new FakeHost();
      await world.start(second);
      await sleep(1400);
      expect(second.deferred).toHaveLength(0);
    });

    it('关掉 watchActivity 就不攒动向', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir, watchActivity: false });
      const host = new FakeHost();
      await world.start(host);

      await sleep(1400);
      proxy.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      await sleep(1400);
      expect(host.deferred).toHaveLength(0);
    });

    it('浏览器的内部页面不算动向', async () => {
      const proxy = await fakeProxy();
      const world = startedWorld(proxy.port, { skillDir: scratchDir });
      const host = new FakeHost();
      await world.start(host);

      await sleep(1400);
      proxy.pages = [{ targetId: 'NEWTAB', url: 'chrome://newtab/', title: '新标签页' }];
      await sleep(1400);
      expect(host.deferred).toHaveLength(0);
    });
  });
});
