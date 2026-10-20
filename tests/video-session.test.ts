import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BilibiliSession, type VideoPage } from '../src/video/session.ts';
import { VIDEO_DEFAULTS } from '../src/video/config.ts';
import type { Playback, VideoBrowserOptions, VideoInfo } from '../src/video/browser.ts';
import { FakeHost } from './helpers/fake-host.ts';

/** A player with a moving clock, navigation responses, shared login and controllable rendering. */
class Player {
  connected = false;
  targetId: string | null = null;
  playerInfoCid = 42;
  address = '';
  paused = true;
  ended = false;
  position = 0;
  startedAt = 0;
  account = true;
  montageGate: Promise<void> = Promise.resolve();
  sampleGate: Promise<void> = Promise.resolve();
  disposed = false;
  constructor(readonly opts: VideoBrowserOptions) {}
  async ensure() { this.connected = true; this.targetId ??= 'video-1'; }
  async bind(target: string) { await this.ensure(); this.targetId = target; }
  async stop() { this.connected = false; this.targetId = null; this.disposed = true; }
  url() { return this.address; }
  async goto(url: string) {
    await this.ensure(); this.address = url;
    this.opts.onNavigated(url, true);
    this.opts.onSubtitleTracks(this.playerInfoCid, [{lan:'zh',label:'中文字幕',url:'https://example.test/subtitle'}]);
    this.opts.onDanmaku([{id:'d1',t:2,mode:1,content:'历史弹幕'}], this.playerInfoCid);
  }
  async waitForVideo() { return true; }
  async videoInfo(): Promise<VideoInfo> {
    return {bvid:'BV1234567890',aid:1,cid:42,title:'合并验证',owner:'测试',duration:1000,p:1,parts:[],desc:'',views:1,chapters:[]};
  }
  async identity() { return {isLogin:this.account,uname:this.account ? '共享账号' : undefined}; }
  async clearCookies() { this.account = false; }
  async applyCookies() { this.account = true; }
  async setWebFullscreen() {}
  time() { return this.position + (this.paused ? 0 : (Date.now()-this.startedAt)/1000); }
  async play(from?: number) { if (from !== undefined) this.position = from; this.startedAt = Date.now(); this.paused = false; }
  async pause() { this.position = this.time(); this.paused = true; }
  async seek(to: number) { this.position = to; this.startedAt = Date.now(); }
  async playback(): Promise<Playback> {
    return {t:this.time(),duration:1000,paused:this.paused,ended:this.ended,readyState:4,bufferedEnd:1000,width:640,height:360,webFullscreen:true,quality:'720P'};
  }
  async sample() {
    const t = this.time(); await this.sampleGate;
    return {t,jpeg:'aW1hZ2U=',gray:Array(64*36).fill(100),w:640,h:360,crop:{x:0,y:0,w:640,h:360}};
  }
  async montage() { await this.montageGate; return 'aW1hZ2U='; }
  async fetchSubtitle() { return [{from:1,to:5,content:'中文字幕内容'}]; }
}

let session: BilibiliSession;
let player: Player;
let host: FakeHost;
let cfg: typeof VIDEO_DEFAULTS;
let present: ReturnType<typeof vi.fn>;

async function call(name: string, args: Record<string,unknown> = {}) {
  const tool = session.tools().find(t=>t.name === 'browser_video_'+name)!;
  const pending = tool.handler(args, {} as never);
  await vi.advanceTimersByTimeAsync(700);
  return pending as Promise<{text:string; failed?:boolean}>;
}

async function panel(name: string, method: string): Promise<Record<string,unknown>> { return await session.webUi().invoke!(name,method,[]) as Record<string,unknown>; }

async function watching() {
  expect((await call('open',{target:'BV1234567890'})).failed).not.toBe(true);
  expect((await call('play')).failed).not.toBe(true);
}

beforeEach(async () => {
  vi.useFakeTimers();
  host = new FakeHost();
  cfg = structuredClone(VIDEO_DEFAULTS);
  present = vi.fn(async () => '窗口已展示');
  session = new BilibiliSession({
    cfg,timezone:'Asia/Shanghai', present,
    acquire:async () => ({targetId:'video-1',browserURL:'http://127.0.0.1:1'}),
    touch:() => {},close:async () => {},
    createBrowser:opts => { player = new Player(opts); return player as unknown as VideoPage; },
  });
  await session.start(host);
});
afterEach(async () => { await session.stop(); vi.useRealTimers(); });

