import { VIDEO_TOOL_DECLS } from '../src/video/tools.ts';
import { BilibiliSession } from '../src/video/session.ts';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { EngineError, classifyEngineError } from '../src/cdp-engine.ts';
import type { BrowserConfigSection } from '../src/config.ts';
import { BROWSER } from '../src/definition.ts';
import { OwnBrowser, chromeProfileDir, ownBrowserArgs, pickProfileHolders } from '../src/own-browser.ts';
import { findUrl } from '../src/find-url.ts';
import type { BrowserWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { fakeBrowser, listenForHttp, type FakeBrowser } from './helpers/fake-browser.ts';

let scratchDir: string;
let worlds: BrowserWorld[] = [];
let fakes: FakeBrowser[] = [];

/** 造一个假浏览器并登记进 afterEach 的清理名单。 */
async function makeFake(): Promise<FakeBrowser> {
  const fake = await fakeBrowser();
  fakes.push(fake);
  return fake;
}

/** 空出来的端口：让「起不来」那条路有个确定没人在听的地方。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await listenForHttp(server);
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const nodeRequire = createRequire(import.meta.url);

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'browser-world-'));
  worlds = [];
  fakes = [];
});

afterEach(async () => {
  for (const world of worlds) await world.stop().catch(() => {});
  for (const fake of fakes) await fake.close().catch(() => {});
  vi.unstubAllEnvs();
  rmSync(scratchDir, { recursive: true, force: true });
});

// ——— 假的浏览器调试口：真的会说 CDP 的服务（helpers/fake-browser.ts），行为可按用例改 ———

/**
 * 借操作员浏览器模式：把「他的 Chrome」指到 scratch 里的假浏览器——
 * 发现文件写在 `LOCALAPPDATA` 指向的目录下（发现逻辑读的就是那里），端口指向假浏览器。
 */
async function borrowedWorld(
  fake: FakeBrowser | null,
  patch: Partial<BrowserConfigSection> = {},
  { withDiscoveryFile = fake !== null } = {},
): Promise<BrowserWorld> {
  vi.stubEnv('LOCALAPPDATA', scratchDir);
  if (withDiscoveryFile && fake) {
    const userDir = join(scratchDir, 'Google', 'Chrome', 'User Data');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/FAKE-UUID\n`);
  }
  const ctx = fakeWorldContext(BROWSER, { scratchDir });
  ctx.persist({ browser: 'chrome', ...patch });
  const world = BROWSER.create(ctx) as BrowserWorld;
  worlds.push(world);
  return world;
}

/** 专属实例模式：引擎直连假浏览器的端口，不经过发现。 */
function ownWorld(fake: FakeBrowser, patch: Partial<BrowserConfigSection> = {}): BrowserWorld {
  const ctx = fakeWorldContext(BROWSER, { scratchDir });
  ctx.persist({
    browser: 'chrome',
    ownBrowser: true,
    ownBrowserExe: writeFakeExe(scratchDir),
    ownBrowserHome: join(scratchDir, 'home'),
    ownBrowserPort: fake.port,
    ...patch,
  });
  const world = BROWSER.create(ctx) as BrowserWorld;
  worlds.push(world);
  return world;
}

/** 不起引擎的裸 World：工具表、提示词变量、preflight、拒绝路径用。 */
function bareWorld(patch: Partial<BrowserConfigSection> = {}): BrowserWorld {
  const ctx = fakeWorldContext(BROWSER, { scratchDir });
  ctx.persist({ browser: 'chrome', ...patch });
  const world = BROWSER.create(ctx) as BrowserWorld;
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

/**
 * 一个"存在就行"的可执行文件：preflight 只检查它存不存在，不会真去跑它。
 * （真拉起浏览器那一段由实机冒烟覆盖，见设计记录。）
 */
function writeFakeExe(dir: string): string {
  const file = join(dir, 'chrome.exe');
  writeFileSync(file, 'not a real browser');
  return file;
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

  it('通用与视频工具都带 browser_ 前缀和非空标签', () => {
    const tools = bareWorld().tools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_open',
      'browser_search',
      'browser_fetch',
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
      ...VIDEO_TOOL_DECLS.map(tool => tool.name),
    ]);
    for (const tool of tools) {
      expect(tool.name.startsWith('browser_')).toBe(true);
      expect(tool.tags.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
    }
  });

  it('环境提示词报占位符值：借他日常那个浏览器时，是"后台 tab"那一种', () => {
    const vars = bareWorld({ browser: 'edge' }).envPromptVars();
    expect(vars['browser.label']).toBe('Edge');
    expect(vars['browser.kind']).toContain('操作员日常');
    expect(vars['browser.front']).toContain('后台 tab');
  });

  it('环境提示词：她自己的实例说成"窗口停在屏幕外、媒体照样能播"', () => {
    const vars = bareWorld({ ownBrowser: true, ownBrowserPort: 9223 }).envPromptVars();
    expect(vars['browser.kind']).toContain('专属实例');
    expect(vars['browser.front']).toContain('屏幕外');
    expect(vars['browser.front']).toContain('媒体');
  });

  it('没连过浏览器时 stop() 是空操作', async () => {
    await expect(bareWorld().stop()).resolves.toBeUndefined();
  });

  describe('激活前检查', () => {
    it('browser 没配或写了别的名字时都拦下', () => {
      const bare = fakeWorldContext(BROWSER, { scratchDir });
      expect(() => BROWSER.preflight!(bare)).toThrow(/browser 没配/);

      const wrong = fakeWorldContext(BROWSER, { scratchDir });
      wrong.persist({ browser: 'firefox' });
      expect(() => BROWSER.preflight!(wrong)).toThrow(/chrome \/ edge \/ chromium/);
    });

    it('配齐了就通过（包里不再需要任何外部目录）', () => {
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({ browser: 'chrome' });
      expect(() => BROWSER.preflight!(ctx)).not.toThrow();
    });

    it('开了专属实例但没填程序/目录时，逐条点名', () => {
      const noExe = fakeWorldContext(BROWSER, { scratchDir });
      noExe.persist({ browser: 'chrome', ownBrowser: true });
      expect(() => BROWSER.preflight!(noExe)).toThrow(/ownBrowserExe 没配/);

      const missingExe = fakeWorldContext(BROWSER, { scratchDir });
      missingExe.persist({
        browser: 'chrome',
        ownBrowser: true,
        ownBrowserExe: join(scratchDir, '没有这个.exe'),
      });
      expect(() => BROWSER.preflight!(missingExe)).toThrow(/不存在/);

      const noHome = fakeWorldContext(BROWSER, { scratchDir });
      noHome.persist({
        browser: 'chrome',
        ownBrowser: true,
        ownBrowserExe: writeFakeExe(scratchDir),
      });
      expect(() => BROWSER.preflight!(noHome)).toThrow(/ownBrowserHome 没配/);
    });

    it('专属实例只认 chrome：指了别的浏览器就拦下', () => {
      const ctx = fakeWorldContext(BROWSER, { scratchDir });
      ctx.persist({
        browser: 'edge',
        ownBrowser: true,
        ownBrowserExe: writeFakeExe(scratchDir),
        ownBrowserHome: join(scratchDir, 'home'),
      });
      expect(() => BROWSER.preflight!(ctx)).toThrow(/只拉了 Chrome/);
    });
  });

  describe('起停', () => {
    it('连上浏览器后投一条 internal 的就绪事件', async () => {
      const fake = await makeFake();
      const world = await borrowedWorld(fake);
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.ready']);
      expect(host.events[0].origin).toBe('internal');
      expect(host.events[0].source).toBe('browser');
      expect(host.events[0].text).toContain('调试口');
    });

    it('专属实例由本 World 起停：stop() 只断自己的连接，不杀她的实例', async () => {
      const fake = await makeFake();
      const world = ownWorld(fake);
      const host = new FakeHost();
      await world.start(host);
      expect(host.events.map((event) => event.type)).toEqual(['browser.ready']);

      await world.stop();
      const res = await fetch(`http://127.0.0.1:${fake.port}/json/version`);
      expect(res.ok).toBe(true); // 她的浏览器还活着
    });

    it('调试口活着但 WebSocket 连不上：投 browser.down，不抛错', async () => {
      const fake = await makeFake();
      fake.controls.wsDead = true;
      const world = await borrowedWorld(fake, { readyTimeoutMs: 3000 });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
      expect(host.events[0].origin).toBe('internal');
      expect(host.events[0].text).toContain('inspect');
    });

    it('HTTP 发现端点不应答时，改用发现文件里的 ws 路径直连（新式开关只留 WebSocket 的形状）', async () => {
      const fake = await makeFake();
      fake.controls.versionEndpointDead = true;
      const world = await borrowedWorld(fake);
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.ready']);
      expect(host.events[0].text).toContain('调试口');
    });

    it('远程调试开关没开（没有发现文件）：当场说清去开哪个开关', async () => {
      const world = await borrowedWorld(null, {}, { withDiscoveryFile: false });
      const host = new FakeHost();
      await world.start(host);

      expect(host.events.map((event) => event.type)).toEqual(['browser.down']);
      expect(host.events[0].text).toContain('远程调试');
      expect(host.events[0].text).toContain('inspect');
    });
  });

  describe('工具', () => {
    it('browser_open：回 target、标题、正文与链接，表达式里带上了读页那段', async () => {
      const fake = await makeFake();
      fake.controls.evalReply = () => PAGE_DUMP;
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/a' });
      expect(out.failed).toBeUndefined();
      expect(out.text).toContain('target T1');
      expect(out.text).toContain('甲页面');
      expect(out.text).toContain('这是一段正文。');
      expect(out.text).toContain('https://example.com/more');
      expect(fake.controls.evalBodies.at(-1)).toContain('shadowRoot');
      expect(fake.controls.pages[0].url).toBe('https://example.com/a');
      // attach 之后防探测的口子是装上的：页面摸调试口会被拒（0.4.0 起这一条由引擎自己管）。
      expect(fake.controls.guards).toBeGreaterThan(0);
    });

    it('browser_open 分两步：先建空白 tab 认出 id，再单独导航', async () => {
      const fake = await makeFake();
      fake.controls.evalReply = () => PAGE_DUMP;
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/a' });
      expect(out.failed).toBeUndefined();
      // 建页那一步只发 about:blank，地址走导航：两步才认得住 id，孤儿就是这么来的。
      expect(fake.controls.createBodies).toEqual(['about:blank']);
      expect(fake.controls.navBodies).toEqual(['https://example.com/a']);
      // 认下来了：她关得掉（失败那一路也认，见下一条）。
      const closed = await call(world, 'browser_close', { target: 'T1' });
      expect(closed.failed).toBeUndefined();
      expect(closed.text).toContain('已关闭');
    });

    it('站点打不开（CDP 命令超时）：说清哪一类、不贴开关那句，tab 留着且关得掉', async () => {
      const fake = await makeFake();
      fake.controls.navError = 'CDP 命令超时: Page.navigate';
      const world = await borrowedWorld(fake);
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
      const fake = await makeFake();
      fake.controls.evalReply = () => PAGE_DUMP;
      fake.controls.navDelayMs = 3500; // 普通调用超时是 3000 的下限，导航那一段是 35 秒
      const world = await borrowedWorld(fake, { requestTimeoutMs: 3000 });
      await world.start(new FakeHost());

      const out = await call(world, 'browser_open', { url: 'example.com/slow' });
      expect(out.failed).toBeUndefined();
      expect(out.text).toContain('target T1');
    }, 15000);

    it('browser_read：选择器与字数上限透传进去，正文空时提示去截图', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      fake.controls.evalReply = () => ({ ...PAGE_DUMP, value: { ...PAGE_DUMP.value, text: '', links: [] } });
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_read', { target: 'X1', selector: 'main article', maxChars: 2000 });
      expect(out.text).toContain('正文是空的');
      expect(fake.controls.evalBodies.at(-1)).toContain('main article');
      expect(fake.controls.evalBodies.at(-1)).toContain('2000');
    });

    it('browser_read：选择器不存在时回失败，并点名那个选择器', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      fake.controls.evalReply = () => ({ ok: true, value: { ...PAGE_DUMP.value, error: '这个选择器在页面上找不到: #没有' } });
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_read', { target: 'X1', selector: '#没有' });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('#没有');
    });

    it('browser_js：值渲染出来；页面抛错时回失败', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      fake.controls.evalReply = () => ({ ok: true, value: 42 });
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const ok = await call(world, 'browser_js', { target: 'X1', expression: '21 * 2' });
      expect(ok.text).toContain('42');
      expect(fake.controls.evalBodies.at(-1)).toContain('21 * 2');
      expect(fake.controls.evalBodies.at(-1)).toContain('try {');

      fake.controls.evalReply = () => ({ ok: false, error: 'TypeError: 某某 is not a function' });
      const bad = await call(world, 'browser_js', { target: 'X1', expression: '某某()' });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('TypeError');
    });

    it('browser_js：语法错误时告诉模型这里只收表达式', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      fake.controls.evalExceptionText = 'Uncaught';
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_js', { target: 'X1', expression: 'const a = 1; a' });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('只收表达式');
    });

    it('browser_click：默认 JS 点击，native 走真实鼠标那条路', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const plain = await call(world, 'browser_click', { target: 'X1', selector: 'button.submit' });
      expect(plain.text).toContain('已点击');
      expect(fake.controls.clicks).toContain('js');

      const native = await call(world, 'browser_click', { target: 'X1', selector: 'button.upload', native: true });
      expect(native.text).toContain('真实鼠标');
      expect(fake.controls.dispatches).toBe(2); // mousePressed + mouseReleased
    });

    it('browser_type：填进去之后回执带当前值与提交方式；选项不存在时回失败', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      fake.controls.evalReply = () => ({ ok: true, value: { ok: true, applied: 'value', value: '北京时间', submitted: 'form' } });
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_type', { target: 'X1', selector: 'input', value: '北京时间', submit: true });
      expect(out.text).toContain('北京时间');
      expect(out.text).toContain('已提交');
      expect(fake.controls.evalBodies.at(-1)).toContain('requestSubmit');

      fake.controls.evalReply = () => ({ ok: true, value: { ok: false, error: '这个 select 里没有这个选项: 乙' } });
      const bad = await call(world, 'browser_type', { target: 'X1', selector: 'select', value: '乙' });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('没有这个选项');
    });

    it('browser_upload：报挂上了几个文件', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_upload', {
        target: 'X1',
        selector: 'input[type=file]',
        files: ['C:\\work\\a.png', 'C:\\work\\b.png'],
      });
      expect(out.text).toContain('2 个文件');
      expect(fake.controls.uploads.at(-1)?.count).toBe(2);
    });

    it('browser_scroll：把方向透传过去', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_scroll', { target: 'X1', to: 'bottom' });
      expect(out.text).toContain('bottom');
    });

    it('browser_shot：回执挂上 PNG 附件', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_shot', { target: 'X1' });
      const blob = out.blobs?.[0] as { mime: string; bytes: Uint8Array } | undefined;
      expect(out.blobs).toHaveLength(1);
      expect(blob?.mime).toBe('image/png');
      expect(Array.from(blob?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(out.text).toContain('视口');
    });

    it('browser_navigate：url 补协议，back 走后一条路', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'X1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const moved = await call(world, 'browser_navigate', { target: 'X1', url: 'example.com/b' });
      expect(moved.text).toContain('已导航');
      expect(fake.controls.navBodies).toContain('https://example.com/b');

      const back = await call(world, 'browser_navigate', { target: 'X1', back: true });
      expect(back.text).toContain('已后退');
      expect(fake.controls.backs).toBe(1);
    });

    it('browser_tabs：标注哪些是她自己开的', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'HIS', url: 'https://example.com/his', title: '他开的' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('他开的');
      expect(out.text).toContain('（我开的）');
      expect(out.text).toContain('target: HIS');
    });

    it('browser_close：只关自己开的，别人的拒绝并说明', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'HIS', url: 'https://example.com/his', title: '他开的' }];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const refused = await call(world, 'browser_close', { target: 'HIS' });
      expect(refused.failed).toBe(true);
      expect(refused.text).toContain('不是我开的');
      expect(fake.controls.closed).toEqual([]);

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const mineTarget = fake.controls.pages.at(-1)!.targetId;
      const closed = await call(world, 'browser_close', { target: mineTarget });
      expect(closed.text).toContain('已关闭');
      expect(fake.controls.closed).toEqual([mineTarget]);
    });

    it('browser_find_url：包内检索本机的书签与历史', async () => {
      const fake = await makeFake();
      const world = await borrowedWorld(fake);
      writeFindUrlFixture(scratchDir);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_find_url', { keywords: ['内部系统'], only: 'history' });
      expect(out.text).toContain('[历史] 1 条');
      expect(out.text).toContain('intra.example.com');
    });

    it('浏览器不可用时工具回失败，并指出要去开哪个开关', async () => {
      const world = await borrowedWorld(null, {}, { withDiscoveryFile: false });
      const out = await call(world, 'browser_tabs');
      expect(out.failed).toBe(true);
      expect(out.text).toContain('浏览器不可用');
      expect(out.text).toContain('inspect');
    });
  });

  describe('他此刻在干什么（拉取式：她问才看）', () => {
    it('第一回看只列页面，没有变化段', async () => {
      const fake = await makeFake();
      fake.controls.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a', title: '甲' },
        { targetId: 'HIS2', url: 'https://github.com/x', title: '拉取请求' },
      ];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());

      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('浏览器里现在有 2 个页面');
      expect(out.text).toContain('拉取请求');
      expect(out.text).not.toContain('[变化]');
    });

    it('他开了、转了、关掉之后，第二回看带出净变化', async () => {
      const fake = await makeFake();
      fake.controls.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a', title: '甲' },
        { targetId: 'HIS2', url: 'https://example.com/b', title: '乙' },
      ];
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());
      const baseline = await call(world, 'browser_tabs');
      expect(baseline.failed, `baseline=${baseline.text}`).toBeFalsy(); // 基线这回必须成：变化段的口径靠它打底
      expect(baseline.text).toContain('- 乙');

      // 他：把甲那页转到别的地址，把乙关掉，又新开一页。
      fake.controls.pages = [
        { targetId: 'HIS1', url: 'https://example.com/a2', title: '甲改' },
        { targetId: 'HIS3', url: 'https://bilibili.com/v/x', title: '视频' },
      ];
      const out = await call(world, 'browser_tabs');
      // 措辞不钉死：两次查看挨得太近（同一毫秒）时是「自你上次看」，隔开了才是「距你上次看约…」。
      expect(out.text).toMatch(/\[变化\] (距你上次看约|自你上次看)/);
      expect(out.text).toContain('转到 example.com「甲改」');
      expect(out.text).toContain('转到 example.com「甲改」');
      expect(out.text).toContain('打开 bilibili.com「视频」');
      expect(out.text).toContain('关掉 example.com「乙」');
    });

    it('中间那一段没在采样：变化是两次查看之间的净变化', async () => {
      const fake = await makeFake();
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      // 他开了一个又关掉，全程夹在两次查看之间。
      fake.controls.pages = [{ targetId: 'TMP', url: 'https://example.com/tmp', title: '一闪而过' }];
      await call(world, 'browser_tabs'); // 这一回会报「打开」
      fake.controls.pages = [];
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('关掉 example.com「一闪而过」');
    });

    it('她自己开的页面不算他的变化', async () => {
      const fake = await makeFake();
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      await call(world, 'browser_open', { url: 'example.com/mine' });
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('（我开的）');
      expect(out.text).not.toContain('[变化]');
    });

    it('浏览器的内部页面只在列表里，不进变化段', async () => {
      const fake = await makeFake();
      const world = await borrowedWorld(fake);
      await world.start(new FakeHost());
      await call(world, 'browser_tabs');

      fake.controls.pages = [{ targetId: 'NEWTAB', url: 'chrome://newtab/', title: '新标签页' }];
      const out = await call(world, 'browser_tabs');
      expect(out.text).toContain('新标签页');
      expect(out.text).not.toContain('[变化]');
    });

    it('重启后的第一回看只打底，不把已经开着的页面当成他的变化', async () => {
      const fake = await makeFake();
      fake.controls.pages = [{ targetId: 'HIS1', url: 'https://example.com/a', title: '甲' }];
      const world = await borrowedWorld(fake);
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
  it('认得出四类：命令没回话、连不上浏览器、浏览器没连上、页面已经不在了', () => {
    expect(classifyEngineError(new EngineError('CDP 命令超时: Page.navigate', 500))).toBe('command-timeout');
    expect(classifyEngineError(new EngineError('连不上浏览器：The operation was aborted due to timeout', 0))).toBe('unreachable');
    expect(classifyEngineError(new EngineError('WebSocket 未连接（浏览器没连上或刚断开）', 500))).toBe('not-connected');
    expect(classifyEngineError(new EngineError('attach 失败: {"code":-32001}', 500))).toBe('not-connected');
    // 目标没了是日常操作（页面被关掉/回收了），不算连接问题，不贴「去开开关」。
    expect(classifyEngineError(new EngineError('页面不存在或已关闭（target T9）。用 browser_tabs 看一眼现在还有哪些页面。', 500))).toBe('relay');
    expect(classifyEngineError(new EngineError('未找到元素: #x', 400))).toBe('relay');
  });
});

