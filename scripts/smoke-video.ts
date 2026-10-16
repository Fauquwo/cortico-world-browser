/** Isolated Chrome and local synthetic media; never uses the deployed profile or a live bot. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { VideoBrowser } from '../src/video/browser.ts';
import { VIDEO_DEFAULTS } from '../src/video/config.ts';

const profile = mkdtempSync(join(tmpdir(),'browser-video-smoke-'));
const server = createServer((req,res) => {
  if (req.url === '/') {
    res.setHeader('content-type','text/html');
    res.end('<!doctype html><title>Local video fixture</title>');
    return;
  }
  res.setHeader('content-type','application/json');
  if (req.url?.includes('seg.so')) {
    // DmSegMobileReply with one DanmakuElem: id=1, progress=1000, content="local".
    res.end(Buffer.from([10,12,8,1,16,232,7,58,5,108,111,99,97,108]));
  } else {
    res.end(JSON.stringify({data:{subtitle:{subtitles:[{lan:'zh',lan_doc:'local',subtitle_url:'https://example.test/subtitle'}]}}}));
  }
});
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
const port = (server.address() as {port:number}).port;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let video: VideoBrowser | undefined;
try {
  browser = await puppeteer.launch({
    executablePath:process.env.BROWSER_SMOKE_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless:true,userDataDir:profile,
    args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling'],
  });
  const untouched = await browser.newPage();
  await untouched.goto('data:text/html,<title>Keep this page</title>');
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const cdp = await page.createCDPSession();
  const targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  await cdp.detach();
  const count = (await browser.pages()).length;
  const received: {subtitles:number;danmaku:string[]} = {subtitles:0,danmaku:[]};
  video = new VideoBrowser({
    cfg:structuredClone(VIDEO_DEFAULTS),
    acquire:async () => ({targetId,browserURL:`http://127.0.0.1:${new URL(browser!.wsEndpoint()).port}`}),
    touch:() => {},log:() => null,onNavigated:() => {},onLost:() => {},
    onSubtitleTracks:(_,tracks) => {received.subtitles += tracks.length;},
    onDanmaku:entries => {received.danmaku.push(...entries.map(e=>e.content));},
  });
  await video.ensure();
  assert.equal((await browser.pages()).length,count,'binding must preserve every other page');
  assert.equal(await untouched.title(),'Keep this page');
  await page.bringToFront();
  await page.setContent('<canvas width="320" height="180"></canvas><video muted loop></video>');
  await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    const timer = setInterval(() => { ctx.fillStyle = `hsl(${n++*10} 70% 50%)`;ctx.fillRect(0,0,320,180); },30);
    ctx.fillStyle = '#f64'; ctx.fillRect(0,0,320,180);
    const video = document.querySelector('video')!;
    video.srcObject = canvas.captureStream(20);
    await video.play();
    await new Promise(resolve=>setTimeout(resolve,150));
  });
  const frame = await video.sample(640,360,0.8);
  assert(frame && frame.gray.length === 64*36 && frame.jpeg.length > 100);
  const image = await video.frame(640,360,0.8);
  assert(image && image.width > 0);
  const montage = await video.montage([frame.jpeg,frame.jpeg],2,1,640,360,0.8);
  assert(montage && Buffer.from(montage,'base64').subarray(0,2).equals(Buffer.from([255,216])));
  await page.evaluate(async () => {
    await fetch('/x/player/wbi/v2?cid=42');
    await fetch('/dm/wbi/web/seg.so?oid=42').then(r=>r.arrayBuffer());
  });
  for (let n=0;n<50 && (!received.subtitles || !received.danmaku.length);n++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(received.subtitles,1);
  assert.deepEqual(received.danmaku,['local']);
  await video.applyCookies([{name:'SESSDATA',value:'synthetic-smoke-only',domain:'.bilibili.com',path:'/',httpOnly:true,secure:true}]);
  assert((await page.browserContext().cookies()).some(c=>c.name === 'SESSDATA'));
  await video.clearCookies();
  assert(!(await page.browserContext().cookies()).some(c=>c.name === 'SESSDATA'));
  await video.stop();
  assert(browser.connected);
  assert.equal((await browser.pages()).length,count,'disconnect must not close managed or unrelated pages');
  assert.equal(await untouched.title(),'Keep this page');
  console.log('PASS: named page attach, preserved pages, synthetic video capture/montage, subtitle/danmaku responses, shared-profile logout, disconnect without closing Chrome.');
} finally {
  await video?.stop();
  await browser?.close();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
