/**
 * 假的浏览器调试口：一个真的会说 CDP 的服务，给引擎当靶子。
 *
 * 它有两个面，都在同一个端口上——与真浏览器一致：
 * - HTTP：`/json/version`（探活与拿 WebSocket 地址）；
 * - WebSocket：浏览器级 CDP 端点，按 flatten 协议分发命令（会话 id 在消息顶层）。
 *
 * WebSocket 服务端是按 RFC 6455 手写的最小实现（握手、掩码、文本帧、ping/close），
 * 不引依赖——包的测试依赖保持零新增。只支持我们用到的 CDP 方法；用例通过 `controls`
 * 改它的行为（页面表、求值回什么、导航拖多久、建窗口失败……）。
 */
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakePage {
  targetId: string;
  url: string;
  title: string;
}

export interface FakeBrowserControls {
  /** 浏览器里此刻开着的页面（含操作员"他自己"开的）。 */
  pages: FakePage[];
  /** 包装过的求值表达式（模型给的那路）回什么：`{ ok, value }` 或 `{ ok: false, error }`。 */
  evalReply: (expression: string) => unknown;
  /** 设了就让包装过的求值以 `exceptionDetails` 回这个正文（语法错误的现场）。 */
  evalExceptionText: string | null;
  /** 让 `Page.navigate` 先拖这么久——验导航用的是更宽的超时。 */
  navDelayMs: number;
  /** 设了就让 `Page.navigate` 以这个正文回 CDP 错误（站点打不开的现场）。 */
  navError: string | null;
  /** 设了就让一次点击顺手开出一张新页面（`target=_blank` 链接的现场）。 */
  clickOpens: { url: string; title: string } | null;
  /** 让 `Target.createTarget {newWindow:true}` 失败——"建不成窗口退回后台 tab"的现场。 */
  createWindowFails: boolean;
  /** HTTP 还活着但 WebSocket 一律拒绝——"开关开了但连不上"的现场。 */
  wsDead: boolean;
  /** `/json/version` 一律 404（新式开关只留 WebSocket 口的浏览器形状）。 */
  versionEndpointDead: boolean;
  versionBrowser: string;
  // ——— 记录 ———
  /** 非窗口的建页请求收到的 URL（我们只该发 `about:blank`：建页与导航是两步）。 */
  createBodies: string[];
  /** 建窗口请求的次数（不管成没成）。 */
  windowCreateAttempts: number;
  navBodies: string[];
  evalBodies: string[];
  /** 点击记录：'js' 或 'native'。 */
  clicks: string[];
  uploads: Array<{ selector: string; count: number }>;
  /** 真实鼠标事件的次数。 */
  dispatches: number;
  /** 端口防探测（Fetch.enable）装了几次。 */
  guards: number;
  closed: string[];
  backs: number;
}

