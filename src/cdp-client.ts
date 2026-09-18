/**
 * web-access 的 cdp-proxy 的客户端：起停那个子进程，以及全部 HTTP 调用。
 *
 * 这个类只管机械的事——拉起、探活、把请求发出去、把回执拆成人能读的形状。
 * 什么时候用哪个工具、失败了怎么解释，是 World 与 bot 的事。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

/** `/targets` 里我们关心的字段。 */
export interface PageTarget {
  targetId: string;
  url: string;
  title: string;
}

/** `/info` 的回执。 */
export interface PageInfo {
  title: string;
  url: string;
  ready: string;
}

/** `/health` 的回执。`connected` 只是 proxy 侧的 WebSocket 状态，不代表浏览器可达。 */
export interface RelayHealth {
  connected: boolean;
  browserId: string;
  browserLabel: string;
  managedTabs: number;
}

export type EvalResult = { ok: true; value: unknown } | { ok: false; error: string };

/** proxy 明确报的错。`status` 用来区分「参数问题」与「连接问题」。 */
export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export interface CdpRelayOptions {
  /** web-access 目录：`scripts/cdp-proxy.mjs` 在这里。 */
  skillDir: string;
  browser: string;
  port: number;
  tabIdleMinutes: number;
}

const PROBE_TIMEOUT_MS = 2000;

export class CdpRelay {
  private child: ChildProcess | null = null;
  private lastError = '';

  constructor(private readonly opts: CdpRelayOptions) {}

  /** 只在自己 spawn 成功后才赋值；复用的那个 proxy 不动它。 */
  get owned(): boolean {
    return this.child !== null;
  }

  get failure(): string {
    return this.lastError;
  }

