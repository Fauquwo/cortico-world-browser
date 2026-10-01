/**
 * 开发用冒烟：不经过 Cortico，直接对着本机真的 cdp-proxy 走一遍。
 *
 * 两种用法：
 *
 *   1) 借操作员日常那个浏览器（原样，没变）：
 *      pnpm smoke [--skill-dir F:\ai\web-access] [--browser chrome] [--port 3517] [--url https://example.com]
 *
 *   2) 她自己的实例（2026-10-01 加的那条路）：
 *      pnpm smoke --own [--exe <chrome.exe>] [--home <她的"家">] [--cdp-port 9223] [--port 3517]
 *
 * 第 2 种会：先把她的实例拉起来（探活→复用→才 spawn）→ 把"家"当 LOCALAPPDATA 拉起 proxy →
 * 核对 proxy 连的确实是那个端口 → **在本地跑一次"能不能播"的验证**（起一个本机小服务，
 * 页面里不靠用户手势调 play()，看 currentTime 有没有走起来），最后截图、关页、只关自己拉起的进程。
 *
 * 浏览器没打开远程调试开关（第 1 种）或实例起不来（第 2 种）时，它会说清卡在哪并以退出码 1 结束——
 * 那是预期结果，不是脚本坏了。
 */
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpRelay } from '../src/cdp-client.ts';
import { OwnBrowser, activateTarget } from '../src/own-browser.ts';
import { readExpression } from '../src/page-scripts.ts';

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const skillDir = arg('skill-dir', 'F:\\ai\\web-access');
const browser = arg('browser', 'chrome');
const port = Number(arg('port', '3517'));
const own = flag('own');
/** 顺手再开一个真实站点看一眼；她自己的实例那条路默认不开（先看本地那条"能不能播"）。 */
const extraUrl = arg('url', own ? '' : 'https://example.com');
const exePath = arg('exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const home = arg('home', join(tmpdir(), 'cortico-own-browser-smoke'));
const cdpPort = Number(arg('cdp-port', '9223'));

const log = {
  child: () => log,
  info: (message: string, meta?: unknown) => console.log(`[info] ${message}`, meta ?? ''),
  warn: (message: string, meta?: unknown) => console.log(`[warn] ${message}`, meta ?? ''),
  error: (message: string, meta?: unknown) => console.log(`[error] ${message}`, meta ?? ''),
  debug: (message: string) => console.log(String(message)),
  trace: () => {},
  emit: () => {},
} as unknown as Parameters<CdpRelay['spawnProxy']>[0];

// ——— 本机测试页：验"后台 tab 播不动 / 带到前台就能播"这一条 ———

/** 30 秒的 30 Hz 正弦：样本非零（不算"静音流"），但笔记本喇叭基本发不出 30 Hz。 */
function makeWav(): Buffer {
  const sr = 44100;
  const n = sr * 30;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 30 * i) / sr) * 200), 44 + i * 2);
  return buf;
}

const MEDIA_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>媒体冒烟</title></head><body><p>probe</p>
<script>
window.__probe = { state: 'start', visibility: document.visibilityState, play: null, currentTime: 0, readyState: -1, paused: null };
(async () => {
  const a = document.createElement('audio');
  a.src = '/tone.wav';
  document.body.appendChild(a);
  window.__probe.element = a;
  try { await a.play(); window.__probe.play = 'resolved'; }
  catch (e) { window.__probe.play = 'REJECTED ' + (e && e.name); }
  setInterval(() => {
    window.__probe.visibility = document.visibilityState;
    window.__probe.currentTime = a.currentTime;
    window.__probe.readyState = a.readyState;
    window.__probe.paused = a.paused;
  }, 250);
})();
</script></body></html>`;

const MEDIA_READ = `JSON.stringify({
  visibility: window.__probe.visibility,
  play: window.__probe.play,
  currentTime: Math.round(window.__probe.currentTime * 100) / 100,
  readyState: window.__probe.readyState,
  paused: window.__probe.paused
})`;

async function withMediaServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const wav = makeWav();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/t.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(MEDIA_PAGE);
      return;
    }
    if (path === '/tone.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      res.end(wav);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port: p } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${p}/t.html`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ——— 走一遍 ———

console.log(`skillDir = ${skillDir}`);
let ownBrowser: OwnBrowser | null = null;

if (own) {
  ownBrowser = new OwnBrowser({ exePath, home, cdpPort });
  console.log(`她的实例 = ${exePath}`);
  console.log(`  家       = ${home}`);
  console.log(`  调试口   = 127.0.0.1:${cdpPort}`);
  const problem = await ownBrowser.ensure(log, 30000);
  if (problem) {
    console.error(`实例起不来：${problem}`);
    process.exit(1);
  }
  console.log(`实例就绪（${ownBrowser.owned ? '这次拉起的' : '复用已在跑的'}）`);
}