export interface FakeBrowser {
  port: number;
  controls: FakeBrowserControls;
  server: Server;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export async function fakeBrowser(): Promise<FakeBrowser> {
  let seq = 0;
  let sessionSeq = 0;
  /** sessionId → targetId：会话级的求值要知道自己在哪个页面上。 */
  const sessions = new Map<string, string>();

  const controls: FakeBrowserControls = {
    pages: [],
    evalReply: () => ({ ok: true, value: null }),
    evalExceptionText: null,
    navDelayMs: 0,
    navError: null,
    clickOpens: null,
    createWindowFails: false,
    wsDead: false,
    versionEndpointDead: false,
    versionBrowser: 'Chrome/138.0.0.0',
    createBodies: [],
    windowCreateAttempts: 0,
    navBodies: [],
    evalBodies: [],
    clicks: [],
    uploads: [],
    dispatches: 0,
    guards: 0,
    closed: [],
    backs: 0,
  };

  const pageOf = (sessionId?: string): FakePage | undefined => {
    const targetId = sessionId ? sessions.get(sessionId) : undefined;
    return controls.pages.find((page) => page.targetId === targetId);
  };

  const dispatch = async (msg: CdpMessage): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    const method = msg.method ?? '';
    const params = msg.params ?? {};
    switch (method) {
      // ——— 浏览器级 ———
      case 'Target.getTargets':
        return { result: { targetInfos: controls.pages.map((page) => ({ ...page, type: 'page' })) } };
      case 'Target.createTarget': {
        const url = typeof params.url === 'string' ? params.url : 'about:blank';
        if (params.newWindow === true) {
          controls.windowCreateAttempts += 1;
          if (controls.createWindowFails) {
            return { error: { code: -32000, message: '无法新建窗口' } };
          }
        } else {
          controls.createBodies.push(url);
        }
        seq += 1;
        const targetId = `T${seq}`;
        controls.pages.push({ targetId, url, title: params.newWindow === true ? `窗口页${seq}` : `页面${seq}` });
        return { result: { targetId } };
      }
      case 'Target.closeTarget': {
        const targetId = String(params.targetId ?? '');
        controls.closed.push(targetId);
        controls.pages = controls.pages.filter((page) => page.targetId !== targetId);
        return { result: {} };
      }
      case 'Target.attachToTarget': {
        const targetId = String(params.targetId ?? '');
        const page = controls.pages.find((item) => item.targetId === targetId);
        if (!page) return { error: { code: -32001, message: 'No target with given id' } };
        sessionSeq += 1;
        const sessionId = `S${sessionSeq}`;
        sessions.set(sessionId, targetId);
        return { result: { sessionId } };
      }
      case 'Target.activateTarget':
      case 'Browser.setWindowBounds':
        return { result: {} };
      case 'Browser.getWindowForTarget':
        // 都说自己在屏幕外：parkWindows 那一步就会把窗口当作"已经归位"而不动它。
        return { result: { windowId: 1, bounds: { left: -32000, top: -32000, windowState: 'normal' } } };
      case 'Browser.getWindowBounds':
        return { result: { bounds: { left: 90, top: 70, width: 1100, height: 800 } } };
      case 'Target.getTargetInfo': {
        const targetId = String(params.targetId ?? '');
        const page = controls.pages.find((item) => item.targetId === targetId);
        return { result: { targetInfo: { title: page?.title ?? '' } } };
      }
      case 'SystemInfo.getProcessInfo':
        return { result: { processInfo: [{ type: 'browser', id: 4242 }] } };
      // ——— 会话级 ———
      case 'Page.enable':
        return { result: {} };
      case 'Page.captureScreenshot':
        return { result: { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') } };
      case 'Page.navigate': {
        const url = String(params.url ?? '');
        controls.navBodies.push(url);
        if (controls.navDelayMs > 0) await sleep(controls.navDelayMs);
        if (controls.navError) return { error: { code: -32000, message: controls.navError } };
        const page = pageOf(msg.sessionId);
        if (page) page.url = url;
        return { result: { frameId: 'frame-1' } };
      }
      case 'Runtime.evaluate': {
        const expression = String(params.expression ?? '');
        controls.evalBodies.push(expression);
        if (controls.evalExceptionText && expression.startsWith('(async () => {')) {
          // 包装器自己编译不过（语法错）时 CDP 的形状：exceptionDetails 与 RemoteObject 同级。
          return { result: { result: { type: 'object' }, exceptionDetails: { text: controls.evalExceptionText } } };
        }
        // 真 CDP 的形状：RemoteObject 挂在 result.result。
        return { result: { result: { type: 'object', value: evaluate(expression, msg.sessionId) } } };
      }
      case 'DOM.enable':
        return { result: {} };
      case 'DOM.getDocument':
        return { result: { root: { nodeId: 1 } } };
      case 'DOM.querySelector': {
        const selector = String(params.selector ?? '');
        if (selector.includes('没有这个')) return { result: { node: { nodeId: 0 } } };
        return { result: { node: { nodeId: 2 } } };
      }
      case 'DOM.setFileInputFiles': {
        const files = Array.isArray(params.files) ? params.files : [];
        controls.uploads.push({ selector: '', count: files.length });
        return { result: {} };
      }
      case 'Input.dispatchMouseEvent':
        controls.dispatches += 1;
        return { result: {} };
      case 'Fetch.enable':
        controls.guards += 1;
        return { result: {} };
      case 'Fetch.failRequest':
        return { result: {} };
      default:
        return { error: { code: -32601, message: `未知方法 ${method}` } };
    }
  };

  /** 会话里那句求值该回什么：按表达式的形状认。 */
  const evaluate = (expression: string, sessionId?: string): unknown => {
    const page = pageOf(sessionId);
    if (expression.startsWith('(async () => {')) return controls.evalReply(expression);
    if (expression.includes('title: document.title')) {
      return JSON.stringify({ title: page?.title ?? '', url: page?.url ?? '', ready: 'complete' });
    }
    if (expression.includes('ready: document.readyState')) {
      return JSON.stringify({ ready: 'complete', url: page?.url ?? 'about:blank' });
    }
    if (expression.includes('document.visibilityState')) return 'visible';
    if (expression.includes('getBoundingClientRect')) {
      if (controls.clickOpens) {
        seq += 1;
        controls.pages.push({ targetId: `T${seq}`, url: controls.clickOpens.url, title: controls.clickOpens.title });
      }
      return { x: 10, y: 20, tag: 'A', text: '提交' };
    }
    if (expression.includes('document.querySelector')) {
      if (controls.clickOpens) {
        seq += 1;
        controls.pages.push({ targetId: `T${seq}`, url: controls.clickOpens.url, title: controls.clickOpens.title });
      }
      controls.clicks.push('js');
      return { clicked: true, tag: 'BUTTON', text: '提交' };
    }
    if (expression.includes('window.scrollTo(0, 0)')) return 'scrolled to top';
    if (expression.includes('document.body.scrollHeight')) return 'scrolled to bottom';
    if (expression.includes('window.scrollBy')) {
      const up = expression.includes('scrollBy(0, -');
      const px = /scrollBy\(0, -?(\d+)\)/.exec(expression)?.[1] ?? '3000';
      controls.clicks.push(up ? 'up' : 'down');
      return up ? `scrolled up ${px}px` : `scrolled down ${px}px`;
    }
    if (expression.includes('history.back()')) {
      controls.backs += 1;
      return null;
    }
    return null;
  };

  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/json/version')) {
      if (controls.versionEndpointDead) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end();
        return;
      }
      if (controls.versionEndpointDead) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end();
        return;
      }
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Browser: controls.versionBrowser,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE-UUID`,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (controls.wsDead) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    let assembled: Buffer | null = null; // 分片消息的拼装区
    const sendText = (text: string): void => {
      const payload = Buffer.from(text, 'utf8');
      const header = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, payload]));
    };
    const reply = (msg: CdpMessage): void => {
      void (async () => {
        if (typeof msg.id !== 'number') return;
        const outcome = await dispatch(msg).catch((err: unknown): { result?: unknown; error?: { code: number; message: string } } => ({
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }));
        const body: Record<string, unknown> = { id: msg.id };
        if (outcome.error) body.error = outcome.error;
        else body.result = outcome.result ?? {};
        sendText(JSON.stringify(body));
      })();
    };
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (maskKey) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) {
          // close：回一个 close 帧再断。
          socket.write(Buffer.from([0x88, 0x00]));
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          socket.write(pong);
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          if (!fin) {
            assembled = assembled === null ? payload : Buffer.concat([assembled, payload]);
            continue;
          }
          const text = (assembled === null ? payload : Buffer.concat([assembled, payload])).toString('utf8');
          assembled = null;
          try {
            reply(JSON.parse(text) as CdpMessage);
          } catch {
            // 不是 JSON 的帧不理
          }
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await listenForHttp(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    controls,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Windows 可能分到一个 fetch 都不肯碰的临时端口，换一个重来。 */
export async function listenForHttp(server: Server): Promise<void> {
  for (;;) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    if (port >= 1024 && ![2049,3659,4045,5060,5061,6000,6566,10080].includes(port) && !(port >= 6665 && port <= 6699)) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