  endpoint(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  scriptPath(name: string): string {
    return join(this.opts.skillDir, 'scripts', name);
  }

  // ——— 起停 ———

  /**
   * 探一次 `/health`。返回 null 表示端口上没有 proxy（可能是不通，也可能是别的程序占了）。
   * 探不通不算错：调用方据此决定是复用还是拉起。
   */
  async probe(): Promise<RelayHealth | null> {
    try {
      const res = await fetch(`${this.endpoint()}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        status?: unknown;
        connected?: unknown;
        browser?: { id?: unknown; label?: unknown } | null;
        managedTabs?: unknown;
      };
      if (body.status !== 'ok') return null;
      return {
        connected: body.connected === true,
        browserId: typeof body.browser?.id === 'string' ? body.browser.id : '',
        browserLabel: typeof body.browser?.label === 'string' ? body.browser.label : '',
        managedTabs: typeof body.managedTabs === 'number' ? body.managedTabs : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 浏览器是否真的可达。上游的 `/health` 只报它自己的 WebSocket 状态，也不验证浏览器；
   * 真正证明可达的是 `/targets` 能回一个数组（上游 `check-deps.mjs` 也是这么探的）。
   */
  async reachable(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint()}/targets`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      const body = await res.json();
      return Array.isArray(body);
    } catch {
      return false;
    }
  }

  /**
   * 能不能在这个端口上听。
   *
   * 上游把「端口被系统保留」(EACCES) 和「被别的程序占着」都报成「已被占用」，
   * 这里先说清真正的原因，免得人往错的方向查。
   */
  async checkPort(): Promise<string | null> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', (err: NodeJS.ErrnoException) => {
        resolve(
          err.code === 'EACCES'
            ? `端口 ${this.opts.port} 被系统保留着（EACCES）：Windows 会留出一些端口段，绑不上去。把 worlds.browser.port 换一个。`
            : `端口 ${this.opts.port} 上有别的程序（${err.message}）。换个端口，或先关掉它。`,
        );
      });
      probe.once('listening', () => probe.close(() => resolve(null)));
      probe.listen(this.opts.port, '127.0.0.1');
    });
  }

  /** 拉起 proxy。失败时把原因留在 `failure` 里，返回 false。 */
  spawnProxy(log: Logger): boolean {    const script = this.scriptPath('cdp-proxy.mjs');
    const env = {
      ...process.env,
      CDP_PROXY_PORT: String(this.opts.port),
      CDP_TAB_IDLE_TIMEOUT: String(Math.max(1, Math.round(this.opts.tabIdleMinutes * 60_000))),
    };
    try {
      const child = spawn(process.execPath, [script, '--browser', this.opts.browser], {
        cwd: this.opts.skillDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (chunk: Buffer) => log.debug(`[proxy] ${String(chunk).trimEnd()}`));
      child.stderr?.on('data', (chunk: Buffer) => log.debug(`[proxy] ${String(chunk).trimEnd()}`));
      child.on('error', (err) => {
        this.lastError = `拉不起 proxy：${err.message}`;
        log.error('拉不起 cdp-proxy', err);
      });
      child.on('exit', (code, signal) => {
        if (this.child !== child) return; // 我们自己关的，不算异常
        this.child = null;
        this.lastError = `proxy 进程退出（code=${code ?? '-'} signal=${signal ?? '-'}）`;
        log.warn('cdp-proxy 退出了', { code, signal });
      });
      this.child = child;
      log.info('已拉起 cdp-proxy', { script, port: this.opts.port, browser: this.opts.browser });
      return true;
    } catch (err) {
      this.lastError = `拉不起 proxy：${err instanceof Error ? err.message : String(err)}`;
      log.error('拉不起 cdp-proxy', err);
      return false;
    }
  }

  /** 只关自己拉起的那个进程。 */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners('exit');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killTimer);
  }

  // ——— HTTP ———

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(Math.max(1000, init.timeoutMs));
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.endpoint()}${path}`, {
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
      });
    } catch (err) {
      throw new RelayError(`连不上 cdp-proxy（${this.endpoint()}）：${err instanceof Error ? err.message : String(err)}`, 0);
    }
    if (!res.ok) {
      const detail = await errorText(res);
      throw new RelayError(detail, res.status);
    }
    return res;
  }

  private async json<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (!text.trim()) return undefined as T; // /close 失败时上游会回一个空正文
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RelayError(`cdp-proxy 的回执不是 JSON：${text.slice(0, 200)}`, res.status);
    }
  }

  /** 列出浏览器里的页面。连不上浏览器时抛 RelayError。 */
  async targets(timeoutMs: number, signal?: AbortSignal): Promise<PageTarget[]> {
    const list = await this.json<unknown[]>('/targets', { method: 'GET', timeoutMs, ...(signal ? { signal } : {}) });
    if (!Array.isArray(list)) throw new RelayError('cdp-proxy 的 /targets 没有回一个列表', 0);
    return list
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => item.type === 'page')
      .map((item) => ({
        targetId: typeof item.targetId === 'string' ? item.targetId : '',
        url: typeof item.url === 'string' ? item.url : '',
        title: typeof item.title === 'string' ? item.title : '',
      }))
      .filter((target) => target.targetId !== '');
  }

  /** 新建后台 tab，等它加载完，返回 targetId。 */
  async open(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const body = await this.json<{ targetId?: unknown }>('/new', {
      method: 'POST',
      body: url,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (typeof body?.targetId !== 'string' || !body.targetId) {
      throw new RelayError('cdp-proxy 没有回 targetId', 0);
    }
    return body.targetId;
  }

  async info(target: string, timeoutMs: number, signal?: AbortSignal): Promise<PageInfo> {
    const res = await this.request(`/info?target=${encodeURIComponent(target)}`, {
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { title?: unknown; url?: unknown; ready?: unknown };
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
   * 上游会把异常压成 `exceptionDetails.text`（常见值就是 `Uncaught`），拿不到可读信息，
   * 所以这里自己包一层 try/catch，把异常当值带回来。
   */
  async evaluate(target: string, expression: string, timeoutMs: number, signal?: AbortSignal): Promise<EvalResult> {
    const wrapped = wrapExpression(expression);
    let body: Record<string, unknown>;
    try {
      body = await this.json<Record<string, unknown>>(`/eval?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        body: wrapped,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof RelayError) return { ok: false, error: explainEvalError(err) };
      throw err;
    }
    // 上游把它求到的值放在 `{ value }` 里；值不可序列化时回的是 CDP 的原始结果对象。
    const payload = body && typeof body === 'object' && 'value' in body ? body.value : body;
    if (payload && typeof payload === 'object') {
      const outcome = payload as { ok?: unknown; value?: unknown; error?: unknown };
      if (outcome.ok === true) return { ok: true, value: outcome.value };
      if (outcome.ok === false) {
        return { ok: false, error: typeof outcome.error === 'string' ? outcome.error : '页面里的这段 JS 抛了错' };
      }
    }
    return { ok: true, value: payload };
  }

  async click(
    target: string,
    selector: string,
    native: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ tag: string; text: string }> {
    const path = native ? '/clickAt' : '/click';
    const body = await this.json<{ tag?: unknown; text?: unknown }>(`${path}?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      body: selector,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return {
      tag: typeof body?.tag === 'string' ? body.tag : '',
      text: typeof body?.text === 'string' ? body.text : '',
    };
  }

  async setFiles(
    target: string,
    selector: string,
    files: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const body = await this.json<{ files?: unknown }>(`/setFiles?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      body: JSON.stringify({ selector, files }),
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return typeof body?.files === 'number' ? body.files : files.length;
  }

  async scroll(
    target: string,
    opts: { y?: number; direction?: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const query = new URLSearchParams();
    query.set('target', target);
    if (typeof opts.y === 'number' && Number.isFinite(opts.y)) query.set('y', String(Math.round(opts.y)));
    if (opts.direction) query.set('direction', opts.direction);
    const body = await this.json<{ value?: unknown }>(`/scroll?${query.toString()}`, {
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return typeof body?.value === 'string' ? body.value : '';
  }

  async navigate(target: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.request(`/navigate?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      body: url,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  async back(target: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.request(`/back?target=${encodeURIComponent(target)}`, {
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  async close(target: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.request(`/close?target=${encodeURIComponent(target)}`, {
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  /** 截图。走不带 `file` 的分支：上游直接把 PNG 字节当正文回，绕开文件路径的编码坑。 */
  async screenshot(target: string, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.request(`/screenshot?target=${encodeURIComponent(target)}`, {
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * 跑一次上游的 `find-url.mjs`（本机书签与历史检索）。
 *
 * 它回的是人读的文本，不是 JSON——原样透传，解析它只会把上游的格式变更变成我们的故障。
 * 要 `sqlite3` 命令在 PATH 上才能查历史；缺了的时候它自己的 stderr 会说明。
 */
export async function runFindUrl(
  skillDir: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  const script = join(skillDir, 'scripts', 'find-url.mjs');
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    let err = '';
    const child = spawn(process.execPath, [script, ...args], {
      cwd: skillDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: { ok: boolean; output: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (child.exitCode === null) child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, output: `书签历史检索超时（${timeoutMs} 毫秒）。` }), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += String(chunk);
    });
    child.on('error', (error) => finish({ ok: false, output: `拉不起 find-url.mjs：${error.message}` }));
    child.on('exit', (code) =>
      finish(code === 0 ? { ok: true, output: out } : { ok: false, output: err.trim() || out || `find-url.mjs 退出码 ${code}` }),
    );
  });
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

/** 上游把语法错误也压成一句话，这里补上该怎么办。 */
function explainEvalError(err: RelayError): string {
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

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text.trim()) return `cdp-proxy 返回 ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 不是 JSON 就照原样用
  }
  return text.slice(0, 400);
}
