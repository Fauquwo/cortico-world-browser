/** Isolated headless Chrome; real WebUI primitives with an in-memory settings host. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const screenshot = resolve(root, '../../tools/browser-search-settings.png');
const built = await build({
  stdin: { resolveDir: root, loader: 'ts', contents: `
    import { createWebUi } from '../../cortico/src/web/client/ui/index.ts';
    import bundle from './src/webui/client.ts';
    const controller = new AbortController();
    const memo = {get: (_, fallback) => fallback, set: () => {}};
    const state = {order:['bing','deepseek','tavily','sogou','baidu'], enabled:{deepseek:true,tavily:true,bing:true,sogou:true,baidu:true}, configured:{deepseek:false,tavily:false}, fallbackEnabled:false, tavilySearchDepth:'basic'};
    const fixture = window.fixture = {state, saved:[], keys:[], reject:false, guard:null, owned:[]};
    const ctx = {
      root:document.querySelector('main'), signal:controller.signal, memo,
      ui:createWebUi({memo, signal:controller.signal, overlayHost:document.body}),
      guardLeave:fn => {fixture.guard=fn;return {dispose(){}};},
      own:item => {fixture.owned.push(item);return item;},
      invoke:async (method,args) => {
        if(method==='save-key') {fixture.keys.push(args[0].engine);state.configured[args[0].engine]=true;}
        return structuredClone(state);
      },
      setConfig:async (group, values) => {
        if(fixture.reject) throw new Error('fixture save failed');
        fixture.saved.push({group,values});
        state.order=values['worlds.browser.search.order'].split(',');
        state.fallbackEnabled=values['worlds.browser.search.fallbackEnabled'];
        state.tavilySearchDepth=values['worlds.browser.search.tavily.searchDepth'];
        for(const id of state.order) state.enabled[id]=values['worlds.browser.search.'+id+'.enabled'];
        return 'saved';
      }
    };
    fixture.unmount=()=>{controller.abort();fixture.owned.forEach(item=>item.dispose());};
    await bundle.panels.search.mount(ctx);
    window.ready=true;
  ` },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
});
const script = built.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Browser 搜索设置验收</title><style>
    body{margin:0;background:#f5f4f0;color:#26332e;font:16px system-ui,sans-serif}main{max-width:900px;margin:32px auto;padding:0 20px}
    .sheet{background:white;border:1px solid #d9ded8;border-radius:12px;margin-bottom:20px;padding:22px}.sheet h3{margin:0 0 12px}.sh-desc{color:#68746d;font-size:14px}
    .rowbar{display:flex;align-items:center;gap:10px}.grow{flex:1}.btn{padding:8px 14px;border:1px solid #d2d9d2;background:#f6f8f5;border-radius:6px;cursor:pointer}.btn.primary{background:#315b48;color:white}.btn:disabled{opacity:.4}
    .check{display:flex;align-items:center;gap:8px;min-width:180px}.field{padding:10px;border:1px solid #d2d9d2;border-radius:6px;display:block;margin:8px 0;min-width:300px}.pill{font-size:12px;color:#617067}.msgline{min-height:24px;font-size:14px;margin:8px 0}
    label{display:block;margin:12px 0}
    </style><main></main><script type="module" src="/fixture.js"></script></html>`);
});
const profile = mkdtempSync(resolve(tmpdir(), 'browser-search-ui-'));
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_SMOKE_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profile });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1100 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);
  const order = () => page.$$eval('[aria-label="搜索引擎优先级"] .check', els => els.map(el => el.textContent));
  assert((await order())[0].includes('Bing'));
  await page.click('[aria-label="上移 DeepSeek"]');
  assert((await order())[0].includes('DeepSeek'));
  // Exercise HTML drag events, including the order sent to the host.
  await page.evaluate(() => {
    const list = document.querySelector('[aria-label="搜索引擎优先级"]');
    const rows = [...list.children];
    const dt = new DataTransfer();
    rows[2].dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:dt }));
    rows[0].dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer:dt }));
    rows[0].dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:dt }));
  });
  assert((await order())[0].includes('Tavily'));
  await page.$eval('[aria-label="搜索引擎优先级"] input', el => el.click());
  await page.$$eval('label.check', els => els.find(el => el.textContent.includes('自动切换')).querySelector('input').click());
  await page.select('select', 'advanced');
  assert(await page.evaluate(() => !!window.fixture.guard()));
  const clickText = text => page.$$eval('button', (els, text) => els.find(el => el.textContent === text).click(), text);
  await clickText('保存搜索设置');
  await page.waitForFunction(() => window.fixture.saved.length === 1);
  const saved = await page.evaluate(() => window.fixture.saved[0]);
  assert.equal(saved.group, 'world:browser:search');
  assert.equal(saved.values['worlds.browser.search.order'], 'tavily,deepseek,bing,sogou,baidu');
  assert.equal(saved.values['worlds.browser.search.tavily.enabled'], false);
  assert.equal(saved.values['worlds.browser.search.fallbackEnabled'], true);
  assert.equal(saved.values['worlds.browser.search.tavily.searchDepth'], 'advanced');
  assert.equal(await page.evaluate(() => window.fixture.guard()), null);

  await page.type('input[type=password]', 'fixture-ui-value');
  await clickText('保存密钥');
  await page.waitForFunction(() => window.fixture.keys.length === 1);
  assert.equal(await page.$eval('input[type=password]', el => el.value), '');
  assert((await page.content()).includes('密钥已保存'));
  assert(!(await page.content()).includes('fixture-ui-value'));
  await page.click('[aria-label="下移 DeepSeek"]');
  await page.evaluate(() => { window.fixture.reject = true; });
  await clickText('保存搜索设置');
  await page.waitForFunction(() => document.body.textContent.includes('保存搜索设置失败'));
  assert(await page.evaluate(() => !!window.fixture.guard()));
  await page.evaluate(() => { window.fixture.reject = false; });
  await clickText('保存搜索设置');
  await page.waitForFunction(() => window.fixture.saved.length === 2);
  await page.screenshot({ path:screenshot, fullPage:true });
  await page.type('input[type=password]', 'unsubmitted-value');
  await page.evaluate(() => window.fixture.unmount());
  assert.equal(await page.$eval('input[type=password]', el => el.value), '');
  assert.deepEqual(errors, []);
  console.log(`PASS: arrows, drag ordering, enabled state, fallback, depth, persistence, secret clearing, failed-save draft and unmount cleanup. Screenshot: ${screenshot}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const absolute = resolve(profile);
  if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Temporary profile path escaped temp directory');
  rmSync(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}
