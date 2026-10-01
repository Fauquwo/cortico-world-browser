/**
 * 她自己的浏览器实例。
 *
 * 2026-10-01 起可选：不再借操作员日常那个浏览器，而是给她一个独立 profile、独立调试端口的
 * Chrome。理由当场量过：上游 `/new` 建的是**后台 tab**，而后台 tab 里**媒体根本加载不起来**
 * ——页面调了 `play()`，`readyState` 一直是 0、`currentTime` 不动（同步读 DOM 与定时器却都正常），
 * 闲置几分钟后整个 tab 还被冻结。启动参数治不了这一条（试过 `--autoplay-policy=...`）：只有把
 * tab 调到前台它才立刻 `readyState: 4` 播起来。有了专属实例，"调到前台"就只是把她自己的窗口
 * 带上来，不会抢操作员正在用的那个窗口。
 *
 * 这个文件做两件事：
 *   1. 起停那个实例（探活 → 复用 → 才 spawn），并给它写上游发现用的 `DevToolsActivePort`；
 *   2. 直接对它说一句 CDP：`Target.activateTarget`——上游 13 个端点里没有"调到前台"的口。
 *
 * 为什么 discovery 文件要我们自己写：现代 Chrome 用 `--remote-debugging-port` 启动时**不写**
 * `DevToolsActivePort`（只有 `chrome://inspect` 那个开关写），而上游正是读这个文件找浏览器。
 * 我们把它写在自己的"家"目录里（配合 World 拉起 proxy 时重定向的 `LOCALAPPDATA`），
 * 上游据此认出来的就是她这个实例——**他日常那个 Edge 一点不用动**。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 探活/取值用的短超时。 */
const PROBE_TIMEOUT_MS = 2000;
/** 起来之后轮询 `/json/version` 的间隔。 */
const READY_POLL_MS = 500;

export interface OwnBrowserOptions {
  /** 浏览器可执行文件（chrome.exe 的绝对路径）。 */
  exePath: string;
  /** 她的"家"：profile 与 discovery 文件都在这个根下。见 `chromeProfileDir`。 */
  home: string;
  /** 这个实例的 CDP 调试端口。 */
  cdpPort: number;
  /** 额外启动参数（给以后用；默认没有）。 */
  extraArgs?: readonly string[];
}

/**
 * profile 目录：**照 Chrome 自己的布局**放（`<home>/Google/Chrome/User Data`）。
 *
 * 这样上游的 `browser-discovery` 在 `LOCALAPPDATA` 被重定向到 `<home>` 之后，按
 * `path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort')` 找的就是它，
 * 不需要改上游一行。
 */
export function chromeProfileDir(home: string): string {
  return join(home, 'Google', 'Chrome', 'User Data');
}

/** 上游读的那个发现文件。 */
export function devToolsActivePortFile(home: string): string {
  return join(chromeProfileDir(home), 'DevToolsActivePort');
}

/**
 * 固定启动参数。每条都有理由，别顺手删：
 *
 * - `--remote-debugging-port`：给她一个调试口，我们与上游都从这里进去。
 * - `--remote-allow-origins=*`：我们直连它的 WebSocket 做"调前台"（Chrome 111 起会挡掉
 *   没带来源头的连接）。
 * - `CalculateNativeWinOcclusion` **关掉**：Windows 上被别的窗口盖住的窗口会被判成 hidden，
 *   于是**她在后台播着的视频会被掐掉**。关掉之后"被盖住"不再等于"看不见"。
 * - `IntensiveWakeUpThrottling` 与三个 `--disable-background*-throttling/renderer`：
 *   隐藏 tab 的定时器别再被按秒/按分钟夹（量到过：长闲置的 tab 里一个 200 毫秒定时器
 *   30 秒都没响）。
 * - `--autoplay-policy=no-user-gesture-required`：她点播放多半是 JS 点击（不是可信手势），
 *   没有这条，站点自己的 `play()` 会被拒。
 * - `--no-first-run` / `--no-default-browser-check` / `--no-service-autorun`：无人值守的实例，
 *   首次运行的向导、默认浏览器询问、开机自启都别来。
 */