const relay = new CdpRelay({
  skillDir,
  browser,
  port,
  tabIdleMinutes: 15,
  ...(own ? { localAppDataRoot: home } : {}),
});

console.log(`proxy    = ${relay.endpoint()}（浏览器 ${browser}）`);

const before = await relay.probe();
if (before) {
  console.log(`已有 proxy 在跑：connected=${before.connected} browser=${before.browserLabel || before.browserId || '未识别'}`);
} else {
  console.log('端口上没有 proxy，自己拉起。');
  const portProblem = await relay.checkPort();
  if (portProblem) {
    console.error(portProblem);
    console.error('换一个端口再跑：pnpm smoke --port 3600');
    process.exit(1);
  }
  if (!relay.spawnProxy(log)) {
    console.error(`拉起失败：${relay.failure}`);
    process.exit(1);
  }
}

let ok = false;
for (let i = 0; i < 30; i += 1) {
  if (await relay.reachable()) {
    ok = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const health = await relay.probe();
console.log(
  `/health：connected=${health?.connected ?? '?'} browser=${health?.browserLabel || health?.browserId || '未识别'}` +
    ` chromePort=${health?.chromePort ?? '?'}`,
);

if (!ok) {
  console.error('浏览器没接上：去对应浏览器的 inspect 页面勾选允许远程调试，再跑一次。');
  console.error(`提示：${browser}://inspect/#remote-debugging`);
  await relay.stop();
  ownBrowser?.stop();
  process.exit(1);
}

if (own && health?.chromePort && health.chromePort !== cdpPort) {
  console.error(`proxy 连的是 ${health.chromePort}，不是她的实例（${cdpPort}）：先停掉那个 proxy 再跑。`);
  await relay.stop();
  ownBrowser?.stop();
  process.exit(1);
}

console.log('浏览器已接上，开始走一遍：');

/** 与 World 同一条路：先建空白 tab（拿住 id），再导航，再带到前台。 */
async function openAndRead(url: string, maxChars = 1200): Promise<string> {
  const target = await relay.openBlank(30000);
  console.log(`  开了新页：target=${target}`);
  await relay.navigate(target, url, 35000);
  console.log(`  导航到 ${url}`);
  if (own) {
    const { visibility } = await activateTarget(cdpPort, target, 5000);
    console.log(`  带到前台：visibilityState=${visibility}`);
  }
  const dump = await relay.evaluate(target, readExpression(null, maxChars), 30000);
  if (dump.ok) {
    const page = dump.value as { title?: string; url?: string; text?: string; links?: unknown[] };
    console.log(`  标题：${page.title ?? ''}`);
    console.log(`  地址：${page.url ?? ''}`);
    console.log(`  正文（前 300 字）：${(page.text ?? '').slice(0, 300)}`);
    console.log(`  链接：${Array.isArray(page.links) ? page.links.length : 0} 条`);
  } else {
    console.log(`  读页失败：${dump.error}`);
  }
  return target;
}

if (own) {
  const verdict = await withMediaServer(async (mediaUrl) => {
    const target = await openAndRead(mediaUrl);
    // 页面自己每 250 毫秒更新一次状态；等两秒让它把 currentTime 走起来。
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const read = await relay.evaluate(target, MEDIA_READ, 15000);
    const state = read.ok ? (read.value as string) : `读不到：${read.error}`;
    console.log(`  媒体状态：${state}`);

    const shot = await relay.screenshot(target, 30000);
    const shotPath = join(tmpdir(), 'cortico-browser-smoke.png');
    writeFileSync(shotPath, shot);
    console.log(`  截图：${shot.length} 字节，写到 ${shotPath}`);

    await relay.close(target, 30000);
    console.log(`  关掉了 ${target}`);

    const parsed = read.ok ? (JSON.parse(read.value as string) as { currentTime: number; visibility: string; paused: boolean }) : null;
    return parsed !== null && parsed.currentTime > 0 && parsed.paused === false
      ? { pass: true, detail: `${parsed.visibility}、currentTime=${parsed.currentTime}、paused=${parsed.paused}` }
      : { pass: false, detail: state };
  });

  if (verdict.pass) console.log(`媒体能不能播：过（${verdict.detail}）`);
  else {
    console.error(`媒体能不能播：没过（${verdict.detail}）`);
    await relay.stop();
    ownBrowser?.stop();
    process.exit(1);
  }
}

if (extraUrl !== '') await openAndRead(extraUrl);

// 谁是自己拉起的、谁是复用来的，要在 stop() 之前读：stop() 会把记录清掉。
const relayWasOurs = relay.owned;
const browserWasOurs = ownBrowser?.owned ?? false;
await relay.stop();
ownBrowser?.stop();
console.log(relayWasOurs ? '（proxy 是这次拉起的，已关）' : '（proxy 是复用的，没关它）');
if (ownBrowser) console.log(browserWasOurs ? '（她的浏览器是这次拉起的，已关）' : '（她的浏览器是复用的，没关它）');