/**
 * 她自己的浏览器实例（2026-10-01 加）。
 *
 * 这一组钉的是**决策与起停那半**：启动参数齐不齐、实例已在跑时复用、直连的是她那个端口、
 * 以及"开页之后确实去调了前台"。
 *
 * 真拉起一个浏览器、以及裸 WebSocket 上的 `Target.activateTarget` 本身，单测不覆盖——
 * 那两段由 `pnpm smoke` 对着真的 Chrome 跑（见设计记录「验证」一节）。
 */
describe('她自己的浏览器实例', () => {
  it('启动参数：屏幕外 + 让"页面能活"的那几条都在（谁删掉谁负责）', () => {
    const args = ownBrowserArgs({ exePath: 'chrome.exe', home: 'H', cdpPort: 9223 });
    expect(args).toContain(`--user-data-dir=${chromeProfileDir('H')}`);
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--remote-allow-origins=*');
    // 她的窗口起在屏幕外：这是"默认不打扰他"的那一条。
    expect(args).toContain('--window-position=-32000,-32000');
    expect(args).toContain('--autoplay-policy=no-user-gesture-required');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args.some((arg) => arg.includes('CalculateNativeWinOcclusion'))).toBe(true);
    expect(args).toContain('--no-first-run');
  });

  it('profile 的位置：照 Chrome 自己的布局放在她的"家"里', () => {
    expect(chromeProfileDir('H')).toBe(join('H', 'Google', 'Chrome', 'User Data'));
  });

  it('认得出占着她 profile 的旧 Chrome 主进程；子进程与他家 profile 都不算', () => {
    const profile = 'F:\\her\\Google\\Chrome\\User Data';
    const rows = [
      // 主进程：没有 --type=，命令行里带着她的 profile。
      { pid: 11, commandLine: `"C:\\chrome.exe" --user-data-dir=${profile} --remote-debugging-port=9223` },
      // 渲染器/GPU 这类子进程也带 profile，但它们不是拦住新实例的那一个。
      { pid: 12, commandLine: `"C:\\chrome.exe" --type=renderer --user-data-dir="F:\\her\\Google\\Chrome\\User"` },
      // 操作员日常那个 profile：不能碰。
      { pid: 13, commandLine: `"C:\\chrome.exe" --user-data-dir=F:\\his\\Google\\Chrome\\User Data --remote-debugging-port=9222` },
      // 配置里写正斜杠、大小写不一样，也要认出来。
      { pid: 14, commandLine: `"C:\\chrome.exe" --user-data-dir=f:/HER/Google/Chrome/User Data` },
    ];
    expect(pickProfileHolders(rows, profile).map((row) => row.pid)).toEqual([11, 14]);
  });

  it('实例已经在跑时：复用它（不 spawn）', async () => {
    const fake = await makeFake();
    const own = new OwnBrowser({ exePath: writeFakeExe(scratchDir), home: join(scratchDir, 'home'), cdpPort: fake.port });

    expect(await own.ensure(new FakeHost().log, 3000)).toBeNull();
    expect(own.owned).toBe(false); // 复用来的，不该被当成"自己拉起的"
  });

  it('探不到实例、程序又不在时，把原因说清楚（不抛错）', async () => {
    const idle = await freePort();
    const own = new OwnBrowser({
      exePath: join(scratchDir, '没有这个.exe'),
      home: join(scratchDir, 'home'),
      cdpPort: idle,
    });
    const problem = await own.ensure(new FakeHost().log, 1500);
    expect(problem).toContain('不存在');
  });

  it('专属模式直连她那个端口：他的浏览器一页都不被碰', async () => {
    const hers = await makeFake();
    hers.controls.evalReply = () => PAGE_DUMP;
    const his = await makeFake();
    his.controls.pages = [{ targetId: 'HIS-1', url: 'https://example.com/his', title: '他的页' }];
    const world = ownWorld(hers);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_open', { url: 'example.com/a' });
    expect(out.failed).toBeFalsy();
    expect(hers.controls.pages.some((page) => page.url === 'https://example.com/a')).toBe(true);
    expect(his.controls.pages.map((page) => page.targetId)).toEqual(['HIS-1']);
  });

  it('专属实例里 browser_tabs 说"你自己的浏览器"，也不报变化段', async () => {
    const fake = await makeFake();
    fake.controls.pages.push({ targetId: 'T9', url: 'https://example.com/', title: '甲' });
    const world = ownWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_tabs');
    expect(out.text).toContain('你自己的浏览器');
    expect(out.text).not.toContain('[变化]');
  });

  it('借他日常那个浏览器时，browser_focus 拒绝并说清为什么', async () => {
    const world = bareWorld();
    const out = await call(world, 'browser_focus', { target: 'T1' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('借的是操作员日常那个浏览器');
  });

  it('操作员关掉"允许她弹"时，browser_focus 拒绝（页面留在屏幕外）', async () => {
    const fake = await makeFake();
    const world = ownWorld(fake, { bringToFront: false });
    const out = await call(world, 'browser_focus', { target: 'T1' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('不想被打断');
  });

  it('专属实例下开页建的是"她自己的窗口"；建不成时退回后台 tab，并在回执里说明', async () => {
    const fake = await makeFake();
    fake.controls.createWindowFails = true;
    fake.controls.evalReply = () => PAGE_DUMP;
    const world = ownWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_open', { url: 'example.com/a' });
    expect(out.failed).toBeFalsy();
    expect(out.text).toContain('已打开');
    // 退回那条路要说清代价（媒体播不了），而不是静默降级。
    expect(out.text).toContain('退回了后台 tab');
    expect(fake.controls.windowCreateAttempts).toBe(1);
  });

  it('视频自动展示遵守弹窗权限，操作员手动展示可在关掉权限后使用', async () => {
    const fake = await makeFake();
    const world = ownWorld(fake, { bringToFront: false });
    const internals = world as unknown as {
      show: (target: string) => Promise<unknown>;
      video: { opts: { present: (target: string, by: 'operator' | 'bot') => Promise<string> } };
    };
    const show = vi.spyOn(internals, 'show').mockResolvedValue({ visibility: 'visible', raise: { ok: false, reason: 'fixture' } });
    await expect(internals.video.opts.present('T1', 'bot')).rejects.toThrow('不想被打断');
    expect(show).not.toHaveBeenCalled();
    expect(await internals.video.opts.present('T1', 'operator')).toContain('已把 T1 搬到操作员眼前');
    expect(show).toHaveBeenCalledWith('T1');
  });

  it('开页不再自动弹到他眼前：专属实例下 open 不碰窗口位置/激活', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = () => PAGE_DUMP;
    const world = ownWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_open', { url: 'example.com/a' });
    expect(out.failed).toBeFalsy();
    // 成功那条路一个字都不提"前台/眼前"：默认不打扰他。
    expect(out.text).not.toContain('带到前台');
    expect(out.text).not.toContain('搬到');
  });

  it('她自己开的窗口闲置太久会被收掉（回收在这里）', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = () => PAGE_DUMP;
    // 0.00005 分钟 ≈ 3 毫秒：用极小值来验"到点就收"，不必真等一分钟。
    const world = ownWorld(fake, { tabIdleMinutes: 0.00005 });
    await world.start(new FakeHost());

    const opened = await call(world, 'browser_open', { url: 'example.com/a' });
    const target = /target (T\d+)/.exec(opened.text)?.[1] ?? '';
    expect(target).not.toBe('');

    await sleep(20);
    await call(world, 'browser_tabs'); // 任何一次工具调用都会顺手扫一遍
    expect(fake.controls.closed).toContain(target);
  });

  it('观看租约保留视频页，同时回收其他闲置页；释放后视频页也可回收', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = () => PAGE_DUMP;
    const world = ownWorld(fake, { tabIdleMinutes: 0.00005 });
    await world.start(new FakeHost());
    let leaseTarget = '';
    const lease = vi.spyOn(BilibiliSession.prototype, 'protects').mockImplementation(target => target === leaseTarget);
    try {
      const video = await call(world, 'browser_open', {url:'https://www.bilibili.com/video/BV1234567890'});
      leaseTarget = /target (T\d+)/.exec(video.text)![1];
      const other = await call(world, 'browser_open', {url:'https://example.com/other'});
      const otherTarget = /target (T\d+)/.exec(other.text)![1];
      await sleep(20);
      await call(world, 'browser_tabs');
      expect(fake.controls.closed).not.toContain(leaseTarget);
      expect(fake.controls.closed).toContain(otherTarget);
      const released = leaseTarget;
      leaseTarget = '';
      await call(world, 'browser_tabs');
      await sleep(10);
      expect(fake.controls.closed).toContain(released);
    } finally { lease.mockRestore(); }
  });
});

