/** Isolated playback panel fixture; never connects to an operator browser or deployment. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = await build({
  stdin: { resolveDir: root, loader: 'ts', contents: `
    import { createWebUi } from '../../cortico/src/web/client/ui/index.ts';
    import bundle from './src/webui/client.ts';
    const controller = new AbortController();
    const memo = {get: (_, fallback) => fallback, set: () => {}};
    const fixture = window.fixture = {saved:[], calls:[], reject:false, owned:[], reload:null,
      state:{autoBringToFront:false,canPresent:true,mode:'watching',url:'https://example.test/video',samples:0,danmaku:0,scenes:0}};
    const ctx = {
      root:document.querySelector('main'), signal:controller.signal, memo,
      ui:createWebUi({memo, signal:controller.signal, overlayHost:document.body}),
      own:item => {fixture.owned.push(item);return item;},
      interval:fn => {fixture.reload=fn; return {dispose(){}};},
      invoke:async method => {
        if(method==='state') return structuredClone(fixture.state);
        fixture.calls.push(method);
        if(method==='browser-close') fixture.state.mode='idle';
        if(method==='browser-open') fixture.state.mode='browsing';
        return {message:'fixture display response'};
      },
      setConfig:async (group,values) => {
        if(fixture.reject) throw new Error('fixture save failed');
        fixture.saved.push({group,values});
        fixture.state.autoBringToFront=values['worlds.browser.video.autoBringToFront'];
        return 'saved';
      }
    };
    fixture.unmount=()=>{controller.abort();fixture.owned.forEach(item=>item.dispose());};
    bundle.panels.player.mount(ctx);
    window.ready=true;
  ` },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
});
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(built.outputFiles[0].text); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><main></main><script type="module" src="/fixture.js"></script></html>');
});
const profile = mkdtempSync(resolve(tmpdir(), 'browser-player-ui-'));
let browser;
let stage = 'start fixture server';
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  stage = 'launch isolated Chrome';
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_SMOKE_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profile });
  stage = 'create fixture page';
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  stage = 'mount playback panel';
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready && !document.querySelector('input[type=checkbox]').disabled, {timeout:8000}).catch(error => { throw new Error(errors.join('; ') || error.message); });
  stage = 'exercise playback controls';
  const clickText = text => page.evaluate(text => [...document.querySelectorAll('button')].find(el => el.textContent === text).click(), text);
  const showDisabled = () => page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '抬到桌面').disabled);
  assert.equal(await page.$eval('input[type=checkbox]', el => el.checked), false);
  assert.equal(await showDisabled(), false);
  await clickText('抬到桌面');
  await page.waitForFunction(() => window.fixture.calls.includes('browser-show'));
  await page.click('input[type=checkbox]');
  await page.waitForFunction(() => window.fixture.saved.length === 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.saved[0]), {
    group:'world:browser:video', values:{'worlds.browser.video.autoBringToFront':true},
  });
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  await page.click('input[type=checkbox]');
  await page.waitForFunction(() => window.fixture.saved.length === 2);
  await clickText('抬到桌面');
  await page.waitForFunction(() => window.fixture.calls.filter(x => x === 'browser-show').length === 2);
  await page.evaluate(() => {window.fixture.reject=true;});
  await page.click('input[type=checkbox]');
  await page.waitForFunction(() => document.body.textContent.includes('fixture save failed') && !document.querySelector('input[type=checkbox]').checked);
  await clickText('关闭 B 站页面');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(el => el.textContent === '抬到桌面').disabled);
  await clickText('打开 B 站页面');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(el => el.textContent === '抬到桌面').disabled);
  await page.evaluate(() => {window.fixture.state.canPresent=false;window.fixture.reload();});
  await page.waitForFunction(() => document.querySelector('input[type=checkbox]').disabled);
  assert.equal(await showDisabled(), true);
  await page.evaluate(() => window.fixture.unmount());
  assert.deepEqual(errors, []);
  console.log('PASS: auto display default, persisted toggles, manual display with auto off, failed-save rollback, closed page and unsupported browser states.');
} catch (error) {
  throw new Error(`${stage}: ${error.message}`, { cause: error });
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const absolute = resolve(profile);
  if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Temporary profile path escaped temp directory');
  rmSync(absolute, { recursive:true, force:true, maxRetries:4, retryDelay:150 });
}
