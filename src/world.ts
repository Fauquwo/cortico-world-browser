/**
 * Browser World：把本机 web-access 的 CDP proxy 接成一个浏览器。
 *
 * 环境是操作员日常用的那个浏览器（带着他所有网站的登录态）。这个类做三件事：
 * 管 proxy 的起停、把工具调用翻译成 HTTP 调用、把浏览器里他自己的动向报成事件。
 *
 * 起停沿用 SenseVoice 那一套：先探活，通了就复用（他自己或 coding agent 已经在跑的情况下
 * 不重复拉起），探不通才 spawn，`stop()` 只关自己拉起的那个。起不来不抛错——投一条
 * `browser.down`，让工具去报失败，这样 bot 知道「手现在不能用」，而不是这个 World 整个消失。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  World,
  WorldConsoleDecl,
  WorldHost,
  WorldLamp,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CdpRelay, RelayError, classifyRelayError, runFindUrl, type EvalResult, type PageTarget, type RelayFailureKind, type RelayHealth } from './cdp-client.ts';
import { BROWSER_CONFIG_GROUP, type BrowserConfigSection } from './config.ts';
import { OwnBrowser, activateTarget } from './own-browser.ts';
import { readExpression, typeExpression } from './page-scripts.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 开页时顺手读回的正文上限：够看清这个页面在讲什么，又不把上下文塞满。 */
const OPEN_TEXT_MAX = 4000;
/** `browser_read` 的默认值与上限。 */
const READ_TEXT_DEFAULT = 8000;
const READ_TEXT_MAX = 40000;
/** 回执里列几条链接。 */
const LINKS_SHOWN = 20;
/** `browser_js` 回执里值序列化之后的上限。 */
const JS_VALUE_MAX = 30000;
/** `browser_tabs` 的变化段最多列几条。 */
const CHANGES_MAX = 12;
/** 等就绪的轮询间隔。 */
const READY_POLL_MS = 1000;
/** `find-url.mjs` 跑一次的上限：它要开本机的 sqlite 历史库。 */
const FIND_URL_TIMEOUT_MS = 20000;
/**
 * 导航那一段的下限超时。普通调用超时（`requestTimeoutMs`）默认 30 秒，而站点打不通时上游的
 * `Page.navigate` 正好要等它自己的 30 秒 CDP 超时才回话——客户端若也卡在 30 秒，拿到的只是本地
 * 那句 `aborted due to timeout`，真话被挡在外面。宽这 5 秒是为了拿到**上游自己的回答**。
 */
const NAV_TIMEOUT_MIN_MS = 35_000;
/** 导航没成之后，再试读一次那块内容用的短超时：页面那一侧可能还卡着，别把调用再拖长一轮。 */
const NAV_FAILED_DUMP_MS = 5000;

/**
 * 这一类失败（导航没在窗口内完成）要说的话。
 *
 * 关键是**别让她以为浏览器坏了**：2026-09-30 那天她连着三次 `browser_open example.com` 拿到
 * 「连不上 cdp-proxy + 去开远程调试」，顺手把「browser 别再试了」写进了自己的笔记——而浏览器
 * 与 proxy 全程都是好的，打不开的是那个域名。
 */
const NAV_UNANSWERED_HINT =
  '（proxy 与浏览器都是通的：多半是那个地址在这台机器上打不开、或者页面太慢。' +
  '先确认这个站点连得上，或换个地址再试——不是浏览器坏了。）';

/** 这一类失败（命令发出去没回话）要说的话。 */
const COMMAND_TIMEOUT_HINT =
  '（proxy 与浏览器都是通的：是这一发命令没回话，多半那个页面自己卡着。换个页面或过一会儿再试。）';

/** 失败归类在回执里的说法。 */
const FAILURE_LABEL: Record<RelayFailureKind | 'nav', string> = {
  unreachable: '连不上 proxy',
  'not-connected': '浏览器没连上',
  'command-timeout': '命令没回话',
  nav: '页面没打开',
  relay: 'proxy 报错',
};

/** 浏览器的内部页面不进变化段：那不是「他去了哪儿」。 */
const INTERNAL_URL = /^(chrome|edge|brave|about|devtools|chrome-extension|extension|chrome-untrusted):/i;

const KIND_VERB: Record<PageChange['kind'], string> = { opened: '打开', moved: '转到', closed: '关掉' };

/** 两次查看之间，一个页面发生的变化。 */
interface PageChange {
  kind: 'opened' | 'moved' | 'closed';
  label: string;
}

interface SeenPage {
  url: string;
  title: string;
}

/** `browser_read` 读回来的页面。 */
interface PageDump {
  title: string;
  url: string;
  ready: string;
  text: string;
  links: Array<{ text: string; url: string }>;
  truncated: boolean;
  error?: string;
}

export interface BrowserWorldOptions {
  /** `worlds.browser` 的活引用。 */
  cfg: BrowserConfigSection;
  timezone: string;
}

export class BrowserWorld implements World {
  readonly id = 'browser';

  private readonly relay: CdpRelay;
  /**
   * 配了专属实例时才有：她的浏览器由本 World 起停，并且我们还要直接对它说一句 CDP
   * （`Target.activateTarget`，上游没有这个端点）。没配时为 null，一切照旧。
   */
  private readonly own: OwnBrowser | null;
  private host: WorldHost | null = null;
  private running = false;
  private state: 'idle' | 'starting' | 'ready' | 'failed' = 'idle';
  private lastError = '';
  /** proxy 报的浏览器名，没有时为配置里的那个。 */
  private browserLabel = '';
  /** 自己开的页面；只有这些允许关。 */
  private readonly mine = new Set<string>();
  /**
   * 上一次 `browser_tabs` 看到的页面：targetId → 页面，加一个看的时间。
   * 只在被她问的时候更新——这个 World 自己不定时看任何东西。
   */
  private readonly seen = new Map<string, SeenPage>();
  private seenAt = 0;
  /** proxy 掉了之后补拉过一次就不再试了。 */
  private recoveryTried = false;

