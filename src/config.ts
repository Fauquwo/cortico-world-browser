import { VIDEO_DEFAULTS, type VideoConfig } from './video/config.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';
import { SEARCH_ENGINE_DEFAULT, type SearchEngineId } from './search.ts';
import { SEARCH_DEFAULTS, type BrowserSearchConfig } from './search-settings.ts';

/**
 * config.json 的 worlds.browser 段，默认禁用；bot 或部署可启用。
 *
 * API 搜索的密钥经宿主 secret() 读取，值不写入配置。
 */
export interface BrowserConfigSection {
  search: BrowserSearchConfig;
  video: VideoConfig;
  enabled: boolean;
  /**
   * 操作哪个浏览器：`chrome` / `edge` / `chromium`。
   * 借操作员的浏览器时按它去发现调试口（严格匹配，找不到就报「去开远程调试开关」）；
   * 专属实例模式只要求它是 `chrome`。
   */
  browser: string;
  /** 连上浏览器的上限（发现 + WebSocket 握手 + 验证都算在里面）。 */
  readyTimeoutMs: number;
  /** 单次调用的超时。 */
  requestTimeoutMs: number;
  /** 页面闲置多久被自动关掉（分钟）。管的是她开出来的页面；操作员自己的页面永远不动。 */
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
   * `<home>/Google/Chrome/User Data`（照 Chrome 自己的布局，书签历史检索也按这个布局找她的数据）。
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
  /** 兼容旧部署；search.order 为空时的首选网页引擎。 */
  searchEngine: SearchEngineId;
}

export const BROWSER_DEFAULTS: BrowserConfigSection = {
  search: structuredClone(SEARCH_DEFAULTS),
  video: structuredClone(VIDEO_DEFAULTS),
  enabled: false,
  browser: '',
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
      'worlds.browser.browser': {
        type: 'string',
        title: '浏览器',
        description: 'chrome / edge / chromium。必须是你要操作的那一个，而且已经打开它的远程调试开关（专属实例模式下固定是 chrome）；否则连不上，World 起不来。改完要重启这个 World 才生效。',
        enum: ['chrome', 'edge', 'chromium'],
        'x-hot': false,
      },
      'worlds.browser.readyTimeoutMs': {
        type: 'integer',
        title: '就绪超时（毫秒）',
        description: '启动时等浏览器连上的上限，默认 30000。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.requestTimeoutMs': {
        type: 'integer',
        title: '调用超时（毫秒）',
        description: '单次调用的往返超时，默认 30000。慢站点上读整页可能不够用，可以调大。',
      },
      'worlds.browser.tabIdleMinutes': {
        type: 'integer',
        title: '闲置关页（分钟）',
        description: '她开出来的页面闲置这么久被自动关掉，默认 15。改完要重启这个 World 才生效。',
        'x-hot': false,
      },
      'worlds.browser.ownBrowser': {
        type: 'boolean',
        title: '用她自己的浏览器实例',
        description:
          '开着时本 World 会拉起一个专属 Chrome（独立 profile 与调试端口），不再借操作员日常那个。' +
          '想让她放视频、并且不打扰操作员自己的浏览器时开着；这个模式**不用装任何别的东西、不用开任何开关**。' +
          '代价：登录态不共享。改完要重启这个 World 才生效。',
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
          'profile 放在这个目录下的 Google\\Chrome\\User Data（照 Chrome 自己的布局）。' +
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
        title: '旧配置的默认搜索引擎',
        description:
          '仅在新引擎顺序为空时生效。请在「搜索设置」面板排序并启用引擎。',
        enum: ['bing', 'sogou', 'baidu'],
        'x-hot': true,
      },
    },
  },
};
