import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { BROWSER_DEFAULTS, type BrowserConfigSection } from './config.ts';
import { isSearchEngineId } from './search.ts';
import {
  BROWSER_CLICK_TOOL,
  BROWSER_CLOSE_TOOL,
  BROWSER_FIND_URL_TOOL,
  BROWSER_FOCUS_TOOL,
  BROWSER_JS_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_OPEN_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_SEARCH_TOOL,
  BROWSER_SHOT_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_UPLOAD_TOOL,
  BrowserWorld,
} from './world.ts';

const BROWSERS = ['chrome', 'edge', 'chromium'];

export const BROWSER: WorldDefinition<BrowserConfigSection> = {
  id: 'browser',
  label: 'Browser',
  defaults: () => ({ ...BROWSER_DEFAULTS }),

  /**
   * 激活前检查上游目录与浏览器名。漏配时在这里说清楚要填什么，
   * 而不是等运行起来之后静默地开不了页面。
   */
  preflight: (ctx) => {
    const skillDir = ctx.cfg.skillDir.trim();
    if (!skillDir) {
      throw new Error('worlds.browser.skillDir 没配。填上装了 web-access 的目录（例如 F:\\ai\\web-access）。');
    }
    if (!existsSync(skillDir)) {
      throw new Error(`worlds.browser.skillDir 指向的目录不存在：${skillDir}`);
    }
    // 只硬要求 cdp-proxy.mjs：find-url.mjs 是 2.5.0 起才有的，缺它只是少一个工具。
    if (!existsSync(join(skillDir, 'scripts', 'cdp-proxy.mjs'))) {
      throw new Error(`${skillDir}\\scripts 里没有 cdp-proxy.mjs，这看起来不是 web-access 的目录。`);
    }
    const browser = ctx.cfg.browser.trim();
    if (!browser) {
      throw new Error('worlds.browser.browser 没配。填 chrome / edge / chromium——必须是你要操作的那一个。');
    }
    if (!BROWSERS.includes(browser)) {
      throw new Error(`worlds.browser.browser 只能是 ${BROWSERS.join(' / ')}，现在是「${browser}」。`);
    }
    // 搜索那一路：只认量过能用的三个（Google 与 DuckDuckGo 在这台机器上打不开）。
    if (!isSearchEngineId(String(ctx.cfg.searchEngine))) {
      throw new Error(
        `worlds.browser.searchEngine 只能是 bing / sogou / baidu，现在是「${String(ctx.cfg.searchEngine)}」。`,
      );
    }
    // 专属实例那几项：开着就必须填全，漏什么在这里点名，别等运行起来才发现她没手。
    if (ctx.cfg.ownBrowser) {
      const exe = ctx.cfg.ownBrowserExe.trim();
      if (!exe) {
        throw new Error(
          'worlds.browser.ownBrowser 开着，但 ownBrowserExe 没配。' +
            '填浏览器可执行文件的绝对路径，例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe。',
        );
      }
      if (!existsSync(exe)) {
        throw new Error(`worlds.browser.ownBrowserExe 指向的文件不存在：${exe}`);
      }
      if (!ctx.cfg.ownBrowserHome.trim()) {
        throw new Error(
          'worlds.browser.ownBrowser 开着，但 ownBrowserHome 没配。' +
            '给她一个放 profile 的目录（建议工作区内，例如 <工作区>\\state\\browser-home）。',
        );
      }
      if (browser !== 'chrome') {
        throw new Error(
          `worlds.browser.ownBrowser 只拉了 Chrome（现在 browser = 「${browser}」）。` +
            '专属实例的发现文件写在 Chrome 的布局下，指别的浏览器找不到它。',
        );
      }
    }
  },

  // `ctx.cfg` 是 `worlds.browser` 的活引用：热改的键现读即生效。
  create: (ctx) => new BrowserWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),

  // 自描述：可能出现的全部工具与会推出的全部事件，不进提示词。
  // 两个工具**能不能用**按配置变（browser_focus 要有专属实例且 bringToFront 打开，
  // browser_search 的默认引擎来自配置），名字与静态声明不随配置变。
  describe: {
    tools: describeTools(
      [
        BROWSER_OPEN_TOOL,
        BROWSER_SEARCH_TOOL,
        BROWSER_READ_TOOL,
        BROWSER_JS_TOOL,
        BROWSER_CLICK_TOOL,
        BROWSER_TYPE_TOOL,
        BROWSER_UPLOAD_TOOL,
        BROWSER_SCROLL_TOOL,
        BROWSER_SHOT_TOOL,
        BROWSER_NAVIGATE_TOOL,
        BROWSER_TABS_TOOL,
        BROWSER_FOCUS_TOOL,
        BROWSER_CLOSE_TOOL,
        BROWSER_FIND_URL_TOOL,
      ],
      {
        browser_open: {
          zh: '在他的浏览器里新开一个后台标签页打开地址，并读回标题、正文与链接。',
          en: 'Opens an address in a new background tab in his browser and reads back the title, text and links.',
        },
        browser_search: {
          zh: '搜一次，把结果当一批地址交回来（默认 Bing）。',
          en: 'Runs one search and hands the results back as a batch of addresses (Bing by default).',
        },
        browser_read: {
          zh: '按 target 读一个已打开页面的正文与链接，给选择器就读那一块。',
          en: 'Reads the text and links of an already-opened page by target, or just one part when given a selector.',
        },
        browser_js: {
          zh: '在页面里求值一段 JS 表达式，别的工具不够用时用它。',
          en: 'Evaluates one JavaScript expression in the page, for what the other tools do not cover.',
        },
        browser_click: {
          zh: '点第一个匹配选择器的元素；native 发真鼠标事件（开新标签的链接只有它能点开）。',
          en: 'Clicks the first element matching a selector; native sends a real mouse event (the only way a target=_blank link opens).',
        },
        browser_type: {
          zh: '往输入框、下拉或可编辑元素里填值，并触发 input/change；可以顺手提交。',
          en: 'Types a value into an input, select or editable element, firing input/change, and can submit it.',
        },
        browser_upload: {
          zh: '把本机文件挂到页面的 file input 上，绕过文件对话框。',
          en: 'Attaches local files to a page file input, bypassing the file dialog.',
        },
        browser_scroll: {
          zh: '滚动页面（bottom 会加载懒加载内容）。',
          en: 'Scrolls the page (bottom loads lazy content).',
        },
        browser_shot: {
          zh: '截一张视口截图，作为图片附在回执里。',
          en: 'Captures one screenshot of the viewport and attaches it to the receipt.',
        },
        browser_navigate: {
          zh: '把已有的标签页转到另一个地址，或后退一步。',
          en: 'Moves an existing tab to another address, or goes back one entry.',
        },
        browser_tabs: {
          zh: '列出此刻打开的页面，并报上一次看以来他开、转、关了哪些页。',
          en: 'Lists the pages open right now and reports which ones he opened, moved or closed since the last look.',
        },
        browser_focus: {
          zh: '把她自己的窗口搬到操作员眼前（独占屏幕，只在真想让他看时用）。',
          en: 'Brings her own window into the operator\'s view (takes over the screen; only when she really wants him to look).',
        },
        browser_close: {
          zh: '关掉一个她开的页面；他自己开的页面一律拒绝关。',
          en: 'Closes a page she opened; pages the operator opened are refused.',
        },
        browser_find_url: {
          zh: '在本机的浏览器书签与历史里按关键词找地址。',
          en: 'Searches this machine\'s browser bookmarks and history for a URL by keyword.',
        },
      },
    ),
    events: [
      { type: 'browser.ready', description: { zh: '浏览器与 cdp-proxy 都就绪了，工具可用。', en: 'The browser and cdp-proxy are ready; the tools are usable.' } },
      { type: 'browser.down', description: { zh: '浏览器起不来或连不上（proxy 拉不起来、浏览器没接上、端口被占等），工具会报失败。', en: 'The browser could not be started or reached (proxy failed to launch, browser not connected, port taken); the tools report failure.' } },
    ],
  },
};
