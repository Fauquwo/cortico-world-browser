/**
 * 进程内的 CDP 引擎：直接对浏览器说话，不再经过任何外部 proxy。
 *
 * 0.4.0 起 web-access 不再是依赖：原先那个 cdp-proxy 子进程做的事（发现浏览器、一条浏览器级
 * WebSocket、按 target 扁平会话、端口防探测、闲置 tab 回收），全部搬进这个类。移植时逐条对照
 * 上游 v2.5.4（eze-is/web-access，MIT）的实现，语义保持一致；THIRD_PARTY_NOTICES 里有说明。
 *
 * 这个类只管机械的事——发现、连接、把命令发出去、把回执拆成人能读的形状。
 * 什么时候用哪个工具、失败了怎么解释，是 World 与 bot 的事。
 */
import type { Logger } from 'cortico/core/types.ts';
import { discoverFixedPort, discoverToggledBrowser, type DebugPortDiscovery } from './browser-discovery.ts';

/** `targets()` 里我们关心的字段。 */
export interface PageTarget {
  targetId: string;
  url: string;
  title: string;
}

/** `info()` 的回执。 */
export interface PageInfo {
  title: string;
  url: string;
  ready: string;
}

export type EvalResult = { ok: true; value: unknown } | { ok: false; error: string };

/** 引擎明确报的错。`status` 用来区分「参数问题」（400）与「连接/命令问题」（其余）。 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** 失败归类。World 拿它决定该说哪句话；这里只认形状，不写文案。 */
export type EngineFailureKind = 'unreachable' | 'not-connected' | 'command-timeout' | 'relay';

/**
 * 把引擎的报错归成几类。
 *
 * 为什么要分类（2026-09-30 那条诊断）：「连不上浏览器」「命令没回话」「浏览器没连上」原先在
 * World 那边都贴同一句「去开远程调试」，于是「站点打不开」被念成「浏览器没连上」——bot 照着自己
 * 手里 `browser_tabs` 列得出 25 个页面这一点，都读出了矛盾。**只有前两类真的与浏览器/开关有关。**
 *
 * 顺序有讲究：`CDP 命令超时` 是引擎自己报的，先按正文认出来，别落进「连接」那一档。
 * 「页面不存在或已关闭」也不算连接问题——读一个已被回收的页面是常见操作，把它归进「去开开关」
 * 会把她往错的方向带（0.4.0 起有意与上游的 `attach 失败` 分开）。
 */
export function classifyEngineError(err: EngineError): EngineFailureKind {
  if (/CDP 命令超时/.test(err.message)) return 'command-timeout';
  if (err.status === 0) return 'unreachable';
  if (/远程调试|WebSocket 未连接|无法获取|attach 失败/i.test(err.message)) return 'not-connected';
  return 'relay';
}

export interface CdpEngineOptions {
  /** 操作哪个浏览器：`chrome` / `edge` / `chromium`。借操作员的浏览器时用于发现。 */
  browser: string;
  /**
   * 配了专属实例时：直接连这个调试端口，跳过发现。
   * 那个实例由 World 起停（`own-browser.ts`），端口是我们自己定的，不需要发现。
   */
  fixedPort?: number;
  /** 页面闲置多久被自动关掉（分钟）。只管本引擎**建出来**的 tab；她的窗口不归这里管。 */
  tabIdleMinutes: number;
}

interface VersionInfo {
  wsUrl: string;
  browser: string;
}

const VERSION_TIMEOUT_MS = 5000;
/** 每条 CDP 命令的兜底超时——上游是固定 30 秒；没有给调用方超时的路径都用它。 */
const COMMAND_TIMEOUT_MS = 30_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;