/**
 * 「搜」这一步（2026-10-12 加的）。她的原话是「浏览器给我的是打开这个地址、读正文，没有搜这一步，
 * 主题一模糊我就只剩猜域名、翻站内导航两条路」——这组测试盯的就是：回执交出去的必须是**地址**。
 */
describe('搜索', () => {
  /** 抽取表达式长这样：`(spec) => {...})({"id":"bing","anchors":[...`。 */
  function isHarvest(expression: string): boolean {
    return expression.includes('"anchors":[');
  }

  const HITS = {
    anchors: 10,
    title: '怎么挑机械键盘 - 搜索',
    url: 'https://cn.bing.com/search?q=%E6%80%8E%E4%B9%88%E6%8C%91%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98',
    hits: [
      {
        title: '机械键盘推荐：青轴、红轴、黑轴、茶轴怎么选？ - 知乎',
        url: 'https://zhuanlan.zhihu.com/p/257307801',
        snippet: '2024年10月23日 · 机械键盘推荐，为什么要选用机械键盘？',
        source: '知乎专栏',
      },
      {
        title: '2026年机械键盘怎么选？我从200到1500全试了一遍',
        url: 'https://zhuanlan.zhihu.com/p/2045432457407854349',
        snippet: '',
        source: '知乎专栏',
      },
    ],
  };

  it('browser_search：一次调用给出候选地址，并说清下一步怎么用', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = (expression) => (isHarvest(expression) ? { ok: true, value: HITS } : PAGE_DUMP);
    const world = await borrowedWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_search', { query: '怎么挑机械键盘' });
    expect(out.failed).toBeFalsy();
    expect(out.text).toContain('Bing 国内版');
    expect(out.text).toContain('2 条');
    expect(out.text).toContain('https://zhuanlan.zhihu.com/p/257307801');
    expect(out.text).toContain('[知乎专栏]');
    expect(out.text).toContain('2024年10月23日');
    // 最要紧的一句：拿到的是地址，用 browser_open 开，别去点结果页上的链接。
    expect(out.text).toContain('browser_open');
    expect(out.text).toContain('别去点结果页上的链接');
    // 关键词进了结果页地址（URL 编码过）。
    expect(fake.controls.navBodies.at(-1)).toContain('cn.bing.com/search?q=');
    expect(fake.controls.navBodies.at(-1)).toContain(encodeURIComponent('怎么挑机械键盘'));
    // 结果页留给她：回执里有 target，browser_close 认它。
    const target = /target (T\d+)/.exec(out.text)?.[1] ?? '';
    expect(target).not.toBe('');
    const closed = await call(world, 'browser_close', { target });
    expect(closed.failed).toBeFalsy();
  });

  it('browser_search：换引擎走那个引擎的结果页，跳转链接会被标出来', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = (expression) =>
      isHarvest(expression)
        ? {
            ok: true,
            value: {
              anchors: 8,
              title: '怎么挑机械键盘 - 搜狗搜索',
              url: 'https://www.sogou.com/web?query=x',
              hits: [{ title: '机械键盘选购从小白到入门 - 知乎', url: 'https://www.sogou.com/link?url=hedJjaC291', snippet: '轴体结构很稳定', source: '' }],
            },
          }
        : PAGE_DUMP;
    const world = await borrowedWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_search', { query: '机械键盘', engine: 'sogou' });
    expect(out.text).toContain('搜狗');
    expect(fake.controls.navBodies.at(-1)).toContain('sogou.com/web?query=');
    expect(out.text).toContain('（跳转链接）');
    expect(out.text).toContain('看不出是哪个站点');
  });

  it('browser_search：一条都没抽到时退回整页正文，并说清是哪种没命中', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = (expression) =>
      isHarvest(expression) ? { ok: true, value: { anchors: 0, hits: [], title: '验证', url: 'https://cn.bing.com/verify' } } : PAGE_DUMP;
    const world = await borrowedWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_search', { query: '机械键盘' });
    expect(out.failed).toBeFalsy(); // 抽取没命中不算失败：退路是给整页正文
    expect(out.text).toContain('一条都没抽出来');
    expect(out.text).toContain('换了页面结构');
    expect(out.text).toContain('这是一段正文'); // 退回来的整页正文
  });

  it('browser_search：空查询和未知引擎失败；不指定时沿用旧默认值', async () => {
    const fake = await makeFake();
    fake.controls.evalReply = (expression) => (isHarvest(expression) ? { ok: true, value: HITS } : PAGE_DUMP);
    const world = await borrowedWorld(fake, { searchEngine: 'sogou' });
    await world.start(new FakeHost());

    const blank = await call(world, 'browser_search', {});
    expect(blank.failed).toBe(true);
    expect(blank.text).toContain('query 是空的');

    const invalid = await call(world, 'browser_search', { query: '机械键盘', engine: 'google' });
    expect(invalid.failed).toBe(true);
    expect(fake.controls.navBodies).toHaveLength(0);
    const out = await call(world, 'browser_search', { query: '机械键盘' });
    expect(fake.controls.navBodies.at(-1)).toContain('sogou.com/web?query=');
    expect(out.text).toContain('搜狗');
  });
});

