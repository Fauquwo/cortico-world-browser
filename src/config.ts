import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * config.json 的 worlds.browser 段，默认禁用；bot 或部署可启用。
 *
 * 这一段没有密钥：连的是本机的一个 HTTP 服务（web-access 的 cdp-proxy），
 * 操作的是操作员自己那个浏览器。
 */
export interface BrowserConfigSection {
  enabled: boolean;
  /**
   * 装了 web-access 的那个目录，里面有 `scripts/cdp-proxy.mjs` 与 `scripts/find-url.mjs`。
   * 本 World 从这里拉起 proxy，也从这里找书签历史检索脚本。
   */
  skillDir: string;
  /**
   * 操作哪个浏览器：`chrome` / `edge` / `chromium`。
   * 拉起 proxy 时经 `--browser` 传给它——上游在既没收到这个参数、也没有自己的 config.env 时
   * 不会自己挑浏览器（哪怕只检测到一个），所以这里必须点名。
   */
  browser: string;
  /**
   * proxy 的监听端口，与上游的 `CDP_PROXY_PORT` 对应。
   *
   * 默认 3517：上游默认的 3456 落在 Windows 保留的端口段里（这台机器上是 3417–3516），
   * 绑上去会以 EACCES 失败，上游却把这种情况报成「端口已被占用」。
   */
  port: number;
  /** 拉起 proxy 之后，等它连上浏览器的上限。 */
  readyTimeoutMs: number;
  /** 单次 HTTP 调用的往返超时。 */
  requestTimeoutMs: number;
  /** 本 World 拉起的那个 proxy 里，页面闲置多久被自动关掉（上游默认 15 分钟）。 */
  tabIdleMinutes: number;
  /**
   * 给她一个**专属的浏览器实例**（独立 profile、独立调试端口），由本 World 起停。
   *
   * 关着时行为不变：操作员日常那个浏览器，带他所有登录态。开着时她的页面活在她自己的
   * Chrome 里，`bringToFront` 就可以放心把她自己的窗口带上来。代价是登录态不共享：
   * 要用的站点得在这个 profile 里登一次。
   */
  ownBrowser: boolean;
  /** `ownBrowser` 开着时必填：浏览器可执行文件（一般是 chrome.exe 的绝对路径）。 */
  ownBrowserExe: string;
  /**
   * `ownBrowser` 开着时必填：她的浏览器"家"目录。profile 落在
   * `<home>/Google/Chrome/User Data`（照 Chrome 自己的布局，上游据此发现它），
   * 发现文件也写在那里。
   */
  ownBrowserHome: string;
  /** 这个实例的 CDP 调试端口。别和操作员那个浏览器的撞（Edge 常用 9222）。 */
  ownBrowserPort: number;
  /**
   * 开页/导航之后把那个 tab 调到前台。
   *
   * 为什么需要（2026-10-01 量到的）：隐藏 tab 里媒体**加载不起来**——页面调了 `play()`，
   * `readyState` 一直停在 0、`currentTime` 不动，闲置几分钟后整个 tab 还被冻结；
   * `Target.activateTarget` 之后同一句 `play()` 立刻走完、`readyState: 4`、时间开始走。
   * 所以这是"她能播视频"的开关。关着时她的页面永远在后台，只有静态读页能用。
   */
  bringToFront: boolean;
}

export const BROWSER_DEFAULTS: BrowserConfigSection = {
  enabled: false,
  skillDir: '',
  browser: '',
  port: 3517,
  readyTimeoutMs: 30000,
  requestTimeoutMs: 30000,
  tabIdleMinutes: 15,
  ownBrowser: false,
  ownBrowserExe: '',
  ownBrowserHome: '',
  ownBrowserPort: 9223,
  bringToFront: true,
};

/** World 配置的 JSON Schema 声明。 */
export const BROWSER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:browser',
  owner: 'world:browser',
  schema: {
    type: 'object',
    title: 'Browser',
    properties: {
      'worlds.browser.skillDir': {
        type: 'string',
        title: 'web-access 目录',
        description: '里面有 scripts/cdp-proxy.mjs，例如 F:\\ai\\web-access。必填。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.browser': {
        type: 'string',
        title: '浏览器',
        description: 'chrome / edge / chromium。必须是你要操作的那一个。改完要重启这个 World 才生效。',
        enum: ['chrome', 'edge', 'chromium'],
        'x-hot': false,
      },
      'worlds.browser.port': {
        type: 'integer',
        title: 'proxy 端口',
        description: '与上游 cdp-proxy 的监听端口一致，默认 3517（3456 在 Windows 保留段里，绑不上）。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.readyTimeoutMs': {
        type: 'integer',
        title: '就绪超时（毫秒）',
        description: '拉起 proxy 后等它连上浏览器的上限，默认 30000。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.requestTimeoutMs': {
        type: 'integer',
        title: '调用超时（毫秒）',
        description: '单次 HTTP 调用的往返超时，默认 30000。慢站点上读整页可能不够用，可以调大。',
      },
      'worlds.browser.tabIdleMinutes': {
        type: 'integer',
        title: '闲置关页（分钟）',
        description: '本 World 拉起的 proxy 里，页面闲置这么久被自动关掉，默认 15。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.ownBrowser': {
        type: 'boolean',
        title: '用她自己的浏览器实例',
        description:
          '开着时本 World 会拉起一个专属 Chrome（独立 profile 与调试端口），不再借操作员日常那个。' +
          '想让她放视频、并且不打扰操作员自己的浏览器时开着。代价：登录态不共享。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.ownBrowserExe': {
        type: 'string',
        title: '她的浏览器程序',
        description: 'chrome.exe 的绝对路径，例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe。开了上一项就必填。改完要重启。',
        'x-hot': false,
      },
      'worlds.browser.ownBrowserHome': {
        type: 'string',
        title: '她的浏览器"家"目录',
        description:
          'profile 放在这个目录下的 Google\\Chrome\\User Data，上游据此发现它。' +
          '建议放工作区内的一个目录，例如 <工作区>\\state\\browser-home。改完要重启。',
        'x-hot': false,
      },
      'worlds.browser.ownBrowserPort': {
        type: 'integer',
        title: '她的浏览器调试端口',
        description: '这个专属实例的 CDP 端口，默认 9223（别和操作员那个浏览器的 9222 撞）。改完要重启。',
        'x-hot': false,
      },
      'worlds.browser.bringToFront': {
        type: 'boolean',
        title: '开页后调到前台',
        description:
          '开页/导航之后把那个 tab 调到前台，默认开。媒体播放需要它是前台 tab（后台 tab 里媒体加载不起来，' +
          '2026-10-01 实测），所以除非你确定她只读静态页面，否则别关。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
    },
  },
};
