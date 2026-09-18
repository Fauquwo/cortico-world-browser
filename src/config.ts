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
}

export const BROWSER_DEFAULTS: BrowserConfigSection = {
  enabled: false,
  skillDir: '',
  browser: '',
  port: 3517,
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