export function ownBrowserArgs(opts: OwnBrowserOptions): string[] {
  const args = [
    `--user-data-dir=${chromeProfileDir(opts.home)}`,
    `--remote-debugging-port=${opts.cdpPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  ];
  for (const extra of opts.extraArgs ?? []) {
    if (extra.trim() !== '') args.push(extra.trim());
  }
  return args;
}

interface VersionInfo {
  wsUrl: string;
  wsPath: string;
}

/** 从浏览器自己的 HTTP 口读 `/json/version`。 */
async function readVersion(cdpPort: number, timeoutMs: number): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
    const wsUrl = typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : '';
    if (!wsUrl) return null;
    return { wsUrl, wsPath: new URL(wsUrl).pathname };
  } catch {
    return null;
  }
}

export class OwnBrowser {
  private child: ChildProcess | null = null;
  private lastError = '';

  constructor(private readonly opts: OwnBrowserOptions) {}

  /** 只在自己 spawn 成功后才为真；复用来的实例不动它。 */
  get owned(): boolean {
    return this.child !== null;
  }

  get failure(): string {
    return this.lastError;
  }

  /** 这个实例的 CDP 口（不是 proxy 的口）。 */
  cdpEndpoint(): string {
    return `http://127.0.0.1:${this.opts.cdpPort}`;
  }

  /** 它现在活着吗（活着就把 `/json/version` 的回执带回来）。 */
  async probe(timeoutMs = PROBE_TIMEOUT_MS): Promise<VersionInfo | null> {
    return readVersion(this.opts.cdpPort, timeoutMs);
  }

  /**
   * 保证实例可用：先探活（活着就复用，顺手把发现文件刷新成它现在的 ws 路径——每次启动那串
   * UUID 都不一样），探不到才拉起，起来后等它就绪，最后写发现文件。
   *
   * 返回 `null` 表示好了；否则是给人看的原因。不抛错：起不来要让工具去报失败，而不是这个
   * World 整个消失（与 proxy 那一套一致）。
   */
  async ensure(log: Logger, timeoutMs: number): Promise<string | null> {
    const existing = await this.probe();
    if (existing) {
      this.writeDiscovery(existing);
      log.info('复用已在运行的她的浏览器', { endpoint: this.cdpEndpoint(), ws: existing.wsUrl });
      return null;
    }

    const exe = this.opts.exePath.trim();
    if (!exe) return '没配 worlds.browser.ownBrowserExe（浏览器可执行文件的路径）';
    if (!existsSync(exe)) return `ownBrowserExe 指向的文件不存在：${exe}`;
    if (!this.opts.home.trim()) return '没配 worlds.browser.ownBrowserHome（她的浏览器"家"目录）';

    try {
      mkdirSync(chromeProfileDir(this.opts.home), { recursive: true });
    } catch (err) {
      return `建不了她的浏览器目录：${describe(err)}`;
    }

    const args = ownBrowserArgs(this.opts);
    try {
      const child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => {
        this.lastError = `拉不起浏览器：${err.message}`;
        log.error('拉不起她的浏览器', err);
      });
      child.unref(); // 别跟着本进程的退出走：World 重启时它应该还在，下次探活就能复用
      this.child = child;
      log.info('已拉起她的浏览器', { exe, cdpPort: this.opts.cdpPort, home: this.opts.home });
    } catch (err) {
      return `拉不起浏览器：${describe(err)}`;
    }

    const deadline = Date.now() + Math.max(2000, timeoutMs);
    while (Date.now() < deadline) {
      const info = await readVersion(this.opts.cdpPort, PROBE_TIMEOUT_MS);
      if (info) {
        this.writeDiscovery(info);
        return null;
      }
      await sleep(READY_POLL_MS);
    }
    return `浏览器起来了但调试口 ${this.opts.cdpPort} 没响应（等了 ${Math.round(timeoutMs / 1000)} 秒）`;
  }

  /** 把发现文件写成它现在的样子。上游据此认出这个实例。 */
  private writeDiscovery(info: VersionInfo): void {
    try {
      const file = devToolsActivePortFile(this.opts.home);
      mkdirSync(chromeProfileDir(this.opts.home), { recursive: true });
      writeFileSync(file, `${this.opts.cdpPort}\n${info.wsPath}\n`, 'utf8');
    } catch (err) {
      // 写不了不致命：探活那条路（`/json/version`）仍然是通的，只是上游可能认不出它。
      this.lastError = `写不了 ${devToolsActivePortFile(this.opts.home)}：${describe(err)}`;
    }
  }

  /** 只关自己拉起的那个进程（连同它的子进程）。复用的实例不动。 */
  stop(): void {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    this.child = null;
    try {
      child.kill();
      if (process.platform === 'win32') {
        // Chrome 是一棵进程树，杀掉主进程之后子进程不一定跟着走。
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
          'error',
          () => {},
        );
      }
    } catch {
      // 关不掉不该把 World 带崩
    }
  }
}

/**
 * 把某个 tab 调到前台，并读回它现在的 `document.visibilityState` 当回执。
 *
 * 这是整个"她能播"的开关：量过的实底是——隐藏 tab 里 `play()` 既不 resolve 也不 reject、
 * `readyState` 停在 0；`Target.activateTarget` 之后同一句 `play()` 立刻走完、`readyState: 4`、
 * `currentTime` 开始走。顺带它还把冻结的 tab 叫醒。
 *
 * 直连浏览器自己的 WebSocket（Node 22 原生 `WebSocket`），因为上游没有这个端点。
 */
export async function activateTarget(
  cdpPort: number,
  targetId: string,
  timeoutMs = 5000,
): Promise<{ visibility: string }> {
  const version = await readVersion(cdpPort, timeoutMs);
  if (!version) throw new Error(`浏览器的调试口 ${cdpPort} 没响应`);

  const ws = new WebSocket(version.wsUrl);
  let seq = 0;
  const call = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      const onMessage = (ev: MessageEvent) => {
        let msg: { id?: number; error?: unknown; result?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(`${method} -> ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连不上浏览器的 WebSocket')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连不上浏览器的 WebSocket'));
      });
    });

    await call('Target.activateTarget', { targetId });
    const attached = (await call('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    const evaluated = (await call(
      'Runtime.evaluate',
      { expression: 'document.visibilityState', returnByValue: true },
      attached.sessionId,
    )) as { result?: { value?: unknown } };
    const visibility = typeof evaluated.result?.value === 'string' ? evaluated.result.value : '';
    return { visibility };
  } finally {
    try {
      ws.close();
    } catch {
      // 关不掉无所谓
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