  constructor(private readonly opts: BrowserWorldOptions) {
    const cfg = opts.cfg;
    this.own = cfg.ownBrowser
      ? new OwnBrowser({
          exePath: cfg.ownBrowserExe.trim(),
          home: cfg.ownBrowserHome.trim(),
          cdpPort: cfg.ownBrowserPort,
        })
      : null;
    this.relay = new CdpRelay({
      skillDir: cfg.skillDir.trim(),
      browser: cfg.browser.trim(),
      port: cfg.port,
      tabIdleMinutes: cfg.tabIdleMinutes,
      // 专属实例那一路：把"家"当 LOCALAPPDATA 交给 proxy，上游据此发现她那个实例。
      localAppDataRoot: this.own ? cfg.ownBrowserHome.trim() : undefined,
    });
  }

  /** 模板里的占位符：她操作的是哪个浏览器、是不是她自己的那个、开出来的页面在前台还是后台。 */
  envPromptVars(): Record<string, string> {
    const own = this.own !== null;
    const front = own && this.opts.cfg.bringToFront;
    return {
      'browser.label': displayBrowser(this.opts.cfg.browser),
      'browser.kind': own
        ? '你自己那个专属实例（独立 profile 与调试端口，不带操作员的登录态）'
        : '操作员日常用的那个浏览器（带着他所有网站的登录态）',
      'browser.front': front
        ? '你开出来、导航到的那个页面会被带到最前面——它在你自己的浏览器窗口里，不碍他'
        : '你开出来的页面是后台 tab，不打扰他',
    };
  }

