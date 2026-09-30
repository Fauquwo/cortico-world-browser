/**
 * 开发用冒烟：不经过 Cortico，直接对着本机真的 cdp-proxy 走一遍。
 *
 *   pnpm smoke [--skill-dir F:\ai\web-access] [--browser chrome] [--port 3456] [--url https://example.com]
 *
 * 它会探活、必要时自己拉起 proxy、等浏览器接上，然后开一个页面、读一次正文、截一张图，最后
 * 只关自己拉起的那个进程。
 *
 * 浏览器没打开远程调试开关时，它会停在「proxy 在跑，但没连上浏览器」这一步并以退出码 1 结束——
 * 那是预期结果，不是脚本坏了：去对应浏览器的 `chrome://inspect#remote-debugging` 勾选
 * 「Allow remote debugging for this browser instance」，稍等再跑一次。
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpRelay } from '../src/cdp-client.ts';
import { readExpression } from '../src/page-scripts.ts';

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  return fallback;
}

const skillDir = arg('skill-dir', 'F:\\ai\\web-access');
const browser = arg('browser', 'chrome');
const port = Number(arg('port', '3517'));
const url = arg('url', 'https://example.com');

const log = {
  child: () => log,
  info: (message: string, meta?: unknown) => console.log(`[info] ${message}`, meta ?? ''),
  warn: (message: string, meta?: unknown) => console.log(`[warn] ${message}`, meta ?? ''),
  error: (message: string, meta?: unknown) => console.log(`[error] ${message}`, meta ?? ''),
  debug: (message: string) => console.log(String(message)),
  trace: () => {},
  emit: () => {},
} as unknown as Parameters<CdpRelay['spawnProxy']>[0];

const relay = new CdpRelay({ skillDir, browser, port, tabIdleMinutes: 15 });

console.log(`skillDir = ${skillDir}`);
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
console.log(`/health：connected=${health?.connected ?? '?'} browser=${health?.browserLabel || health?.browserId || '未识别'}`);

if (!ok) {
  console.error('浏览器没接上：去对应浏览器的 inspect 页面勾选允许远程调试，再跑一次。');
  console.error(`提示：${browser}://inspect/#remote-debugging`);
  await relay.stop();
  process.exit(1);
}

console.log('浏览器已接上，开始走一遍：');
// 与 World 同一条路：先建空白 tab（拿住 id），再单独导航——站点打不开时不至于丢了页面。
const target = await relay.openBlank(30000);
console.log(`  开了新页：target=${target}`);
await relay.navigate(target, url, 35000);
console.log(`  导航到 ${url}`);

const dump = await relay.evaluate(target, readExpression(null, 1200), 30000);
if (dump.ok) {
  const page = dump.value as { title?: string; url?: string; text?: string; links?: unknown[] };
  console.log(`  标题：${page.title ?? ''}`);
  console.log(`  地址：${page.url ?? ''}`);
  console.log(`  正文（前 300 字）：${(page.text ?? '').slice(0, 300)}`);
  console.log(`  链接：${Array.isArray(page.links) ? page.links.length : 0} 条`);
} else {
  console.log(`  读页失败：${dump.error}`);
}

const shot = await relay.screenshot(target, 30000);
const shotPath = join(tmpdir(), 'cortico-browser-smoke.png');
writeFileSync(shotPath, shot);
console.log(`  截图：${shot.length} 字节，写到 ${shotPath}`);

await relay.close(target, 30000);
console.log(`  关掉了 ${target}`);
await relay.stop();
console.log(relay.owned ? '（proxy 是这次拉起的，已关）' : '（proxy 是复用的，没关它）');
