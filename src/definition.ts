import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { BROWSER_DEFAULTS, type BrowserConfigSection } from './config.ts';
import { isSearchEngineId } from './search.ts';
import { BrowserWorld } from './world.ts';

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
};