  console(): WorldConsoleDecl {
    const cfg = this.opts.cfg;
    return {
      lamps: [this.lamp()],
      badges: [
        { label: '浏览器', value: this.browserLabel || displayBrowser(cfg.browser) || '未配置', tone: 'plain' },
        ...(this.own
          ? [{ label: '她的浏览器', value: `127.0.0.1:${cfg.ownBrowserPort}`, tone: 'plain' as const }]
          : []),
        { label: 'proxy', value: `127.0.0.1:${cfg.port}`, tone: 'plain' },
        { label: '她开的页', value: this.mine.size, tone: 'plain' },
      ],
      config: [BROWSER_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.browser.envPrompt',
          title: 'Browser · 环境提示词',
          description: '这个浏览器这一段进 system 前缀的说明；留空则该 World 不进入前缀。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'browser.label', description: '当前配置要操作的浏览器。' },
            { name: 'browser.kind', description: '那是她自己的实例，还是操作员日常那个。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.running = true;
    const log = host.log.child(this.id);
    try {
      // 配了专属实例：先保证它在跑，并把发现文件写出来——上游的 proxy 就是靠那个文件认出它的。
      if (this.own) {
        const ownProblem = await this.own.ensure(log, this.opts.cfg.readyTimeoutMs);
        if (ownProblem) {
          this.state = 'failed';
          this.lastError = ownProblem;
          log.warn('她自己的浏览器起不来', { error: ownProblem });
          await this.emit(
            'browser.down',
            `浏览器起不来：${ownProblem}。（看 worlds.browser.ownBrowserExe 与 ownBrowserHome 配得对不对。）`,
          );
          return;
        }
      }

      const health = await this.relay.probe();
      if (health) {
        this.browserLabel = health.browserLabel || health.browserId;
        if (await this.relay.reachable()) {
          const wrongTarget = await this.ownTargetProblem(health);
          if (wrongTarget) {
            this.state = 'failed';
            this.lastError = wrongTarget;
            log.warn('proxy 连的不是她那个实例', { error: wrongTarget });
            await this.emit('browser.down', `浏览器不可用：${wrongTarget}`);
            return;
          }
          this.state = 'ready';
          log.info('复用已在运行的 cdp-proxy', { endpoint: this.relay.endpoint(), browser: this.browserLabel });
          await this.emit(
            'browser.ready',
            `浏览器已就绪（复用了已在运行的 proxy，${this.relay.endpoint()}，${this.browserLabel || '浏览器未识别'}）。`,
          );
          return;
        }
        // 端口上已经有 proxy 了，但浏览器没接上。不再拉起一个去抢端口。
        this.state = 'failed';
        this.lastError = '已经有一个 proxy 在跑，但它没连上浏览器';
        log.warn('复用的 proxy 没连上浏览器');
        await this.emit('browser.down', `浏览器不可用：${this.lastError}。${this.connectHint()}`);
        return;
      }

      this.state = 'starting';
      const portProblem = await this.relay.checkPort();
      if (portProblem) {
        this.state = 'failed';
        this.lastError = portProblem;
        log.warn('这个端口用不了，不拉了', { error: portProblem });
        await this.emit('browser.down', `浏览器起不来：${portProblem}${this.connectHint()}`);
        return;
      }
      if (!this.relay.spawnProxy(log)) {
        this.state = 'failed';
        this.lastError = this.relay.failure;
        await this.emit('browser.down', `浏览器起不来：${this.lastError}。${this.connectHint()}`);
        return;
      }
      if (!(await this.waitReady(this.opts.cfg.readyTimeoutMs))) {
        this.state = 'failed';
        this.lastError = this.relay.failure || '等它连上浏览器超时';
        log.warn('cdp-proxy 没能连上浏览器', { error: this.lastError });
        await this.emit('browser.down', `浏览器没能就绪：${this.lastError}。${this.connectHint()}`);
        return;
      }
      const wrongTarget = await this.ownTargetProblem();
      if (wrongTarget) {
        this.state = 'failed';
        this.lastError = wrongTarget;
        log.warn('proxy 连的不是她那个实例', { error: wrongTarget });
        await this.emit('browser.down', `浏览器不可用：${wrongTarget}`);
        return;
      }
      this.state = 'ready';
      log.info('浏览器已就绪', { endpoint: this.relay.endpoint(), browser: this.browserLabel });
      await this.emit('browser.ready', `浏览器已就绪（${this.relay.endpoint()}，${this.browserLabel || displayBrowser(this.opts.cfg.browser)}）。`);
    } catch (err) {
      this.state = 'failed';
      this.lastError = describe(err);
      log.error('启动 Browser World 时出错', err);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.relay.stop(); // 只关自己拉起的那个
    this.own?.stop(); // 同理：复用的那个实例不动它
    this.state = 'idle';
    this.host = null;
    this.seen.clear();
    this.seenAt = 0;
    this.recoveryTried = false;
  }

  /**
   * 配了专属实例时，核对 proxy 连的**确实是那个实例**。
   *
   * 会走神的情形：他刚把 `ownBrowser` 打开，而端口上还挂着一个老的 proxy（连着他日常那个 Edge）。
   * 那种情况下这个 World 会静默地去操作他的浏览器——正是我们想离开的东西，必须当场说清。
   * 拿不到 `/health` 时不算这里的问题：工具那条路自己会报。
   */
  private async ownTargetProblem(health?: RelayHealth | null): Promise<string | null> {
    if (!this.own) return null;
    const info = health ?? (await this.relay.probe());
    if (!info) return null;
    if (info.chromePort > 0 && info.chromePort !== this.opts.cfg.ownBrowserPort) {
      return (
        `proxy 连的是端口 ${info.chromePort} 上的浏览器，不是她自己的那个（${this.opts.cfg.ownBrowserPort}）。` +
        `多半是端口 ${this.opts.cfg.port} 上还挂着一个连别处的旧 proxy：先停掉它，或者重启这个 World。`
      );
    }
    return null;
  }

  // ——— 状态与轮询 ———

  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (await this.relay.reachable(READY_POLL_MS * 2)) return true;
      if (!this.running) return false;
      await sleep(READY_POLL_MS);
    }
    return false;
  }

  /**
   * 与她上次问的时候比：他新开了、转到、关掉了哪些页面。
   *
   * 这个 World 自己**不定时看任何东西**——她想知道他在干什么，调一次 `browser_tabs` 就是问一次。
   * 因此报的是「自你上次看以来」的净变化：中间开了又关的页面看不见，那不是做不到，是没在采样。
   */
  private collectChanges(targets: readonly PageTarget[]): { changes: PageChange[]; sinceMs: number } {
    const first = this.seenAt === 0;
    const changes: PageChange[] = [];
    const present = new Set<string>();
    for (const target of targets) {
      present.add(target.targetId);
      const previous = this.seen.get(target.targetId);
      if (previous && previous.url === target.url && previous.title === target.title) continue;
      this.seen.set(target.targetId, { url: target.url, title: target.title });
      // 第一次看没有可比的东西；她自己开的页面不是他的动向。
      if (first || this.mine.has(target.targetId) || INTERNAL_URL.test(target.url)) continue;
      changes.push({ kind: previous ? 'moved' : 'opened', label: labelOf({ url: target.url, title: target.title }) });
    }
    for (const [targetId, page] of [...this.seen]) {
      if (present.has(targetId)) continue;
      this.seen.delete(targetId);
      if (first || this.mine.has(targetId) || INTERNAL_URL.test(page.url)) continue;
      changes.push({ kind: 'closed', label: labelOf(page) });
    }
    const sinceMs = this.seenAt === 0 ? 0 : Date.now() - this.seenAt;
    this.seenAt = Date.now();
    return { changes, sinceMs };
  }

  /** proxy 死了不会自己回来，而没有定时器在替我们看着。整场只补拉一次。 */
  private async tryRelaunch(): Promise<void> {
    const host = this.host;
    if (!host || this.recoveryTried || this.relay.owned || !this.opts.cfg.skillDir.trim()) return;
    this.recoveryTried = true;
    const log = host.log.child(this.id);
    const portProblem = await this.relay.checkPort();
    if (portProblem) {
      log.warn('端口用不了，不补拉了', { error: portProblem });
      return;
    }
    log.info('proxy 不在了，补拉一次');
    if (!this.relay.spawnProxy(log)) return;
    // 这是在一次工具调用里等，别把调用本身拖到超时。
    if (!(await this.waitReady(Math.min(4000, this.opts.cfg.readyTimeoutMs)))) {
      log.warn('补拉的 proxy 也没能连上浏览器');
    }
  }

  private lamp(): WorldLamp {
    switch (this.state) {
      case 'ready':
        return { label: '浏览器', state: 'online', hint: `${this.browserLabel || displayBrowser(this.opts.cfg.browser)} · ${this.relay.endpoint()}` };
      case 'starting':
        return { label: '浏览器', state: 'loading', hint: `${this.relay.endpoint()} · 等它连上浏览器` };
      case 'failed':
        return { label: '浏览器', state: 'error', hint: this.lastError || '连不上浏览器' };
      default:
        return { label: '浏览器', state: 'offline', hint: `${this.relay.endpoint()} · 未启动` };
    }
  }

  private async emit(type: string, text: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
      });
    } catch {
      // 投递失败不该把 World 自己带崩
    }
  }

  private connectHint(): string {
    if (/端口/.test(this.lastError)) {
      return '（换一个没被占用的 worlds.browser.port：Windows 保留的端口段会报 EACCES。）';
    }
    if (this.own) {
      return (
        '（这是她自己那个实例，不是操作员日常的浏览器：看 ownBrowserExe / ownBrowserHome 配得对不对，' +
        `或它是不是被关掉了、端口 ${this.opts.cfg.ownBrowserPort} 上有没有别的东西。）`
      );
    }
    const browser = this.opts.cfg.browser.trim() || 'chrome';
    return (
      `（要在${displayBrowser(browser)}的地址栏打开 ${browser}://inspect/#remote-debugging，` +
      '勾选「Allow remote debugging for this browser instance」。）'
    );
  }

  /**
   * 把一个 tab 调到前台。`null` = 用不上（没配专属实例，或者开关关着）；否则是结果。
   *
   * 为什么需要（2026-10-01 量的）：隐藏 tab 里媒体**加载不起来**——页面调了 `play()`，
   * `readyState` 一直停在 0、`currentTime` 不动；闲置几分钟后整个 tab 还被冻结。
   * 同一句 `play()` 在 `Target.activateTarget` 之后立刻走完。所以"调到前台"就是"她能播"的开关。
   *
   * 只在有专属实例时做：那时候带上来的是**她自己的窗口**，不抢操作员正在用的那个。
   */
  private async bringToFront(targetId: string): Promise<{ visibility: string } | { error: string } | null> {
    if (!this.own) return null;
    if (!this.opts.cfg.bringToFront) return null;
    try {
      return await activateTarget(this.opts.cfg.ownBrowserPort, targetId, Math.min(5000, this.timeout()));
    } catch (err) {
      return { error: describe(err) };
    }
  }

  /** 调前台失败时附在回执里的那句话（成功就什么都不说）。 */
  private frontNote(result: { visibility: string } | { error: string } | null): string {
    if (result === null || 'visibility' in result) return '';
    return `（没能把这个页面带到前台：${result.error}。页面在后台时媒体不会加载，要用到它就先 browser_focus 再试。）`;
  }

  private timeout(): number {
    return Math.max(3000, this.opts.cfg.requestTimeoutMs);
  }

  /** 导航那一段单独的超时：见 `NAV_TIMEOUT_MIN_MS` 的注释。 */
  private navTimeout(): number {
    return Math.max(this.timeout(), NAV_TIMEOUT_MIN_MS);
  }

  /**
   * 工具调用前的现查：状态可能是陈旧的，先探一次；还是不通就顺手补拉一次 proxy，
   * 再不通才报不可用。没有定时器在替她看着，所以补拉挂在这一条路上。
   */
  private async ensureReady(): Promise<string | null> {
    if (this.state === 'ready') return null;
    if (await this.relay.reachable(this.timeout())) {
      this.state = 'ready';
      this.lastError = '';
      return null;
    }
    await this.tryRelaunch();
    if (await this.relay.reachable(this.timeout())) {
      this.state = 'ready';
      this.lastError = '';
      return null;
    }
    const port = this.relay.endpoint();
    const reason = this.lastError || this.relay.failure || '没连上浏览器';
    return `浏览器不可用（${port}）：${reason}。${this.connectHint()}`;
  }

  // ——— 工具 ———

  tools(): ToolDef[] {
    return [
      this.openTool(),
      this.readTool(),
      this.jsTool(),
      this.clickTool(),
      this.typeTool(),
      this.uploadTool(),
      this.scrollTool(),
      this.shotTool(),
      this.navigateTool(),
      this.tabsTool(),
      this.focusTool(),
      this.closeTool(),
      this.findUrlTool(),
    ];
  }

  private openTool(): ToolDef {
    return {
      name: 'browser_open',
      description:
        'Open a page in a new background tab in the operator\'s own browser and return what the page shows: ' +
        'title, URL, its readable text and its links. The tab carries the operator\'s login state. ' +
        'Use the returned `target` value for every later call on that page. ' +
        'A URL written without a scheme gets https:// in front of it.',
      tags: ['act', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Address to open, for example `example.com/report`.' },
        },
        required: ['url'],
      },
      handler: async (args, ctx) => this.open(args, ctx),
    };
  }

  private readTool(): ToolDef {
    return {
      name: 'browser_read',
      description:
        'Read the readable text and links of a page you already opened, by `target`. ' +
        'Pass `selector` to read one part of the page instead of the whole document. ' +
        'Text reaching the limit is cut and flagged. `ready` is the document readyState, not proof the ' +
        'content you want has appeared.',
      tags: ['read', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          selector: { type: 'string', description: 'CSS selector to read inside, for example `main article`.' },
          maxChars: { type: 'integer', description: `How much text to return; default ${READ_TEXT_DEFAULT}, max ${READ_TEXT_MAX}.` },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.read(args, ctx),
    };
  }

  private jsTool(): ToolDef {
    return {
      name: 'browser_js',
      description:
        'Evaluate one JavaScript expression inside the page and return its value. This is the escape hatch when ' +
        'the other tools do not cover what the page needs. Expressions only: to run several statements, wrap them ' +
        'yourself as `(async () => { ... })()` and return a value. A thrown error comes back as a failed receipt. ' +
        'The value must be JSON-serializable; DOM nodes and functions come back as their names.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          expression: { type: 'string', description: 'JavaScript expression, for example `document.querySelectorAll("a").length`.' },
        },
        required: ['target', 'expression'],
      },
      handler: async (args, ctx) => this.js(args, ctx),
    };
  }

  private clickTool(): ToolDef {
    return {
      name: 'browser_click',
      description:
        'Click the first element matching a CSS selector. Default is a JS click, which covers most cases. ' +
        '`native: true` sends a real mouse event at the element\'s centre: use it when the page ignores a JS click, ' +
        'when the click should count as a user gesture, or when it should open a file dialog. ' +
        'Returns what was clicked and the page\'s title and URL right after.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          selector: { type: 'string', description: 'CSS selector of the element to click.' },
          native: { type: 'boolean', description: 'Send a real mouse event instead of `el.click()`.' },
        },
        required: ['target', 'selector'],
      },
      handler: async (args, ctx) => this.click(args, ctx),
    };
  }

  private typeTool(): ToolDef {
    return {
      name: 'browser_type',
      description:
        'Type a value into an input, textarea, select or contenteditable element, then fire input and change events ' +
        'so frameworks notice. `submit: true` sends the value and submits: the containing form when there is one, ' +
        'otherwise an Enter key press on the element.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          selector: { type: 'string', description: 'CSS selector of the field.' },
          value: { type: 'string', description: 'Text to put in, or the option of a select.' },
          submit: { type: 'boolean', description: 'Submit after typing.' },
        },
        required: ['target', 'selector', 'value'],
      },
      handler: async (args, ctx) => this.type(args, ctx),
    };
  }

  private uploadTool(): ToolDef {
    return {
      name: 'browser_upload',
      description:
        'Attach local files to a page\'s file input, bypassing the file dialog. ' +
        '`files` are absolute paths on this machine — a file in your own workspace is one.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          selector: { type: 'string', description: 'CSS selector of the `input[type=file]`.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to attach.' },
        },
        required: ['target', 'selector', 'files'],
      },
      handler: async (args, ctx) => this.upload(args, ctx),
    };
  }

  private scrollTool(): ToolDef {
    return {
      name: 'browser_scroll',
      description:
        'Scroll the page. `to: bottom` is the usual one: it loads lazy content, so images and later sections ' +
        'exist in the DOM afterwards. `y` is the distance for `down` and `up`.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          to: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Where to scroll; default `down`.' },
          y: { type: 'integer', description: 'Pixels for `down` / `up`; default 3000.' },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.scroll(args, ctx),
    };
  }

  private shotTool(): ToolDef {
    return {
      name: 'browser_shot',
      description:
        'Capture one screenshot of the page and attach it to the receipt. The image is the viewport, not the whole ' +
        'document. Use it when the content is in images, canvas or video, where the readable text comes back empty ' +
        'or thin — and scroll first if the part you need is further down.',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.shot(args, ctx),
    };
  }

  private navigateTool(): ToolDef {
    return {
      name: 'browser_navigate',
      description:
        'Move an existing tab to another address, or go back one entry. Use `browser_open` instead when you want ' +
        'a second page at the same time. A URL without a scheme gets https:// in front of it.',
      tags: ['act', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
          url: { type: 'string', description: 'Address to move to.' },
          back: { type: 'boolean', description: 'Go back one entry in this tab\'s history instead.' },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.navigate(args, ctx),
    };
  }

  private tabsTool(): ToolDef {
    return {
      name: 'browser_tabs',
      description:
        'List the pages open in the browser right now, each with its target id. ' +
        'Entries are marked `mine: true` when you opened them — those are the only ones `browser_close` accepts. ' +
        'When the browser is the operator\'s own, this also reports what changed since the previous call: the pages ' +
        'he opened, moved or closed in between, as a net difference (a page he opened and closed in between leaves ' +
        'no trace, and the browser\'s own pages never appear). ' +
        'When it is your own instance, there is nobody else browsing in it, so no change section is reported.',
      tags: ['read', 'snapshot'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.tabs(),
    };
  }

  /**
   * 把一个页面带到前台。
   *
   * 它不只是"露个脸"：后台 tab 里页面是僵的（媒体不加载、定时器被夹、久了自己冻住），
   * 所以这是"把页面叫醒"的手段——要在页面上播东西、或者等一个自己刷新的看板时先叫它。
   */
  private focusTool(): ToolDef {
    return {
      name: 'browser_focus',
      description:
        'Bring one of your pages to the front of the browser, and wake it up. Media only loads and plays in a page ' +
        'that is in front: a page left in the background for minutes gets frozen, so its timers, animations and ' +
        'async work stall until it is brought back. Call this before playing something on a page you opened a while ' +
        'ago, and when a page that used to work seems asleep. The receipt tells you the page\'s ' +
        'document.visibilityState afterwards.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id returned by browser_open or browser_tabs.' },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.focus(args, ctx),
    };
  }

  private closeTool(): ToolDef {
    return {
      name: 'browser_close',
      description:
        'Close a page you opened. Pages the operator opened are refused on purpose: closing one loses his state. ' +
        'Your pages are also closed automatically when they sit idle, so this is for tidying up sooner than that.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target id of a page you opened.' },
        },
        required: ['target'],
      },
      handler: async (args, ctx) => this.close(args, ctx),
    };
  }

  private findUrlTool(): ToolDef {
    return {
      name: 'browser_find_url',
      description:
        'Search this machine\'s browser bookmarks and history for a URL. Use it when the target is something the ' +
        'operator has visited — a page he mentions by name, an internal system no search engine can reach. ' +
        'Keywords are AND-ed and match title and URL. Returns the tool\'s own listing text.',
      tags: ['read', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: 'Words to match, all of them.' },
          only: { type: 'string', enum: ['bookmarks', 'history'], description: 'Search one source only.' },
          browser: { type: 'string', enum: ['chrome', 'edge'], description: 'Limit to one browser\'s data.' },
          limit: { type: 'integer', description: 'How many results; default 20 in the tool itself.' },
          since: { type: 'string', description: 'History only: `1d`, `7h`, `30m` or `YYYY-MM-DD`.' },
          sort: { type: 'string', enum: ['recent', 'visits'], description: 'History only: by last visit or by visit count.' },
        },
        required: [],
      },
      handler: async (args, ctx) => this.findUrl(args, ctx),
    };
  }

  // ——— 工具实现 ———

  private async open(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const raw = str(args.url);
    if (!raw) return fail('url 是空的：给一个要打开的地址。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    // ① 先建一个空白 tab：这一步快（本机量过 167 毫秒），而且**拿到 id 就先认下来**——
    //    后面无论导航成不成，这个页面都认得出、关得掉，不会再留孤儿。
    let targetId: string;
    try {
      targetId = await this.relay.openBlank(this.timeout(), ctx.signal);
    } catch (err) {
      return fail(this.explain(err, 'open'));
    }
    this.mine.add(targetId);

    // ② 再单独导航。这一段走 navTimeout()，比普通调用宽：站点打不通时上游要等它自己的 30 秒
    //    CDP 超时才回话，客户端卡在 30 秒上只会把真话挡在外面。
    try {
      await this.relay.navigate(targetId, withScheme(raw), this.navTimeout(), ctx.signal);
    } catch (err) {
      const front = await this.bringToFront(targetId); // 那段短超时试读要页面"活"着才读得到
      const told = this.explain(err, '导航', 'nav');
      const page = await this.dump(targetId, null, OPEN_TEXT_MAX, ctx, NAV_FAILED_DUMP_MS);
      return fail(
        `${told}\n` +
          `target: ${targetId} 这个页面还开着（多半是那个站点的问题）：你稍后可以再 browser_read 一次，或 browser_close 关掉它。` +
          (front && 'error' in front ? `\n（顺带说一句，也没能把它带到前台：${front.error}。）` : '') +
          (page.ok ? `\n它此刻显示的是：\n${renderPage(page.page, OPEN_TEXT_MAX)}` : ''),
      );
    }

    // ③ 先带到前台再读。隐藏 tab 里的页面是"僵"的：媒体不加载、靠 JS 驱动的渲染也不动，
    //    带到前台之后读回来的才是它真正的样子。
    const front = await this.bringToFront(targetId);
    const page = await this.dump(targetId, null, OPEN_TEXT_MAX, ctx);
    if (!page.ok) return fail(`页面已打开（target ${targetId}），但没能读回内容：${page.text}`);
    return {
      text: [`已打开（target ${targetId}）。`, this.frontNote(front), renderPage(page.page, OPEN_TEXT_MAX)]
        .filter((part) => part !== '')
        .join('\n'),
    };
  }

  private async read(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    const selector = str(args.selector) || null;
    const maxChars = clampInt(args.maxChars, READ_TEXT_DEFAULT, 200, READ_TEXT_MAX);
    const page = await this.dump(target, selector, maxChars, ctx);
    if (!page.ok) return fail(page.text);
    return { text: renderPage(page.page, maxChars) };
  }

  private async js(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    const expression = str(args.expression);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    if (!expression) return fail('expression 是空的：给一段要在页面里求值的 JS 表达式。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    let result: EvalResult;
    try {
      result = await this.relay.evaluate(target, expression, this.timeout(), ctx.signal);
    } catch (err) {
      return fail(this.explain(err, 'eval'));
    }
    if (!result.ok) return fail(`页面里那句 JS 抛了错：\n${truncate(result.error, 2000)}`);
    return { text: `页面里求值的结果：\n${renderValue(result.value, JS_VALUE_MAX)}` };
  }

  private async click(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    const selector = str(args.selector);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    if (!selector) return fail('selector 是空的：给一个 CSS 选择器。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    const native = args.native === true;
    try {
      const clicked = await this.relay.click(target, selector, native, this.timeout(), ctx.signal);
      const info = await this.relay.info(target, this.timeout(), ctx.signal).catch(() => null);
      const head = `已点击 ${native ? '（真实鼠标）' : ''}：${clicked.tag}${clicked.text ? ` 「${truncate(clicked.text, 80)}」` : ''}`;
      const tail = info ? `点击后此刻：${info.title || '(无标题)'} · ${info.url}（${info.ready}）` : null;
      return { text: [head, tail].filter((line): line is string => line !== null).join('\n') };
    } catch (err) {
      return fail(this.explain(err, 'click'));
    }
  }

  private async type(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    const selector = str(args.selector);
    const value = typeof args.value === 'string' ? args.value : '';
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    if (!selector) return fail('selector 是空的：给一个 CSS 选择器。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    let result: EvalResult;
    try {
      result = await this.relay.evaluate(
        target,
        typeExpression(selector, value, args.submit === true),
        this.timeout(),
        ctx.signal,
      );
    } catch (err) {
      return fail(this.explain(err, 'type'));
    }
    if (!result.ok) return fail(`页面里那句 JS 抛了错：\n${truncate(result.error, 2000)}`);
    const outcome = result.value as { ok?: unknown; error?: unknown; applied?: unknown; value?: unknown; submitted?: unknown };
    if (!outcome || outcome.ok !== true) {
      return fail(`没填进去：${typeof outcome?.error === 'string' ? outcome.error : '页面上没有这个元素'}`);
    }
    const applied = typeof outcome.applied === 'string' ? outcome.applied : '';
    const current = typeof outcome.value === 'string' ? outcome.value : '';
    const submitted = typeof outcome.submitted === 'string' ? `，已提交（${outcome.submitted}）` : '';
    return { text: `已填入（${applied}）：${truncate(current, 200)}${submitted}` };
  }

  private async upload(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    const selector = str(args.selector);
    const files = Array.isArray(args.files) ? args.files.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    if (!selector) return fail('selector 是空的：给 file input 的 CSS 选择器。');
    if (files.length === 0) return fail('files 是空的：给要上传的文件的绝对路径。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    try {
      const count = await this.relay.setFiles(target, selector, files, this.timeout(), ctx.signal);
      return { text: `已给 ${selector} 挂上 ${count} 个文件：${files.join('、')}` };
    } catch (err) {
      return fail(this.explain(err, 'upload'));
    }
  }

  private async scroll(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    const to = ['down', 'up', 'top', 'bottom'].includes(str(args.to)) ? str(args.to) : 'down';
    const y = clampInt(args.y, 3000, 0, 1_000_000);
    try {
      const said = await this.relay.scroll(target, { direction: to, y }, this.timeout(), ctx.signal);
      return { text: said || `已滚动（${to}）` };
    } catch (err) {
      return fail(this.explain(err, 'scroll'));
    }
  }

  private async shot(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    try {
      const bytes = await this.relay.screenshot(target, this.timeout(), ctx.signal);
      const info = await this.relay.info(target, this.timeout(), ctx.signal).catch(() => null);
      const where = info ? `${info.title || '(无标题)'} · ${info.url}` : `target ${target}`;
      return {
        text: `截图：${where}\n这是视口那一屏，不是整页；要看更下面的内容先 browser_scroll。`,
        blobs: [
          {
            bytes,
            mime: 'image/png',
            name: 'screenshot.png',
            fallbackText: '页面截图（视口）',
          },
        ],
      };
    } catch (err) {
      return fail(this.explain(err, 'screenshot'));
    }
  }

  private async navigate(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    const back = args.back === true;
    const url = str(args.url);
    if (!back && !url) return fail('url 是空的：给一个要去的地址，或把 back 设成 true。');
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    try {
      if (back) await this.relay.back(target, this.navTimeout(), ctx.signal);
      else await this.relay.navigate(target, withScheme(url), this.navTimeout(), ctx.signal);
      const front = await this.bringToFront(target);
      const info = await this.relay.info(target, this.timeout(), ctx.signal).catch(() => null);
      const where = info ? `${info.title || '(无标题)'} · ${info.url}（${info.ready}）` : '页面已响应';
      return { text: `${back ? '已后退' : '已导航'}：${where} ${this.frontNote(front)}`.trimEnd() };
    } catch (err) {
      return fail(this.explain(err, '导航', 'nav'));
    }
  }

  private async tabs(): Promise<ToolOutcome> {
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);
    let targets: PageTarget[];
    try {
      targets = await this.relay.targets(this.timeout());
    } catch (err) {
      return fail(this.explain(err, 'tabs'));
    }
    const { changes, sinceMs } = this.collectChanges(targets);
    // 专属实例里没有"别人"在浏览：变化段报的是她自己的页面，没有意义，索性不报。
    const own = this.own !== null;
    const head = targets.length === 0
      ? own
        ? '你自己的浏览器里现在没有打开的页面。'
        : '浏览器里现在没有打开的页面。'
      : own
        ? `你自己的浏览器里现在有 ${targets.length} 个页面：`
        : `浏览器里现在有 ${targets.length} 个页面：`;
    const lines = targets.map((target) => {
      const mine = this.mine.has(target.targetId) ? '（我开的）' : '';
      return `- ${target.title || '(无标题)'}${mine}\n  ${target.url}\n  target: ${target.targetId}`;
    });
    return {
      text: [head, ...lines, own ? '' : renderChanges(changes, sinceMs)]
        .filter((part) => part !== '')
        .join('\n'),
    };
  }

  private async close(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 回的那个 target。');
    if (!this.mine.has(target)) {
      return fail(
        `这个页面不是我开的，不关：${target}。` +
          '他自己开的页面里可能有没保存的东西。要我关请先用 browser_open 打开它。',
      );
    }
    const notReady = await this.ensureReady();
    if (notReady) return fail(notReady);

    try {
      await this.relay.close(target, this.timeout(), ctx.signal);
    } catch (err) {
      return fail(this.explain(err, 'close'));
    }
    this.mine.delete(target);
    this.seen.delete(target);
    return { text: `已关闭 ${target}。` };
  }

  private async focus(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolOutcome> {
    const target = str(args.target);
    if (!target) return fail('target 是空的：给 browser_open 或 browser_tabs 回的那个 target。');
    if (!this.own) {
      return fail(
        '这个 World 没配专属实例（worlds.browser.ownBrowser），不能把 tab 调到前台：' +
          '那会抢操作员正在用的那个窗口。要用这个能力，就给她配一个她自己的浏览器实例。',
      );
    }
    if (!this.opts.cfg.bringToFront) {
      return fail('worlds.browser.bringToFront 关着，本 World 不会把页面带到前台。');
    }
    const result = await this.bringToFront(target);
    if (result === null) return fail('没能把它带到前台。');
    if ('error' in result) {
      return fail(
        `把它调到前台没成功：${result.error}。` +
          '如果是刚开出来的页面，多半是那个 target 已经不在了——用 browser_tabs 看一眼现在有哪些。',
      );
    }
    return { text: `已把 ${target} 调到前台（document.visibilityState = ${result.visibility || '未知'}）。` };
  }

  private async findUrl(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const skillDir = this.opts.cfg.skillDir.trim();
    if (!skillDir) return fail('worlds.browser.skillDir 没配：找不到 find-url.mjs。');
    if (!existsSync(join(skillDir, 'scripts', 'find-url.mjs'))) {
      return fail(`${skillDir}\\scripts 里没有 find-url.mjs：这个工具要 web-access 2.5.0 起才带。`);
    }
    const argv: string[] = [];
    if (Array.isArray(args.keywords)) {
      for (const word of args.keywords) {
        if (typeof word === 'string' && word.trim() !== '') argv.push(word.trim());
      }
    }
    const only = str(args.only);
    if (only === 'bookmarks' || only === 'history') argv.push('--only', only);
    const browser = str(args.browser);
    if (browser === 'chrome' || browser === 'edge') argv.push('--browser', browser);
    if (typeof args.limit === 'number' && Number.isFinite(args.limit)) argv.push('--limit', String(Math.round(args.limit)));
    const since = str(args.since);
    if (since) argv.push('--since', since);
    const sort = str(args.sort);
    if (sort === 'recent' || sort === 'visits') argv.push('--sort', sort);

    // 这个脚本要看他的书签库与历史库，跟页面无关，所以不走 proxy 的请求超时。
    ctx.signal?.throwIfAborted();
    const result = await runFindUrl(skillDir, argv, FIND_URL_TIMEOUT_MS);
    if (!result.ok) return fail(`书签历史检索没成功：\n${truncate(result.output, 2000)}`);
    return { text: result.output.trim() || '没有匹配的书签或历史记录。' };
  }

  // ——— 读页 ———

  /** 读一个页面。失败时给出一句能放进回执的话。 */
  private async dump(
    target: string,
    selector: string | null,
    maxChars: number,
    ctx: ToolCallContext,
    timeoutMs = this.timeout(),
  ): Promise<{ ok: true; page: PageDump } | { ok: false; text: string }> {
    let result: EvalResult;
    try {
      result = await this.relay.evaluate(target, readExpression(selector, maxChars), timeoutMs, ctx.signal);
    } catch (err) {
      return { ok: false, text: this.explain(err, 'read') };
    }
    if (!result.ok) return { ok: false, text: `读这个页面时页面里抛了错：\n${truncate(result.error, 2000)}` };
    const page = result.value as Partial<PageDump> | null;
    if (!page || typeof page !== 'object') return { ok: false, text: '读回来的不是页面内容。' };
    if (typeof page.error === 'string') return { ok: false, text: `没读到：${page.error}` };
    return {
      ok: true,
      page: {
        title: typeof page.title === 'string' ? page.title : '',
        url: typeof page.url === 'string' ? page.url : '',
        ready: typeof page.ready === 'string' ? page.ready : '',
        text: typeof page.text === 'string' ? page.text : '',
        links: Array.isArray(page.links) ? page.links.filter(isLink) : [],
        truncated: page.truncated === true,
      },
    };
  }

  /**
   * 一句话解释失败，并按**哪一类**失败决定贴哪段话。
   *
   * 教训（2026-09-30）：那段「去开远程调试」原先无条件贴（`status === 0` 就贴），于是「站点打不开」
   * 被念成「浏览器没连上」——bot 照着自己手里 `browser_tabs` 列得出 25 个页面这一点就矛盾了。
   * 现在只有「连不上 proxy」与「proxy 说浏览器没连上」才贴它；导航那一段（`step: 'nav'`）另有说法。
   */
  private explain(err: unknown, what: string, step: 'plain' | 'nav' = 'plain'): string {
    if (!(err instanceof RelayError)) return `${what} 没成功：${describe(err)}`;
    const kind: RelayFailureKind | 'nav' = step === 'nav' ? 'nav' : classifyRelayError(err);
    const tail =
      kind === 'unreachable' || kind === 'not-connected'
        ? ` ${this.connectHint()}`
        : kind === 'nav'
          ? ` ${NAV_UNANSWERED_HINT}`
          : kind === 'command-timeout'
            ? ` ${COMMAND_TIMEOUT_HINT}`
            : '';
    return `${what} 没成功（${FAILURE_LABEL[kind]}）：${err.message}${tail}`;
  }
}

// ——— 模块级小工具 ———

function renderPage(page: PageDump, maxChars: number): string {
  const head = `页面：${page.title || '(无标题)'}\n地址：${page.url}（${page.ready}）`;
  const body = page.text
    ? `正文${page.truncated ? `（被截到 ${maxChars} 字，要更多就再读一次并指定选择器）` : ''}：\n${page.text}`
    : '正文是空的：这一页的内容大概都在图片、画布或视频里，用 browser_shot 看一眼。';
  const links = page.links.length > 0
    ? `链接（${page.links.length} 条）：\n${page.links
        .slice(0, LINKS_SHOWN)
        .map((link) => `- ${truncate(link.text, 60)} → ${link.url}`)
        .join('\n')}`
    : '';
  return [head, body, links].filter((part) => part !== '').join('\n');
}

/** 变化那一段：只在他真的动了页面时出现，并且说清是「自你上次看以来」。 */
function renderChanges(changes: readonly PageChange[], sinceMs: number): string {
  if (changes.length === 0) return '';
  const shown = changes.slice(-CHANGES_MAX);
  const lines = shown.map((change) => `  ${KIND_VERB[change.kind]} ${change.label}`);
  const when = sinceMs > 0 ? `距你上次看约${elapsedText(sinceMs)}` : '自你上次看';
  const tail = changes.length > shown.length ? `  （另有 ${changes.length - shown.length} 条更早的）` : null;
  return [`[变化] ${when}：`, ...lines, tail].filter((line): line is string => line !== null).join('\n');
}

function elapsedText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '不到一分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function renderValue(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return truncate(value, maxChars);
  if (value === undefined) return '(undefined)';
  try {
    return truncate(JSON.stringify(value, null, 2) ?? String(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

function isLink(item: unknown): item is { text: string; url: string } {
  return typeof item === 'object' && item !== null
    && typeof (item as { url?: unknown }).url === 'string';
}

/** 域名 + 标题，给变化那一段用。都不存在时退到 URL 本身。 */
function labelOf(page: SeenPage): string {
  const site = siteOf(page.url);
  const title = page.title.trim();
  if (site && title) return truncate(`${site}「${title}」`, 100);
  return truncate(title || site || page.url, 100);
}

function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(':', '');
  } catch {
    return url.slice(0, 60);
  }
}

/** 没写协议的补 https://：不然浏览器拿到的是相对地址。 */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

function displayBrowser(id: string): string {
  switch (id.trim().toLowerCase()) {
    case 'chrome':
      return 'Chrome';
    case 'edge':
      return 'Edge';
    case 'chromium':
      return 'Chromium';
    default:
      return id.trim();
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…（还有 ${value.length - maxChars} 字没显示）`;
}

function fail(message: string): ToolOutcome {
  return { text: `[browser] ${message}`, failed: true };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