describe('Browser Bilibili session', () => {
  it('keeps automatic display off by default while manual display remains available', async () => {
    await watching();
    expect(present).not.toHaveBeenCalled();
    expect(await panel('player', 'state')).toMatchObject({ autoBringToFront: false, canPresent: true });
    expect(await panel('player', 'browser-show')).toMatchObject({ message: '窗口已展示' });
    expect(present).toHaveBeenCalledWith('video-1', 'operator');
    expect(host.events.some(e => e.text.includes('操作员手动展示'))).toBe(true);
  });

  it('automatically displays once on entering watching, reads hot changes, and preserves playback on failure', async () => {
    cfg.autoBringToFront = true;
    await watching();
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith('video-1', 'bot');
    await call('play');
    expect(present).toHaveBeenCalledTimes(1);
    await call('pause');
    cfg.autoBringToFront = false;
    await call('play');
    expect(present).toHaveBeenCalledTimes(1);
    await call('pause');
    cfg.autoBringToFront = true;
    present.mockRejectedValueOnce(new Error('操作员不想被打断'));
    const result = await call('play');
    expect(result.failed).not.toBe(true);
    expect(result.text).toContain('自动抬窗未成功：操作员不想被打断');
    expect(session.protects('video-1')).toBe(true);
  });

  it('does not raise on opening or after closing, and does not claim a missing window was shown', async () => {
    cfg.autoBringToFront = true;
    await call('open', { target: 'BV1234567890' });
    expect(present).not.toHaveBeenCalled();
    await panel('player', 'browser-close');
    await expect(panel('player', 'browser-show')).rejects.toThrow('还没有视频页');
    expect(present).not.toHaveBeenCalled();
  });

  it('reuses the actual page identity and expires only the active viewing lease', async () => {
    await watching();
    expect(session.protects('video-1')).toBe(true);
    expect(session.protects('another-page')).toBe(false);
    expect(session.envPromptVars()['bilibiliVideo.identity']).toContain('共享账号');
    await call('pause');
    expect(session.protects('video-1')).toBe(false);
    expect(host.deferred).toHaveLength(0);
  });

  it('delivers one deferred montage with subtitles and historical danmaku', async () => {
    await watching();
    await vi.advanceTimersByTimeAsync(VIDEO_DEFAULTS.observe.minIntervalSec*1000+1000);
    expect(host.deferred).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(host.deferred).toHaveLength(1);
    const [text] = await host.renderDeferred();
    expect(text).toContain('中文字幕内容');
    expect(text).toContain('历史弹幕');
    expect(text).toContain('现在');
    expect(host.deferred).toHaveLength(0);
  });

  it('discards an observation already rendering when pause changes the generation', async () => {
    await watching();
    await vi.advanceTimersByTimeAsync(16_000);
    let release!: () => void;
    player.montageGate = new Promise<void>(resolve => {release=resolve;});
    const pending = host.renderDeferred();
    await Promise.resolve();
    await call('pause');
    release();
    expect(await pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.deferred).toHaveLength(0);
  });

  it('invalidates queued scenes across seeking and handles backward manual seeks', async () => {
    await watching();
    await vi.advanceTimersByTimeAsync(16_000);
    const old = host.deferred[0];
    await call('seek',{toSec:100});
    expect(await old.spec.render()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    await player.seek(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.events.some(e=>e.text.includes('播放位置改变'))).toBe(true);
    expect(host.events.every(e=>e.source === 'browser')).toBe(true);
  });

  it('leaves the video session alone when a different page navigates', async () => {
    await watching();
    const value = await session.mutateTarget('another-page',async () => 'navigated');
    expect(value).toBe('navigated');
    expect(session.protects('video-1')).toBe(true);
    await session.mutateTarget('video-1',async () => 'closed');
    expect(session.targetId).toBeNull();
    expect(session.protects('video-1')).toBe(false);
    expect(player.connected).toBe(false);
  });

  it('rebinds a named page and clears the prior part, samples and subtitle state', async () => {
    await watching();
    const result = await call('attach',{target:'named-page'});
    expect(result.text).toContain('named-page');
    expect(player.paused).toBe(true);
    expect(session.protects('named-page')).toBe(false);
    expect((await panel('player','state')).mode).toBe('browsing');
  });

  it('stops watching when a new part is opened and ignores tracking-only URL updates', async () => {
    await watching();
    player.opts.onNavigated('https://www.bilibili.com/video/BV1234567890?tracking=one',false);
    expect(session.protects('video-1')).toBe(true);
    player.opts.onNavigated('https://www.bilibili.com/video/BV1234567890?p=2',false);
    expect(session.protects('video-1')).toBe(false);
    expect((await panel('player','state')).subtitle).toBeNull();
  });

  it('clears profile cookies on logout and reports the actual logged-out identity', async () => {
    await watching();
    await panel('auth','logout');
    const state = await panel('auth','state');
    expect(state).toMatchObject({isLogin:false,uname:null});
    expect(player.account).toBe(false);
  });

  it('drops in-flight capture and deferred work after stop', async () => {
    await watching();
    let release!: () => void;
    player.sampleGate = new Promise<void>(resolve => {release=resolve;});
    await vi.advanceTimersByTimeAsync(1000);
    await session.stop();
    release(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.deferred).toHaveLength(0);
    expect(player.connected).toBe(false);
  });
});
