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
  /** 要不要报告操作员自己的上网动向（他新开、跳转、关掉的页面）。 */
  watchActivity: boolean;
  /** 取一次浏览器页面快照的间隔。 */
  pollIntervalMs: number;
  /**
   * 动向要不要叫醒她：false 时随下一批事件进上下文（piggyback，不触发模型轮）；
   * true 时代替他按合批规则立即投递（debounce）。
   */
  wakeOnActivity: boolean;
  /** 拉起 proxy 之后，等它连上浏览器的上限。 */
  readyTimeoutMs: number;
  /** 单次 HTTP 调用的往返超时。 */
  requestTimeoutMs: number;
  /** 本 World 拉起的那个 proxy 里，页面闲置多久被自动关掉（上游默认 15 分钟）。 */
  tabIdleMinutes: number;
}

export const BROWSER_DEFAULTS: BrowserConfigSection = {
  enabled: false,
  skillDir: '',
  browser: '',
  port: 3517,
  watchActivity: true,
  pollIntervalMs: 15000,
  wakeOnActivity: false,
  readyTimeoutMs: 30000,
  requestTimeoutMs: 30000,
  tabIdleMinutes: 15,
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
      'worlds.browser.watchActivity': {
        type: 'boolean',
        title: '报告上网动向',
        description: '他新开、跳转、关掉的页面，作为事件进入上下文。关掉就只剩服务起停事件。',
      },
      'worlds.browser.pollIntervalMs': {
        type: 'integer',
        title: '快照间隔（毫秒）',
        description: '多久取一次页面快照。默认 15000；调小会更及时，也更频繁地问浏览器要一次列表。',
      },
      'worlds.browser.wakeOnActivity': {
        type: 'boolean',
        title: '动向叫醒她',
        description: '开着=他一动网页就按合批规则投递（可能打断她）；关着=只在他说话时随批进上下文。默认关。',
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
    },
  },
};