describe('点击开出来的新页面（2026-10-12 加的）', () => {
  it('真鼠标点开一张新页面时写进回执；借他那个浏览器时不登记成她的（怕认下他自己开的）', async () => {
    const fake = await makeFake();
    fake.controls.pages = [{ targetId: 'X1', url: 'https://cn.bing.com/search?q=x', title: '结果页' }];
    fake.controls.clickOpens = { url: 'https://zhuanlan.zhihu.com/p/257307801', title: '机械键盘推荐' };
    const world = await borrowedWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_click', {
      target: 'X1',
      selector: '#b_results > li.b_algo h2 a',
      native: true,
    });
    expect(out.text).toContain('点击开出了一张新页面');
    expect(out.text).toContain('https://zhuanlan.zhihu.com/p/257307801');
    expect(out.text).toContain('没有登记成我开的');
    // 没登记就不该替她关：这条回执不能让她以为能关。
    const target = /target: (T\d+)/.exec(out.text)?.[1] ?? '';
    expect(target).not.toBe('');
    const refused = await call(world, 'browser_close', { target });
    expect(refused.failed).toBe(true);
    expect(refused.text).toContain('不是我开的');
  });

  it('专属实例里点开的新页面登记成她的：能关、也会被闲置回收', async () => {
    const fake = await makeFake();
    fake.controls.pages = [{ targetId: 'X1', url: 'https://cn.bing.com/search?q=x', title: '结果页' }];
    fake.controls.clickOpens = { url: 'https://zhuanlan.zhihu.com/p/257307801', title: '机械键盘推荐' };
    const world = ownWorld(fake, { tabIdleMinutes: 0.00005 });
    await world.start(new FakeHost());

    const out = await call(world, 'browser_click', { target: 'X1', selector: 'a.result', native: true });
    expect(out.text).toContain('点击开出了一张新页面');
    expect(out.text).toContain('已经记成我开的');
    const target = /target: (T\d+)/.exec(out.text)?.[1] ?? '';
    expect(target).not.toBe('');
    const closed = await call(world, 'browser_close', { target });
    expect(closed.failed).toBeFalsy();
  });

  it('没开出新页面时，回执一个字都不多写', async () => {
    const fake = await makeFake();
    fake.controls.pages = [{ targetId: 'X1', url: 'https://cn.bing.com/search?q=x', title: '结果页' }];
    const world = await borrowedWorld(fake);
    await world.start(new FakeHost());

    const out = await call(world, 'browser_click', { target: 'X1', selector: 'button.submit' });
    expect(out.text).not.toContain('新页面');
  });
});