export class CdpEngine {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (msg: CdpResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  /** targetId → 扁平会话 id。 */
  private readonly sessions = new Map<string, string>();
  /** 已启用端口拦截的会话，避免重复启用。 */
  private readonly guardedSessions = new Set<string>();
  /** 本引擎建出来的页面：targetId → 最后一次用到的时刻。闲置回收与 stop() 只关这些。 */
  private readonly managed = new Map<string, number>();
  private discovery: DebugPortDiscovery | null = null;
  private connecting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly tabIdleMs: number;

  constructor(private readonly opts: CdpEngineOptions) {
    this.tabIdleMs = Math.max(1, Math.round(opts.tabIdleMinutes * 60_000));
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 浏览器的 CDP 端口。连上之后才有；专属实例模式在连上之前就知道。 */
  get browserPort(): number {
    return this.opts.fixedPort ?? this.discovery?.port ?? 0;
  }

  /** `/json/version` 报的浏览器名（例如 `Chrome/138.0.7204.97`），没连上时为空。 */
  get browserLabel(): string {
    return this.discovery?.browser ?? '';
  }

  /** 浏览器自己的 HTTP 调试口（视频模块的 puppeteer 从这里进）。 */
  httpEndpoint(): string {
    return `http://127.0.0.1:${this.browserPort}`;
  }

  // ——— 连接 ———

  /**
   * 确保已连上浏览器：没连上就发现 + 建连。返回 null 表示好了，否则是给人看的原因。
   * 不抛错：起不来要让工具去报失败，而不是这个 World 整个消失。
   *
   * 与上游一致的细节：连接断开时**清掉发现缓存**——浏览器可能被重启到了别的端口，下次重新发现。
   */
  async connect(log: Logger | null, timeoutMs: number): Promise<string | null> {
    if (this.connected) return null;
    if (this.connecting) {
      try {
        await this.connecting;
        return null;
      } catch (err) {
        return describe(err);
      }
    }
    this.connecting = this.establish(log, timeoutMs);
    try {
      await this.connecting;
      return null;
    } catch (err) {
      return describe(err);
    } finally {
      this.connecting = null;
    }
  }

  private async establish(log: Logger | null, timeoutMs: number): Promise<void> {
    // 发现是确定性的：开关没开、文件不在，重试也是同样结果——所以只在「端口活着但没应答」
    // 这个真正瞬时的形状上轮询（浏览器可能正在重启）。发现失败当场报，一次工具调用不被拖住。
    if (!this.discovery) {
      const found = await this.discover();
      this.discovery = found;
      log?.info(
        this.opts.fixedPort ? '连她的专属实例' : '发现浏览器调试口',
        { port: found.port, browser: found.browser },
      );
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let lastProblem = '';
    while (Date.now() < deadline) {
      const discovery = this.discovery;
      // 候选一：`/json/version` 给的地址（完整的 HTTP 发现面）。专属实例走的一直是这条。
      const version = await readVersion(discovery.port);
      if (version) {
        this.discovery = { ...discovery, browser: version.browser };
        try {
          await this.openSocket(version.wsUrl, remaining(deadline));
        } catch (err) {
          this.discovery = null; // ws 地址可能是旧的（浏览器重启过）：作废，下次重新发现
          throw err;
        }
        this.startIdleSweep(log);
        return;
      }
      // 候选二：发现文件里那行 ws 路径直连。有些浏览器对新式开关只留 WebSocket 这一个口，
      // HTTP 发现端点一律不应答——上游 web-access 走的就是这一条（它从不调 /json/version）。
      if (discovery.wsPath) {
        try {
          await this.openSocket(`ws://127.0.0.1:${discovery.port}${discovery.wsPath}`, Math.min(remaining(deadline), 3000));
          log?.info('HTTP 发现端点不应答，改用发现文件里的 ws 路径直连', { port: discovery.port });
          this.startIdleSweep(log);
          return;
        } catch {
          // 两条都不通，走下面的报错
        }
      }
      lastProblem = discovery.wsPath
        ? `发现 ${discovery.browser} 的调试口（端口 ${discovery.port}），但它不应答调试请求：` +
          'HTTP 发现端点与 WebSocket 都不工作。这不是开关没开（发现文件在、端口也在听）——' +
          '常见原因是浏览器还没就绪或有安全软件拦本机调试端口；过一会儿重试，或改用她自己的专属实例（ownBrowser）。'
        : this.opts.fixedPort
          ? `她的浏览器的调试口 ${discovery.port} 没响应`
          : `端口 ${discovery.port} 上的浏览器没应答 /json/version`;
      await sleep(500);
    }
    throw new Error(lastProblem || '连浏览器超时');
  }

  private async discover(): Promise<DebugPortDiscovery> {
    if (this.opts.fixedPort) return discoverFixedPort(this.opts.fixedPort);
    return discoverToggledBrowser(this.opts.browser);
  }

  private openSocket(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        cleanup();
        try { ws.close(); } catch { /* 没开成无所谓 */ }
        reject(new Error(`连不上浏览器的 WebSocket（${timeoutMs} 毫秒没开成）`));
      }, Math.max(1000, timeoutMs));
      const onOpen = () => { cleanup(); this.attachSocket(ws); resolve(); };
      const onError = () => { cleanup(); try { ws.close(); } catch { /* 同上 */ } reject(new Error('连不上浏览器的 WebSocket')); };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  private attachSocket(ws: WebSocket): void {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMessage;
      } catch {
        return;
      }
      if (process.env.CDP_DEBUG) console.error(`[cdp<<] id=${msg.id ?? '-'} method=${msg.method ?? '-'} len=${String(ev.data).length}`);
      if (msg.method === 'Target.attachedToTarget' && msg.params) {
        const targetId = msg.params.targetInfo?.targetId;
        if (typeof msg.params.sessionId === 'string' && typeof targetId === 'string') {
          this.sessions.set(targetId, msg.params.sessionId);
        }
      }
      // 端口防探测：页面想摸调试口，当场拒掉。别的本地服务一概不拦。
      if (msg.method === 'Fetch.requestPaused' && msg.params && msg.sessionId) {
        void this.send(
          'Fetch.failRequest',
          { requestId: msg.params.requestId, errorReason: 'ConnectionRefused' },
          msg.sessionId,
          5000,
        ).catch(() => {});
      }
      if (typeof msg.id === 'number') {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
    ws.addEventListener('close', () => {
      // 浏览器关了或者调试口断了：全部状态作废，下次调用重新发现、重连。
      this.ws = null;
      this.sessions.clear();
      this.guardedSessions.clear();
      this.managed.clear();
      this.discovery = null;
      this.stopIdleSweep();
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch { /* close 自己会走上面的分支 */ }
    });
  }

  // ——— 命令 ———

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CdpResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new EngineError('WebSocket 未连接（浏览器没连上或刚断开）', 500));
    }
    const id = ++this.seq;
    return new Promise<CdpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`CDP 命令超时: ${method}`, 500));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.error) {
            reject(new EngineError(`${method} -> ${JSON.stringify(msg.error)}`, 500));
          } else {
            resolve((msg.result ?? {}) as CdpResult);
          }
        },
        reject,
        timer,
      });
      const wire = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
      if (process.env.CDP_DEBUG) console.error(`[cdp>>] id=${id} method=${method}`);
      ws.send(wire);
    });
  }

  /** 拿到一个 target 的扁平会话；顺手把端口防探测装上。 */
  private async session(targetId: string, timeoutMs: number): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    let result: { sessionId?: unknown };
    try {
      result = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined, timeoutMs);
    } catch (err) {
      // 上游把这种错原样抛成 `attach 失败: …`。最常见的两种要分开说：
      // 目标没了是日常（页面被关掉/回收了），连接问题是事故（要去开开关）。
      if (/No target with given id|Not attached/i.test(describe(err))) {
        throw new EngineError(`页面不存在或已关闭（target ${targetId}）。用 browser_tabs 看一眼现在还有哪些页面。`, 500);
      }
      throw new EngineError(`attach 失败: ${describe(err)}`, 500);
    }
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : '';
    if (!sessionId) throw new EngineError('attach 失败: 没有回 sessionId', 500);
    this.sessions.set(targetId, sessionId);
    await this.enablePortGuard(sessionId);
    return sessionId;
  }

  /** 拦截页面对本浏览器调试口的探测（反风控）。Fetch 域装不上不影响主流程。 */
  private async enablePortGuard(sessionId: string): Promise<void> {
    const port = this.browserPort;
    if (!port || this.guardedSessions.has(sessionId)) return;
    try {
      await this.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: `http://127.0.0.1:${port}/*`, requestStage: 'Request' },
            { urlPattern: `http://localhost:${port}/*`, requestStage: 'Request' },
          ],
        },
        sessionId,
        5000,
      );
      this.guardedSessions.add(sessionId);
    } catch {
      // 装不上就算了
    }
  }

  // ——— 闲置回收与停机 ———

  /** 任何带 target 的调用都记一笔「刚用过」。只管引擎自己建出来的页面。 */
  touch(targetId: string): void {
    if (this.managed.has(targetId)) this.managed.set(targetId, Date.now());
  }

  private startIdleSweep(log: Logger | null): void {
    this.stopIdleSweep();
    this.idleTimer = setInterval(() => {
      void this.sweepIdle(log);
    }, IDLE_SWEEP_INTERVAL_MS);
    this.idleTimer.unref();
  }

  private stopIdleSweep(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** 闲置的页面关掉。与上游一样：60 秒一扫，只关自己建出来的那批，关不掉的下次再试。 */
  private async sweepIdle(log: Logger | null): Promise<void> {
    if (!this.connected) return;
    const now = Date.now();
    for (const [targetId, usedAt] of [...this.managed]) {
      if (now - usedAt < this.tabIdleMs) continue;
      this.managed.delete(targetId);
      this.sessions.delete(targetId);
      try {
        await this.send('Target.closeTarget', { targetId });
        log?.info('闲置的页面被自动关掉', { targetId });
      } catch {
        // 页面可能已经没了
      }
    }
  }

  /**
   * 停机：把本引擎建出来的页面关掉（与上游 proxy 退出时的行为一致），然后断开 WebSocket。
   * 她的窗口（`createWindow` 建的）与操作员自己的页面**都不在** `managed` 里，不受影响。
   */
  async stop(): Promise<void> {
    this.stopIdleSweep();
    const ws = this.ws;
    if (ws) {
      const targets = [...this.managed.keys()];
      for (const targetId of targets) {
        try {
          await this.send('Target.closeTarget', { targetId }, undefined, 1000);
        } catch {
          // 关不掉就算了
        }
      }
      this.managed.clear();
    }
    const closing = ws ? new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true })) : null;
    try { ws?.close(); } catch { /* 已经关了 */ }
    await closing;
    this.ws = null;
    this.sessions.clear();
    this.guardedSessions.clear();
    this.discovery = null;
  }

  // ——— 工具用的那组调用 ———

  /** 列出浏览器里的页面。连不上浏览器时抛 EngineError。 */
  async targets(timeoutMs: number): Promise<PageTarget[]> {
    await this.ensureConnected(timeoutMs);
    const result = await this.send('Target.getTargets', {}, undefined, timeoutMs);
    const infos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    return infos
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => item.type === 'page')
      .map((item) => ({
        targetId: typeof item.targetId === 'string' ? item.targetId : '',
        url: typeof item.url === 'string' ? item.url : '',
        title: typeof item.title === 'string' ? item.title : '',
      }))
      .filter((target) => target.targetId !== '');
  }

  /**
   * 新建一个**空白**后台 tab，返回 targetId。
   *
   * 调用方（world.ts）拆成「建页 → 导航」两步、拿到 id 先认下来，防孤儿页面——这条契约从
   * proxy 时代原样保留。这里只负责建页与登记。
   */
  async openBlank(timeoutMs: number): Promise<string> {
    await this.ensureConnected(timeoutMs);
    const result = await this.send('Target.createTarget', { url: 'about:blank', background: true }, undefined, timeoutMs);
    const targetId = typeof result.targetId === 'string' ? result.targetId : '';
    if (!targetId) throw new EngineError('建页面没拿到 targetId', 500);
    this.managed.set(targetId, Date.now());
    return targetId;
  }

  async info(target: string, timeoutMs: number): Promise<PageInfo> {
    const sessionId = await this.session(target, timeoutMs);
    const result = await this.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})', returnByValue: true },
      sessionId,
      timeoutMs,
    );
    const raw = result.result?.value;
    try {
      const parsed = JSON.parse(String(raw ?? '')) as { title?: unknown; url?: unknown; ready?: unknown };
      return {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        url: typeof parsed.url === 'string' ? parsed.url : '',
        ready: typeof parsed.ready === 'string' ? parsed.ready : '',
      };
    } catch {
      return { title: '', url: '', ready: '' };
    }
  }

  /**
   * 在页面里求值。
   *
   * 异常当值带回来（`wrapExpression` 在页面里接住），所以 `exceptionDetails` 只剩语法错误一种——
   * 与上游 `/eval` 的回执形状一致。
   */
  async evaluate(target: string, expression: string, timeoutMs: number): Promise<EvalResult> {
    const sessionId = await this.session(target, timeoutMs);
    let result: CdpResult;
    try {
      result = await this.send(
        'Runtime.evaluate',
        { expression: wrapExpression(expression), returnByValue: true, awaitPromise: true },
        sessionId,
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof EngineError) return { ok: false, error: explainEvalError(err) };
      throw err;
    }
    const details = result.exceptionDetails;
    if (details) {
      // 包装器自己编译不过（几乎总是模型给的表达式有语法错）才会走到这里——
      // 给的话与「页面里抛错」不同：要告诉它这里只收表达式。
      const text = typeof details.text === 'string' ? details.text : '页面里的这段 JS 抛了错';
      return { ok: false, error: explainEvalError(new EngineError(text, 400)) };
    }
    const payload = result.result?.value;
    if (payload && typeof payload === 'object') {
      const outcome = payload as { ok?: unknown; value?: unknown; error?: unknown };
      if (outcome.ok === true) return { ok: true, value: outcome.value };
      if (outcome.ok === false) {
        return { ok: false, error: typeof outcome.error === 'string' ? outcome.error : '页面里的这段 JS 抛了错' };
      }
    }
    return { ok: true, value: payload };
  }

  async click(target: string, selector: string, native: boolean, timeoutMs: number): Promise<{ tag: string; text: string }> {
    const sessionId = await this.session(target, timeoutMs);
    if (!native) {
      // JS 层面点击：简单快速，覆盖大多数场景。
      const selectorJson = JSON.stringify(selector);
      const result = await this.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`,
          returnByValue: true,
          awaitPromise: true,
        },
        sessionId,
        timeoutMs,
      );
      const value = result.result?.value as { tag?: unknown; text?: unknown; error?: unknown } | undefined;
      if (!value || value.error) {
        throw new EngineError(typeof value?.error === 'string' ? value.error : '页面上没有这个元素', 400);
      }
      return { tag: typeof value.tag === 'string' ? value.tag : '', text: typeof value.text === 'string' ? value.text : '' };
    }
    // 真鼠标：先量出元素中心，再发一对浏览器级鼠标事件。算用户手势，能触发文件对话框、
    // 绕过反自动化检测；`target=_blank` 的链接只有它能开出新页面。
    const selectorJson = JSON.stringify(selector);
    const coordResult = await this.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeoutMs,
    );
    const coord = coordResult.result?.value as { x?: unknown; y?: unknown; tag?: unknown; text?: unknown; error?: unknown } | undefined;
    if (!coord || coord.error || typeof coord.x !== 'number' || typeof coord.y !== 'number') {
      throw new EngineError(typeof coord?.error === 'string' ? coord.error : '量不出元素的位置', 400);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1 }, sessionId, timeoutMs);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1 }, sessionId, timeoutMs);
    return {
      tag: typeof coord.tag === 'string' ? coord.tag : '',
      text: typeof coord.text === 'string' ? coord.text : '',
    };
  }

  async setFiles(target: string, selector: string, files: readonly string[], timeoutMs: number): Promise<number> {
    const sessionId = await this.session(target, timeoutMs);
    await this.send('DOM.enable', {}, sessionId, timeoutMs);
    const doc = await this.send('DOM.getDocument', {}, sessionId, timeoutMs);
    const root = (doc.root as { nodeId?: unknown } | undefined)?.nodeId;
    if (typeof root !== 'number') throw new EngineError('拿不到页面的 DOM 根', 500);
    const node = await this.send('DOM.querySelector', { nodeId: root, selector }, sessionId, timeoutMs);
    const nodeId = (node.node as { nodeId?: unknown } | undefined)?.nodeId;
    if (typeof nodeId !== 'number' || nodeId === 0) {
      throw new EngineError(`未找到元素: ${selector}`, 400);
    }
    await this.send('DOM.setFileInputFiles', { nodeId, files: [...files] }, sessionId, timeoutMs);
    return files.length;
  }

  async scroll(target: string, opts: { y?: number; direction?: string }, timeoutMs: number): Promise<string> {
    const sessionId = await this.session(target, timeoutMs);
    const y = typeof opts.y === 'number' && Number.isFinite(opts.y) ? Math.round(Math.abs(opts.y)) : 3000;
    let js: string;
    switch (opts.direction) {
      case 'top':
        js = 'window.scrollTo(0, 0); "scrolled to top"';
        break;
      case 'bottom':
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
        break;
      case 'up':
        js = `window.scrollBy(0, -${y}); "scrolled up ${y}px"`;
        break;
      default:
        js = `window.scrollBy(0, ${y}); "scrolled down ${y}px"`;
        break;
    }
    const result = await this.send('Runtime.evaluate', { expression: js, returnByValue: true }, sessionId, timeoutMs);
    // 等懒加载触发——与上游同样的固定等待。
    await sleep(800);
    return typeof result.result?.value === 'string' ? result.result.value : '';
  }

  /**
   * 导航并等加载。
   *
   * 两个与上游一致的口径：
   * - `Page.navigate` 的 `errorText`（DNS 解析失败之类）**不抛错**——上游也没看它；
   *   页面打没打开由回执里的 title/url/ready 说话。
   * - 等加载是每 500ms 轮询 `readyState`，15 秒预算，**超时不算失败**（上游如此）；
   *   真正报错的是命令本身没回话或页面没了。
   */
  async navigate(target: string, url: string, timeoutMs: number): Promise<void> {
    const sessionId = await this.session(target, timeoutMs);
    await this.send('Page.navigate', { url }, sessionId, timeoutMs);
    await this.waitForLoad(sessionId, timeoutMs);
  }

  async back(target: string, timeoutMs: number): Promise<void> {
    const sessionId = await this.session(target, timeoutMs);
    await this.send('Runtime.evaluate', { expression: 'history.back()' }, sessionId, timeoutMs);
    await this.waitForLoad(sessionId, timeoutMs);
  }

  async close(target: string, timeoutMs: number): Promise<void> {
    await this.ensureConnected(timeoutMs);
    await this.send('Target.closeTarget', { targetId: target }, undefined, timeoutMs);
    this.sessions.delete(target);
    this.managed.delete(target);
  }

  /** 截图。回原始 PNG 字节，绕开文件路径的编码坑。 */
  async screenshot(target: string, timeoutMs: number): Promise<Uint8Array> {
    const sessionId = await this.session(target, timeoutMs);
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId, timeoutMs);
    if (typeof result.data !== 'string') throw new EngineError('截图没有回数据', 500);
    return new Uint8Array(Buffer.from(result.data, 'base64'));
  }

  // ——— 内部 ———

  private async ensureConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return;
    const problem = await this.connect(null, Math.min(timeoutMs, 8000));
    if (problem) throw new EngineError(problem, 0);
  }

  /**
   * 等页面加载：每 500ms 轮询一次 `readyState`。
   *
   * 为什么不用 `Page.loadEventFired`：上游就是轮询的——事件版会被 SPA 的软导航、错误页的重定向
   * 这些形状坑到，轮询口径虽笨但见到的就是页面自己说的状态。预算用完**不算失败**。
   */
  private async waitForLoad(sessionId: string, timeoutMs: number): Promise<void> {
    await this.send('Page.enable', {}, sessionId, 5000).catch(() => {});
    const budget = Math.min(15_000, Math.max(3000, timeoutMs));
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      try {
        const result = await this.send(
          'Runtime.evaluate',
          { expression: 'JSON.stringify({ ready: document.readyState, url: location.href })', returnByValue: true },
          sessionId,
          Math.min(10_000, COMMAND_TIMEOUT_MS),
        );
        const raw = result.result?.value;
        const state = typeof raw === 'string' ? (JSON.parse(raw) as { ready?: unknown; url?: unknown }) : null;
        if (state?.ready === 'complete') return;
      } catch {
        // 这一次没问到就算了：页面可能正卡着，下一轮再试
      }
      await sleep(500);
    }
  }
}

// ——— 模块级小工具 ———

/**
 * 把模型给的表达式包成「异常也当值」的异步求值。
 *
 * 用 `eval` 的写法在开了 CSP 的站点上会被 `unsafe-eval` 拦掉，所以这里是把源码原样拼进来的；
 * 代价是只收表达式（`SKILL.md` 的约定本来也是表达式）。要跑多行语句时，让模型自己包成
 * `(async () => { ... })()` 并在里面 return。
 */
export function wrapExpression(expression: string): string {
  return [
    '(async () => {',
    '  try {',
    `    const __v = await (${expression});`,
    '    return { ok: true, value: (() => {',
    '      const v = __v;',
    '      if (v === null || v === undefined) return v;',
    '      const t = typeof v;',
    '      if (t === "string" || t === "number" || t === "boolean") return v;',
    '      if (t === "function") return "[function " + (v.name || "anonymous") + "]";',
    '      if (v.nodeType && v.nodeName) return "[DOM " + v.nodeName + (v.id ? "#" + v.id : "") + "]";',
    '      try { JSON.stringify(v); return v; } catch (e) { return "[不可序列化的值] " + String(v); }',
    '    })() };',
    '  } catch (err) {',
    '    return { ok: false, error: String((err && err.stack) || err) };',
    '  }',
    '})()',
  ].join('\n');
}

/** 把语法错误也补上该怎么办。 */
function explainEvalError(err: EngineError): string {
  const message = err.message;
  const looksLikeSyntax = err.status === 400 || /Uncaught|SyntaxError|Unexpected/i.test(message);
  if (looksLikeSyntax) {
    return (
      `页面里那段 JS 没能执行（${message}）。` +
      '这里只收表达式；要跑多行语句，自己包成 (async () => { ... })() 并在里面 return 一个值。'
    );
  }
  return `页面里那段 JS 没能执行（${message}）。`;
}

/** 从浏览器自己的 HTTP 口读 `/json/version`。 */
async function readVersion(port: number): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown; Browser?: unknown };
    const wsUrl = typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : '';
    if (!wsUrl) return null;
    return { wsUrl, browser: typeof body.Browser === 'string' ? body.Browser : '' };
  } catch {
    return null;
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: { sessionId?: unknown; requestId?: unknown; targetInfo?: { targetId?: unknown } } & Record<string, unknown>;
  sessionId?: string;
  error?: unknown;
  result?: unknown;
}

type CdpResponse = { id?: number; error?: unknown; result?: unknown };
type CdpResult = Record<string, unknown> & {
  result?: { value?: unknown; type?: unknown };
  exceptionDetails?: { text?: unknown };
  targetInfos?: unknown;
  targetId?: unknown;
  sessionId?: unknown;
  data?: unknown;
  root?: unknown;
  node?: unknown;
};

function remaining(deadline: number): number {
  return Math.max(1000, deadline - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
