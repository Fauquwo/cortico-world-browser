import type { ConfigGroup } from 'cortico/core/types.ts';
import { SEARCH_ENGINE_DEFAULT, type SearchEngineId } from './search.ts';

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
   * 允不允许她**把页面搬到操作员眼前**（`browser_focus`）。
   *
   * 注意这**不是**"页面能不能活/能不能播"的开关：2026-10-01 夜量清楚了，页面在她自己的窗口里
   * 就是可见的、媒体照播，不需要抬窗口也不需要抢焦点。所以她平时干活不碰操作员的屏幕；
   * 这一项管的是"她可不可以打扰他"——关掉之后 `browser_focus` 会拒绝并说清。
   */
  bringToFront: boolean;
  /**
   * `browser_search` 默认用哪个搜索引擎（`bing` / `sogou` / `baidu`）。
   *
   * 2026-10-12 在这台机器上量到：Google 与 DuckDuckGo **打不开**，能用的是这三个。
   * 默认 Bing 国内版，因为只有它把**真地址**给出来（搜狗与百度给的是它们自己的跳转链接，
   * 从地址上看不出是哪个站点）。她调工具时可以用 `engine` 参数临时换一个。
   */
  searchEngine: SearchEngineId;
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
  searchEngine: SEARCH_ENGINE_DEFAULT,
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
        title: '允许她弹到你眼前',
        description:
          '她可不可以把某个页面**搬到你眼前**（browser_focus：窗口搬回屏幕内 + 激活），默认允许。' +
          '注意这不是"页面能不能播"的开关——她的页面平时停在屏幕外，媒体照样播、也不会打扰你；' +
          '这一项只管"她能不能打断你"。关掉之后她调那个工具会被拒绝并说明原因。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.searchEngine': {
        type: 'string',
        title: '搜索用哪个引擎',
        description:
          'browser_search 默认用哪个：bing（国内版，默认）/ sogou / baidu。' +
          '这台机器上 Google 与 DuckDuckGo 打不开，别选它们。' +
          'Bing 给的是真地址；搜狗与百度给的是它们自己的跳转链接（打开会落到真页，但从地址上看不出站点）。' +
          '她可以按次用 engine 参数覆盖这一项，所以这里只是默认值。',
        enum: ['bing', 'sogou', 'baidu'],
        'x-hot': true,
      },
    },
  },
};