// ——— find-url（0.4.0 起在包内）：直接对着模块测 ———

const WEBKIT_FIX = 11644473600000000n;

/** 一份真的会用 node:sqlite 造出来的 History 库 + 一个书签 JSON。 */
function writeFindUrlFixture(root: string, profileNames: Array<[string, string]> = [['Default', 'Default']]): void {
  const userDir = join(root, 'Google', 'Chrome', 'User Data');
  for (const [dir] of profileNames) {
    const profileDir = join(userDir, dir);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'Bookmarks'), JSON.stringify({
      roots: {
        bookmark_bar: {
          type: 'folder', name: '书签栏',
          children: [
            { type: 'url', name: '内部系统', url: 'https://intra.example.com/dash' },
            { type: 'folder', name: '工作', children: [
              { type: 'url', name: '周报', url: 'https://intra.example.com/weekly' },
            ] },
          ],
        },
      },
    }));
    const db = new (nodeRequire('node:sqlite').DatabaseSync as new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void }; close: () => void })(join(profileDir, 'History'));
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, title TEXT, url TEXT, visit_count INTEGER, last_visit_time INTEGER)');
    const nowUs = BigInt(Date.now()) * 1000n + WEBKIT_FIX;
    const oldUs = BigInt(Date.now() - 10 * 86_400_000) * 1000n + WEBKIT_FIX;
    const insert = db.prepare('INSERT INTO urls (title, url, visit_count, last_visit_time) VALUES (?, ?, ?, ?)');
    insert.run('内部系统首页', 'https://intra.example.com/dash', 3, nowUs);
    insert.run('很久以前看过的页', 'https://elsewhere.example.com/old', 1, oldUs);
    db.close();
  }
  writeFileSync(join(userDir, 'Local State'), JSON.stringify({
    profile: { info_cache: Object.fromEntries(profileNames.map(([dir, name]) => [dir, { name }])) },
  }));
}

