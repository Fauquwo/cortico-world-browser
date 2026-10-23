/**
 * 浏览器调试口发现：按 `worlds.browser.browser` 点名的那个浏览器，读它的
 * `DevToolsActivePort` 文件拿调试端口。
 *
 * 这份是**严格匹配**：点名的浏览器没发现就硬错，绝不换一个、也不扫回落端口。
 * 原因有二：(1) 上游 web-access 只在「没点名浏览器」时才扫 9222/9229/9333，本 World
 * 永远点名，回落只会带来连错对象的风险；(2) 借的是操作员日常那个浏览器，连错了就是在
 * 他不知情的时候动他的东西。
 *
 * `DevToolsActivePort` 由浏览器在「允许远程调试」开关打开时写在**用户数据根目录**（不是
 * 每个 profile 一份）：第一行是端口，第二行是浏览器级 WebSocket 路径。真正的 WebSocket
 * 地址以 `/json/version` 的回执为准（那个路径每次启动都会变）。
 */
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/** 发现结果。`browser` 是给人看的名字（Chrome / Microsoft Edge / Chromium）。 */
export interface DebugPortDiscovery {
  port: number;
  /**
   * 发现文件第二行的浏览器级 WebSocket 路径（`/devtools/browser/<uuid>`）。
   * 有些浏览器对新式开关只留 WebSocket 这一个口，HTTP 发现端点（`/json/*`）不应答——
   * 这时候就用它直连（与上游 web-access 同一条退路）。
   */
  wsPath: string | null;
  browser: string;
}

interface KnownBrowser {
  id: string;
  label: string;
  /** `DevToolsActivePort` 文件的完整路径。 */
  devToolsPath: string;
}

/** 各平台上开过调试开关的浏览器与它们的发现文件位置。加新浏览器：只改这里。 */
export function knownBrowsers(): KnownBrowser[] {
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (platform()) {
    case 'darwin':
      return [
        { id: 'chrome', label: 'Chrome', devToolsPath: join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium', devToolsPath: join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
        { id: 'edge', label: 'Microsoft Edge', devToolsPath: join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
      ];
    case 'linux':
      return [
        { id: 'chrome', label: 'Chrome', devToolsPath: join(home, '.config/google-chrome/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium', devToolsPath: join(home, '.config/chromium/DevToolsActivePort') },
        { id: 'edge', label: 'Microsoft Edge', devToolsPath: join(home, '.config/microsoft-edge/DevToolsActivePort') },
      ];
    case 'win32':
      return [
        { id: 'chrome', label: 'Chrome', devToolsPath: join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium', devToolsPath: join(localAppData, 'Chromium', 'User Data', 'DevToolsActivePort') },
        { id: 'edge', label: 'Microsoft Edge', devToolsPath: join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort') },
      ];
    default:
      return [];
  }
}

/**
 * 借操作员的浏览器时发现调试口。找不到就抛错——错误正文会带上「远程调试」四个字，
 * 错误分类靠它认出「这一类要去开开关」。
 */
export async function discoverToggledBrowser(browserId: string): Promise<DebugPortDiscovery> {
  const id = browserId.trim().toLowerCase();
  const browser = knownBrowsers().find((item) => item.id === id);
  if (!browser) {
    throw new Error(
      `worlds.browser.browser 是「${browserId}」，不认识。只能是 chrome / edge / chromium 之一。`,
    );
  }
  const found = await readToggledPort(browser);
  if (found !== null) return { port: found.port, wsPath: found.wsPath, browser: browser.label };
  throw new Error(
    `没有发现开着远程调试的 ${browser.label}（找了 ${browser.devToolsPath}）。` +
      `先打开${browser.label}，在地址栏进 ${id}://inspect#remote-debugging，` +
      '勾选「Allow remote debugging for this browser instance」，然后重试。',
  );
}

/** 她的专属实例：端口是我们自己定的，不发现、直接用。名字由 `/json/version` 补上。 */
export async function discoverFixedPort(port: number): Promise<DebugPortDiscovery> {
  return { port, wsPath: null, browser: '' };
}

/** 读发现文件并确认端口活着；任何一步不成立都返回 null（浏览器没开或开关没打开）。 */
async function readToggledPort(browser: KnownBrowser): Promise<{ port: number; wsPath: string | null } | null> {
  let content: string;
  try {
    content = await readFile(browser.devToolsPath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  const port = Number.parseInt(lines[0] ?? '', 10);
  if (!(port > 0 && port < 65536)) return null;
  if (!(await tcpAlive(port))) return null;
  const wsPath = typeof lines[1] === 'string' && lines[1].startsWith('/') ? lines[1] : null;
  return { port, wsPath };
}

/**
 * TCP 探活。用 TCP connect 而不是直接开 WebSocket：后者会触发浏览器的远程调试授权弹窗，
 * 探活不该有副作用（与上游同一口径）。
 */
function tcpAlive(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}