describe('find-url（包内实现）', () => {
  it('书签：关键词 AND、文件夹路径都进回执', async () => {
    writeFindUrlFixture(scratchDir);
    const out = await findUrl({ keywords: ['内部系统'] }, { ownHome: scratchDir }, 5000);
    expect(out.ok).toBe(true);
    expect(out.output).toContain('[书签] 1 条');
    expect(out.output).toContain('内部系统 | https://intra.example.com/dash | 书签栏');
  });

  it('书签没有关键词时不返回（书签无时间维度）', async () => {
    writeFindUrlFixture(scratchDir);
    const out = await findUrl({ keywords: [] }, { ownHome: scratchDir }, 5000);
    expect(out.output).toContain('[书签] 0 条');
  });

  it('历史：按最近访问排，visits 多的带标注，since 把老的滤掉', async () => {
    writeFindUrlFixture(scratchDir);
    const recent = await findUrl({ keywords: [], only: 'history' }, { ownHome: scratchDir }, 5000);
    expect(recent.ok).toBe(true);
    expect(recent.output).toContain('[历史] 2 条（按最近访问）');
    expect(recent.output).toContain('visits=3');
    expect(recent.output.indexOf('内部系统首页')).toBeLessThan(recent.output.indexOf('很久以前看过的页'));

    const sinceDay = await findUrl({ keywords: [], only: 'history', since: '1d' }, { ownHome: scratchDir }, 5000);
    expect(sinceDay.output).toContain('[历史] 1 条');
    expect(sinceDay.output).toContain('内部系统首页');
    expect(sinceDay.output).not.toContain('很久以前看过的页');
  });

  it('历史：按访问次数排；跨 profile 合并时带 @ 标注', async () => {
    writeFindUrlFixture(scratchDir, [['Default', '日常'], ['Profile 1', '工作']]);
    const out = await findUrl(
      { keywords: [], only: 'history', sort: 'visits' },
      { ownHome: scratchDir },
      5000,
    );
    expect(out.output).toContain('按访问次数');
    // 只横跨了多个 profile（浏览器只有一个）：按上游口径只标 profile。
    expect(out.output).toContain('@日常');
    expect(out.output).toContain('@工作');
  });

  it('参数错与数据目录缺失都说得清', async () => {
    const badSince = await findUrl({ keywords: ['x'], since: '明天' }, { ownHome: scratchDir }, 5000);
    expect(badSince.ok).toBe(false);
    expect(badSince.output).toContain('无效 --since 值');

    const noEdge = await findUrl({ keywords: ['x'], browser: 'edge' }, { ownHome: scratchDir }, 5000);
    expect(noEdge.ok).toBe(false);
    expect(noEdge.output).toContain('未找到浏览器 edge 的用户数据目录');

    const empty = await findUrl({ keywords: ['x'] }, { ownHome: join(scratchDir, '没有这个家') }, 5000);
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain('未找到任何浏览器');
  });
});
