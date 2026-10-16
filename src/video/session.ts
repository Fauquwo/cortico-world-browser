/** One Bilibili viewing session inside Browser; process and target ownership remain with BrowserWorld. */
import QRCode from 'qrcode';
import type { Logger, ToolDef, ToolOutcome, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { VIDEO_CONFIG_GROUP, type VideoConfig } from './config.ts';
import { VIDEO_TOOL_DECLS } from './tools.ts';
import { BrowserRefusal, VideoBrowser, type VideoBrowserOptions, type ListEntry, type Playback, type SubtitleTrack, type VideoInfo } from './browser.ts';
import { CookieJar, QrLogin, type Identity } from './login.ts';
import { DanmakuPool, spread, subtitlesBetween, type SubtitleLine } from './danmaku.ts';
import { describeEvents, dhash, gridFor, meanAbsDiff, selectFrames, type FrameMeta } from './capture.ts';

const HOME_URL = 'https://www.bilibili.com/';
const POLL_MS = 1000;
/** Samples kept beyond the last observation, so a long model round still has material. */
const SAMPLE_CAP = 900;
const LIST_MAX = 20;

type Mode = 'idle' | 'browsing' | 'watching' | 'paused';
type Args = Record<string, unknown>;

interface StoredSample extends FrameMeta {
  jpeg: string;
  /** Cell size the JPEG was drawn at (portrait videos turn the cell). */
  w: number;
  h: number;
}

export type VideoPage = Pick<VideoBrowser, keyof VideoBrowser>;
export interface BilibiliSessionOptions {
  cfg: VideoConfig;
  timezone: string;
  acquire: VideoBrowserOptions['acquire'];
  touch: (targetId: string) => void;
  close: (targetId: string) => Promise<void>;
  createBrowser?: (opts: VideoBrowserOptions) => VideoPage;
}

export class BilibiliSession {
  readonly id = 'browser';
  private readonly cfg: VideoConfig;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private readonly jar: CookieJar;
  private readonly qr: QrLogin;
  private readonly browser: VideoPage;
  private identity: Identity = { isLogin: false };
  private identityVerified = false;

  private mode: Mode = 'idle';
  private currentBvid: string | null = null;
  private video: VideoInfo | null = null;
  private readonly danmaku = new DanmakuPool();
  private subtitleTracks: SubtitleTrack[] = [];
  private subtitles: SubtitleLine[] = [];
  private subtitleLabel = '';
  private lastList: ListEntry[] = [];
  private startError: string | null = null;

  private samples: StoredSample[] = [];
  private prevGray: number[] | null = null;
  private prevMafd = 0;
  /** Operator pause/resume is reported once it has held for this many polls. */
  private pauseSeen = 0;
  private resumeSeen = 0;
  private lastObservedT = 0;
  private lastObservedAt = 0;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observeQueued = false;
  private lastPlayback: Playback | null = null;
  /** Playback changes the World itself asked for, so the poll does not report them as the operator's. */
  private ownChangeUntil = 0;
  private stalledSince = 0;
  private stallReported = false;
  private lastMontage: { jpeg: Buffer; at: string; cells: number } | null = null;
  private sceneCount = 0;
  private generation = 0;
  private active = false;
  private tail: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private polling = false;
  private capturing = false;

  get targetId(): string | null { return this.browser.targetId; }
  protects(target: string): boolean { return this.targetId === target && (this.mode === 'watching' || this.busy > 0); }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (!this.active) throw new BrowserRefusal('Browser World 尚未启动或已经停止');
      this.busy++;
      try { return await action(); } finally { this.busy--; }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async mutateTarget<T>(target: string, action: () => Promise<T>): Promise<T> {
    if (target !== this.targetId) return action();
    return this.exclusive(async () => {
      this.stopObserving(); this.resetVideo();
      await this.browser.stop(); this.mode = 'idle';
      return action();
    });
  }

  private async runPoll(): Promise<void> {
    if (this.polling || this.busy || !this.active) return;
    this.polling = true;
    try { await this.poll(); } catch(e) { this.log?.warn('video poll', {err: String(e)}); }
    finally { this.polling = false; }
  }

  private async runCapture(): Promise<void> {
    if (this.capturing || this.busy || !this.active) return;
    this.capturing = true;
    try { await this.capture(); } catch(e) { this.log?.warn('video capture', {err: String(e)}); }
    finally { this.capturing = false; }
  }

  constructor(private readonly opts: BilibiliSessionOptions) {
    this.cfg = opts.cfg;
    this.jar = new CookieJar();
    this.qr = new QrLogin({ jar: this.jar, onAuthorized: (cookies) => this.exclusive(async () => {
      await this.openBrowser('bot');
      await this.leaveWatching();
      await this.browser.applyCookies(cookies);
      await this.navigate(HOME_URL);
      this.mode = 'browsing';
      await this.refreshIdentity();
    }) });
    this.browser = (opts.createBrowser ?? ((o) => new VideoBrowser(o)))({
      cfg: opts.cfg,
      acquire: opts.acquire,
      touch: opts.touch,
      log: () => this.log,
      onNavigated: (url, byWorld) => this.onNavigated(url, byWorld),
      onLost: () => this.onBrowserLost(),
      onDanmaku: (list, cid) => { if (!this.video || !cid || this.video.cid === cid) this.danmaku.add(list); },
      onSubtitleTracks: (cid, tracks) => { if (!this.video || this.video.cid === cid) this.subtitleTracks = tracks; },
    });
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.active = true;
    this.host = host;
    this.log = host.log;
    this.startError = null;
    // the browser window is opened on purpose: from the WebUI, by the bot's tool, or by the first page tool
    this.pollTimer = setInterval(() => { void this.runPoll(); }, POLL_MS);
    this.pollTimer.unref?.();
  }

  /** Opens the browser window on the bilibili home page; `by` names who asked, for the event the other side gets. */
  private async openBrowser(by: 'operator' | 'bot'): Promise<string> {
    if (this.browser.connected && this.mode !== 'idle') return `浏览器已经开着,${this.stateLine()}`;
    this.startError = null;
    try {
      await this.navigate(HOME_URL);
      await this.refreshIdentity();
    } catch (err) {
      this.startError = (err as Error).message;
      this.log?.warn('browser.video page failed to open', { err: this.startError });
      throw err;
    }
    this.mode = 'browsing';
    if (by === 'operator') this.pushState('[视频] 操作员打开了 B 站视频页,停在首页。');
    return '浏览器窗口已打开,停在 B 站首页';
  }

  private async closeBrowser(by: 'operator' | 'bot'): Promise<string> {
    if (!this.browser.connected && this.mode === 'idle') return '浏览器本来就没开';
    this.stopObserving();
    const target = this.targetId;
    if (this.browser.connected) await this.browser.pause().catch(() => {});
    await this.browser.stop();
    this.resetVideo();
    this.currentBvid = null;
    this.lastPlayback = null;
    this.mode = 'idle';
    if (target) await this.opts.close(target);
    if (by === 'operator') this.pushState('[视频] 操作员关掉了 B 站页面。');
    return '浏览器窗口已关闭';
  }

  /** The window went away without a stop (closed by hand, crashed). */
  private onBrowserLost(): void {
    if (this.mode === 'idle') return;
    this.stopObserving();
    this.resetVideo();
    this.currentBvid = null;
    this.lastPlayback = null;
    this.mode = 'idle';
    this.identity = { isLogin: false };
    this.identityVerified = false;
    this.pushState('[视频] 绑定的视频页已关闭或连接断开；可用 browser_video_open 或 browser_video_attach 重新开始。');
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stopObserving();
    this.qr.stop();
    await this.tail;
    this.stopObserving();
    this.resetVideo();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.browser.connected) await this.browser.pause().catch(() => {});
    await this.browser.stop();
    this.mode = 'idle';
    this.host = null;
  }

  private async refreshIdentity(): Promise<void> {
    this.identity = this.browser.connected ? await this.browser.identity() : { isLogin: false };
    this.identityVerified = this.browser.connected && !this.identity.detail;
  }

  private async navigate(url: string): Promise<void> {
    this.stopObserving();
    this.resetVideo();
    this.mode = 'browsing';
    await this.browser.goto(url);
  }

  /* ---------- state changes ---------- */

  private onNavigated(url: string, byWorld: boolean): void {
    // the video page rewrites its own URL (tracking query, part) after load; only another video
    // or a non-video page drops what was loaded for this one
    const bvid = url.match(/\/video\/(BV[0-9A-Za-z]{10})/)?.[1] ?? null;
    const key = bvid ? `${bvid}:${new URL(url).searchParams.get('p') ?? '1'}` : null;
    const sameVideo = key !== null && key === this.currentBvid;
    this.currentBvid = key;
    if (sameVideo && this.video) return;
    if (!sameVideo) {
      this.stopObserving();
      this.resetVideo();
      this.mode = 'browsing';
    }
    if (byWorld) return;
    if (this.mode === 'watching' || this.mode === 'paused') this.stopObserving();
    this.mode = 'browsing';
    const generation = this.generation;
    setTimeout(() => { if (this.active && generation === this.generation) void this.reportOperatorNavigation(url).catch(e => this.log?.warn('video navigation', {err: String(e)})); }, 2500).unref?.();
  }

  private async reportOperatorNavigation(url: string): Promise<void> {
    if (!this.host || !this.active) return;
    const generation = this.generation;
    let text: string;
    if (/\/video\/BV/.test(url)) {
      await this.browser.waitForVideo(8000);
      const info = await this.browser.videoInfo().catch(() => null);
      if (generation !== this.generation || !this.active || !this.host) return;
      this.video = info;
      text = info
        ? `[视频] 视频页切换到了《${info.title}》(${info.owner},${fmt(info.duration)}${info.parts.length > 1 ? `,第 ${info.p}/${info.parts.length} P` : ''})，已停止自动观察；想看用 browser_video_play。`
        : `[视频] 视频页打开了 ${url}，已停止自动观察。`;
    } else {
      text = `[视频] 视频页切换到了 ${url}。`;
    }
    void this.host.pushEvent({ type: 'browser.video.state', source: this.id, ts: nowIso(this.opts.timezone), text, senderKey: 'browser.video' }, { trigger: 'flush' }).catch(e => this.log?.warn('video state delivery', {err: String(e)}));
  }

  private resetVideo(): void {
    this.generation++;
    this.video = null;
    this.danmaku.clear();
    this.subtitleTracks = [];
    this.subtitles = [];
    this.subtitleLabel = '';
    this.samples = [];
    this.prevGray = null;
    this.lastList = [];
    this.lastMontage = null;
    this.pauseSeen = 0; this.resumeSeen = 0;
  }

  private async poll(): Promise<void> {
    if (this.mode === 'idle' || !this.host) return;
    const generation = this.generation;
    const pb = await this.browser.playback();
    if (generation !== this.generation || !this.active) return;
    const prev = this.lastPlayback;
    this.lastPlayback = pb;
    if (!pb) return;
    const own = Date.now() < this.ownChangeUntil;
    if (this.mode === 'watching') {
      if (this.targetId) this.opts.touch(this.targetId);
      if (pb.ended) {
        this.stopObserving();
        this.mode = 'browsing';
        this.pushState(`[视频] 《${this.video?.title ?? ''}》播放完了(${fmt(pb.duration)})。`);
        return;
      }
      if (!own && prev && (pb.t < prev.t - 1 || pb.t > prev.t + 4)) {
        this.lastObservedT = pb.t;
        this.startObserving();
        this.pushState(`[视频] 播放位置改变，现在 ${fmt(pb.t)}；从这里重新观察。`);
        return;
      }
      // the player pauses itself for a moment when switching quality; only a pause that holds is the operator's
      this.pauseSeen = pb.paused && !own ? this.pauseSeen + 1 : 0;
      if (this.pauseSeen >= 3) {
        this.pauseSeen = 0;
        this.stopObserving();
        this.mode = 'paused';
        this.pushState(`[视频] 播放器已暂停,停在 ${fmt(pb.t)}。`);
        return;
      }
      const stalled = !pb.paused && (pb.readyState < 3 || (prev && !prev.paused && pb.t === prev.t));
      if (stalled) {
        this.stalledSince ||= Date.now();
        if (!this.stallReported && Date.now() - this.stalledSince > this.cfg.playback.stallSec * 1000) {
          this.stallReported = true;
          const ahead = pb.bufferedEnd > pb.t ? `缓冲到 ${fmt(pb.bufferedEnd)}` : '没有缓冲';
          this.pushState(`[视频] 播放器在 ${fmt(pb.t)} 卡住加载超过 ${this.cfg.playback.stallSec} 秒,${ahead},当前画质 ${pb.quality || '未知'}。一直卡可以 browser_video_quality 降一档。`);
        }
      } else {
        if (this.stallReported) this.pushState(`[视频] 播放器恢复了,现在 ${fmt(pb.t)}。`);
        this.stalledSince = 0;
        this.stallReported = false;
      }
    } else if (this.mode === 'paused') {
      this.resumeSeen = !pb.paused && !own ? this.resumeSeen + 1 : 0;
      if (this.resumeSeen >= 2) {
        this.resumeSeen = 0;
        this.mode = 'watching';
        this.lastObservedT = pb.t;
        this.startObserving();
        this.pushState(`[视频] 播放器已继续播放,从 ${fmt(pb.t)} 起。`);
      }
    }
  }

  private pushState(text: string): void {
    if (!this.host || !this.active) return;
    void this.host.pushEvent({ type: 'browser.video.state', source: this.id, ts: nowIso(this.opts.timezone), text, senderKey: 'browser.video' }, { trigger: 'flush' }).catch(e => this.log?.warn('video state delivery', {err: String(e)}));
  }

  /* ---------- observation ---------- */

  private startObserving(): void {
    this.stopObserving();
    if (!this.active) return;
    this.samples = [];
    this.prevGray = null;
    this.lastObservedAt = Date.now();
    this.stalledSince = 0;
    this.stallReported = false;
    const period = Math.max(100, Math.round(1000 / this.cfg.observe.captureFps));
    this.captureTimer = setInterval(() => { void this.runCapture(); }, period);
    this.captureTimer.unref?.();
    this.armObservation();
    void this.ensureSubtitles().catch(e => this.log?.warn('video subtitles', {err: String(e)}));
  }

  private stopObserving(): void {
    this.generation++;
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = null;
    this.observeQueued = false;
  }

  private async capture(): Promise<void> {
    if (this.mode !== 'watching') return;
    const generation = this.generation;
    const o = this.cfg.observe;
    const s = await this.browser.sample(o.cellWidth, o.cellHeight, o.jpegQuality);
    if (!s || generation !== this.generation || !this.active) return;
    const last = this.samples.at(-1);
    if (last && s.t <= last.t) return;
    const luma = s.gray.reduce((a, b) => a + b, 0) / s.gray.length;
    const mafd = this.prevGray ? meanAbsDiff(this.prevGray, s.gray) : 0;
    // a cut is a jump in frame difference, not a large difference: steady motion keeps mafd
    // level, so min(mafd, |mafd − previous mafd|) stays low for it (ffmpeg's scene score)
    const diff = Math.min(mafd, Math.abs(mafd - this.prevMafd));
    this.prevMafd = mafd;
    this.prevGray = s.gray;
    this.samples.push({ t: s.t, jpeg: s.jpeg, w: s.w, h: s.h, hash: dhash(s.gray, 64, 36), luma, diff });
    if (this.samples.length > SAMPLE_CAP) this.samples.splice(0, this.samples.length - SAMPLE_CAP);
  }

  private armObservation(): void {
    if (this.observeTimer || this.observeQueued || this.mode !== 'watching') return;
    const wait = Math.max(0, this.cfg.observe.minIntervalSec * 1000 - (Date.now() - this.lastObservedAt));
    this.observeTimer = setTimeout(() => {
      this.observeTimer = null;
      if (this.mode !== 'watching' || !this.host) return;
      this.observeQueued = true;
      const generation = this.generation;
      this.host.pushDeferred({ type: 'browser.video.scene', senderKey: 'browser.video', render: () => generation === this.generation ? this.renderScene(generation) : Promise.resolve(null) }, { trigger: 'debounce' });
    }, wait);
    this.observeTimer.unref?.();
  }

  /** Builds the observation at delivery time, then arms the next one. */
  private async renderScene(generation = this.generation): Promise<{ text: string; blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> } | null> {
    this.observeQueued = false;
    try {
      if (this.mode !== 'watching') return null;
      const o = this.cfg.observe;
      const t0 = this.lastObservedT;
      const pool = this.samples.filter((s) => s.t > t0);
      if (!pool.length) return null;
      const t1 = pool[pool.length - 1].t;
      const gap = Math.max(0.5, t1 - t0);
      const idx = selectFrames(pool, gap, o);
      const chosen = idx.map((i) => pool[i]);
      const grid = gridFor(chosen.length);
      // cells share the newest frame's orientation; an odd one out is scaled into it
      const newest = chosen[chosen.length - 1];
      const jpeg = await this.browser.montage(chosen.map((c) => c.jpeg), grid.cols, grid.rows, newest.w, newest.h, o.jpegQuality);
      if (!jpeg || generation !== this.generation || !this.active) return null;
      const bytes = Buffer.from(jpeg, 'base64');
      this.lastObservedT = t1;
      this.lastObservedAt = Date.now();
      this.samples = this.samples.filter((s) => s.t > t1 - 1);
      this.sceneCount++;
      this.lastMontage = { jpeg: bytes, at: new Date().toISOString(), cells: chosen.length };

      const v = this.video;
      const lines: string[] = [];
      lines.push(`[视频]${v ? ` 《${v.title}》` : ''} 现在 ${fmt(t1)}${v ? ` / ${fmt(v.duration)}` : ''},播放中。`);
      const times = chosen.map((c, i) => `${fmt(c.t)}${i === chosen.length - 1 ? '(最新)' : ''}`).join('、');
      lines.push(chosen.length === 1 ? `画面 1 格:${times}` : `画面 ${chosen.length} 格(${grid.cols}×${grid.rows},左→右、上→下):${times}`);
      const events = describeEvents(pool, o, fmt);
      if (events.length) lines.push(`检测:${events.join(';')}`);
      if (v) {
        const entered = v.chapters.filter((c) => c.from > t0 && c.from <= t1);
        if (entered.length) lines.push(`进入章节:${entered.map((c) => `${fmt(c.from)}「${c.title}」`).join('、')}`);
      }
      if (!this.subtitles.length) await this.ensureSubtitles();
      if (this.cfg.subtitle.enabled && this.subtitles.length) {
        const sub = subtitlesBetween(this.subtitles, t0, t1);
        if (sub.length) lines.push(`字幕(${this.subtitleLabel}):${sub.map((l) => `${fmt(l.from)} ${l.content}`).join(' | ')}`);
      }
      if (this.cfg.danmaku.enabled && this.danmaku.size) {
        const dm = this.danmaku.between(t0, t1);
        if (dm.length) {
          const quoted = spread(dm, this.cfg.danmaku.maxPerScene);
          lines.push(`视频弹幕 ${fmt(t0)}–${fmt(t1)} 共 ${dm.length} 条${quoted.length < dm.length ? `,引 ${quoted.length} 条` : ''}:${quoted.map((d) => `${fmt(d.t)} ${d.content}`).join(';')}`);
        }
      }
      if (generation !== this.generation || !this.active) return null;
      return { text: lines.join('\n'), blobs: [{ bytes, mime: 'image/jpeg', name: `scene-${this.sceneCount}.jpg`, fallbackText: `画面拼图 ${chosen.length} 格` }] };
    } catch (err) {
      this.log?.warn('browser.video scene render failed', { err: (err as Error).message });
      return null;
    } finally {
      if (generation === this.generation && this.active) {
        this.lastObservedAt = Date.now();
        this.armObservation();
      }
    }
  }

  private async ensureSubtitles(): Promise<void> {
    if (!this.cfg.subtitle.enabled || this.subtitles.length || !this.subtitleTracks.length) return;
    const track = this.subtitleTracks.find((t) => /^ai-zh/.test(t.lan)) ?? this.subtitleTracks.find((t) => /^zh/.test(t.lan)) ?? this.subtitleTracks[0];
    const generation = this.generation;
    const lines = await this.browser.fetchSubtitle(track.url);
    if (generation === this.generation && this.active && lines.length) {
      this.subtitles = lines;
      this.subtitleLabel = track.label;
    }
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Args) => Promise<ToolOutcome>> = {
      browser_video_attach: async (a) => {
        const target = String(a.target ?? '');
        if (!target) throw new BrowserRefusal('target 不能为空，使用 browser_tabs 列出的页面 ID');
        if (this.browser.connected) await this.leaveWatching();
        this.stopObserving(); this.resetVideo(); this.mode = 'idle';
        await this.browser.bind(target);
        const url = this.browser.url();
        if (!isBilibili(url)) { await this.browser.stop(); throw new BrowserRefusal('只能绑定 bilibili.com 的页面'); }
        await this.navigate(url);
        await this.browser.pause();
        this.mode = 'browsing';
        await this.refreshIdentity();
        const video = /\/video\//.test(url) ? await this.loadVideoPage() : null;
        return { text: '已绑定视频页 target: ' + this.targetId + (video ? '\n' + this.describeVideo(video) : '') };
      },
      browser_video_open: (a) => this.open(a),
      browser_video_play: (a) => this.play(a),
      browser_video_pause: () => this.pauseTool(),
      browser_video_seek: (a) => this.seek(a),
      browser_video_look: (a) => this.look(a),
      browser_video_quality: (a) => this.quality(a),
      browser_video_exit: () => this.exit(),
      browser_video_search: (a) => this.search(a),
      browser_video_related: () => this.related(),
      browser_video_comments: (a) => this.comments(a),
    };
    return VIDEO_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args: Args) => this.exclusive(async () => {
        try {
          // open and search bring the window up themselves; the rest work on a page that is already there
          if (this.mode === 'idle' && !['browser_video_attach', 'browser_video_open', 'browser_video_search'].includes(decl.name)) {
            return { text: `[${decl.name} 没执行] 浏览器窗口没开;先 browser_video_attach,或直接 browser_video_open / browser_video_search。`, failed: true };
          }
          const out = await handlers[decl.name](args);
          if (this.targetId) this.opts.touch(this.targetId);
          out.text += this.targetId ? `\ntarget: ${this.targetId}` : '';
          if (this.mode === 'idle' && this.browser.connected) this.mode = 'browsing';
          return out;
        } catch (err) {
          if (err instanceof BrowserRefusal) return { text: `[${decl.name} 没执行] ${err.message}。`, failed: true };
          return { text: `[${decl.name} 失败] ${(err as Error).message}`, failed: true };
        }
      }),
    }));
  }

  private async loadVideoPage(): Promise<VideoInfo | null> {
    await this.browser.waitForVideo();
    for (let i = 0; i < 5; i++) {
      const info = await this.browser.videoInfo();
      if (info) { this.video = info; break; }
      await sleep(400);
    }
    // the subtitle list rides on the player-info response; give it a moment to arrive
    for (let i = 0; i < 10 && !(this.video && this.browser.playerInfoCid === this.video.cid); i++) await sleep(400);
    return this.video;
  }

  private describeVideo(v: VideoInfo): string {
    const parts = v.parts.length > 1 ? `,共 ${v.parts.length} P,现在第 ${v.p} P「${v.parts.find((x) => x.p === v.p)?.title ?? ''}」` : '';
    const subs = this.subtitleTracks.length ? `字幕:${this.subtitleTracks.map((t) => t.label).join('、')}` : '没有字幕';
    const desc = v.desc.replace(/\s+/g, ' ').trim();
    const chapters = v.chapters.length ? `\n章节:${v.chapters.map((c) => `${fmt(c.from)}「${c.title}」`).join('、')}` : '';
    return `《${v.title}》 UP 主 ${v.owner},${fmt(v.duration)},${v.views} 次播放${parts}。${subs};视频弹幕已载入 ${this.danmaku.size} 条(播放中会继续载入)。${desc ? `\n简介:${desc.slice(0, 200)}${desc.length > 200 ? '…' : ''}` : ''}${chapters}`;
  }

  private async open(args: Args): Promise<ToolOutcome> {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const p = typeof args.p === 'number' && args.p >= 1 ? Math.round(args.p) : 0;
    if (this.mode === 'watching' || this.mode === 'paused') await this.leaveWatching();
    if (!target) {
      await this.navigate(HOME_URL);
      await this.refreshIdentity();
      this.mode = 'browsing';
      await sleep(1500);
      this.lastList = await this.browser.listVideos({ max: LIST_MAX });
      return { text: `已回到 B 站首页。首页上的视频:\n${listText(this.lastList)}` };
    }
    let url: string;
    let revealed = '';
    if (/^\d{1,2}$/.test(target)) {
      const entry = this.lastList.find((e) => e.n === Number(target));
      if (!entry) throw new BrowserRefusal(`上一次列表里没有第 ${target} 条${this.lastList.length ? `(有 1–${this.lastList.length})` : '(还没有列表,先搜索或看推荐)'}`);
      if (await this.browser.revealVideo(entry.bvid)) revealed = '(先把那张卡片滚到了画面里)';
      url = entry.url;
    } else if (/^BV[0-9A-Za-z]{10}$/.test(target)) {
      url = `https://www.bilibili.com/video/${target}`;
    } else {
      let u: URL;
      try { u = new URL(target.startsWith('http') ? target : `https://${target}`); } catch { throw new BrowserRefusal(`「${target}」不是 BV 号、网址或列表序号`); }
      if (!/(^|\.)bilibili\.com$/.test(u.hostname) && !/(^|\.)b23\.tv$/.test(u.hostname)) throw new BrowserRefusal('这个窗口只开 bilibili.com 的页面');
      url = u.toString();
    }
    if (p > 1 && /\/video\//.test(url)) url += (url.includes('?') ? '&' : '?') + `p=${p}`;
    await this.navigate(url);
    await this.refreshIdentity();
    this.mode = 'browsing';
    if (!/\/video\//.test(this.browser.url())) {
      await sleep(1500);
      this.lastList = await this.browser.listVideos({ max: LIST_MAX });
      return { text: `已打开 ${this.browser.url()}${revealed}。${this.lastList.length ? `页面上的视频:\n${listText(this.lastList)}` : ''}` };
    }
    const info = await this.loadVideoPage();
    await this.browser.pause();
    if (!info) return { text: `已打开 ${this.browser.url()}${revealed},但页面上读不到视频信息(可能不是视频页,或还在加载)。`, failed: true };
    return { text: `已打开视频页${revealed},没有播放。${this.describeVideo(info)}\n要看就 browser_video_play。` };
  }

  private async play(args: Args): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页;先 browser_video_open 打开一个视频');
    if (!this.video) await this.loadVideoPage();
    if (!this.video) throw new BrowserRefusal('当前页面还没有可读取的视频信息');
    const from = typeof args.fromSec === 'number' && args.fromSec >= 0 ? args.fromSec : undefined;
    this.ownChangeUntil = Date.now() + 3000;
    await this.browser.setWebFullscreen(true);
    await this.browser.play(from);
    await sleep(600);
    const pb = await this.browser.playback();
    if (!pb || pb.paused) throw new BrowserRefusal('播放器尚未开始播放，未开启自动观察；可查看页面加载或登录状态');
    this.mode = 'watching';
    this.lastObservedT = pb?.t ?? from ?? 0;
    this.lastPlayback = pb;
    this.startObserving();
    const o = this.cfg.observe;
    return { text: `开始看${this.video ? `《${this.video.title}》` : ''},从 ${fmt(pb?.t ?? from ?? 0)} 起,画面 ${pb?.width ?? '?'}×${pb?.height ?? '?'}。之后每隔约 ${o.minIntervalSec} 秒自动收到一条观察帧。` };
  }

  private async pauseTool(): Promise<ToolOutcome> {
    if (this.mode !== 'watching') return { text: this.mode === 'paused' ? '已经是暂停状态。' : '现在没有在看视频。' };
    this.ownChangeUntil = Date.now() + 3000;
    await this.browser.pause();
    this.stopObserving();
    this.mode = 'paused';
    const pb = await this.browser.playback();
    return { text: `已暂停,停在 ${fmt(pb?.t ?? 0)}。browser_video_play 继续。` };
  }

  private async seek(args: Args): Promise<ToolOutcome> {
    if (this.mode !== 'watching' && this.mode !== 'paused') throw new BrowserRefusal('现在没有在看视频;先 browser_video_play');
    const pb = await this.browser.playback();
    if (!pb) throw new BrowserRefusal('页面上没有播放器');
    let to: number;
    if (typeof args.toSec === 'number') to = args.toSec;
    else if (typeof args.bySec === 'number') to = pb.t + args.bySec;
    else throw new BrowserRefusal('给 toSec 或 bySec');
    to = Math.max(0, Math.min(pb.duration || to, to));
    this.ownChangeUntil = Date.now() + 3000;
    await this.browser.seek(to);
    if (this.mode === 'paused') { await this.browser.play(); this.mode = 'watching'; }
    this.lastObservedT = to;
    this.samples = [];
    this.prevGray = null;
    this.startObserving();
    return { text: `已跳到 ${fmt(to)}${pb.duration ? ` / ${fmt(pb.duration)}` : ''},继续播放。` };
  }

  private async look(args: Args): Promise<ToolOutcome> {
    const o = this.cfg.observe;
    const nums = [args.x, args.y, args.width, args.height];
    const region = nums.every((n) => typeof n === 'number') ? { x: clamp01(args.x as number), y: clamp01(args.y as number), width: clamp01(args.width as number), height: clamp01(args.height as number) } : undefined;
    const f = await this.browser.frame(o.cellWidth * 2, o.cellHeight * 2, Math.max(o.jpegQuality, 0.85), region);
    if (!f) throw new BrowserRefusal('页面上没有正在播放或已加载的视频画面');
    const where = region ? `区域 (${region.x.toFixed(2)}, ${region.y.toFixed(2)}) ${region.width.toFixed(2)}×${region.height.toFixed(2)}` : '整帧';
    return { text: `${fmt(f.t)} 的画面,${where},${f.width}×${f.height}。`, blobs: [{ bytes: Buffer.from(f.jpeg, 'base64'), mime: 'image/jpeg', name: 'look.jpg', fallbackText: `视频画面 ${f.width}×${f.height}` }] };
  }

  private async quality(args: Args): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    const want = typeof args.level === 'string' ? args.level.trim() : '';
    const describe = (list: Array<{ label: string; active: boolean }>) => list.map((q) => `${q.label}${q.active ? '(当前)' : ''}`).join(' | ');
    let list = await this.browser.qualityOptions();
    if (!list.length) throw new BrowserRefusal('播放器的画质菜单还没出现(视频还没开始加载)');
    if (!want) return { text: `画质档位:${describe(list)}。` };
    this.ownChangeUntil = Date.now() + 5000;
    if (!(await this.browser.setQuality(want))) return { text: `菜单里没有包含「${want}」的档位。现有:${describe(list)}。`, failed: true };
    await sleep(1500);
    list = await this.browser.qualityOptions();
    const pb = await this.browser.playback();
    return { text: `已点「${want}」。现在:${describe(list)};播放器显示 ${pb?.quality || '未知'},画面 ${pb?.width ?? '?'}×${pb?.height ?? '?'}(切换要几秒生效,标「大会员」「登录即享」的档位点了也不会生效)。` };
  }

  private async leaveWatching(): Promise<void> {
    this.ownChangeUntil = Date.now() + 3000;
    this.stopObserving();
    await this.browser.pause().catch(() => {});
    await this.browser.setWebFullscreen(false).catch(() => {});
    this.mode = 'browsing';
  }

  private async exit(): Promise<ToolOutcome> {
    if (this.mode !== 'watching' && this.mode !== 'paused') return { text: '现在就在逛页面的状态。' };
    const pb = await this.browser.playback();
    await this.leaveWatching();
    return { text: `已退出观看,停在 ${fmt(pb?.t ?? 0)},页面留在这个视频。` };
  }

  private async search(args: Args): Promise<ToolOutcome> {
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!keyword) throw new BrowserRefusal('keyword 是空的');
    const page = typeof args.page === 'number' && args.page >= 1 ? Math.round(args.page) : 1;
    if (this.mode === 'watching' || this.mode === 'paused') await this.leaveWatching();
    await this.navigate(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}${page > 1 ? `&page=${page}` : ''}`);
    await this.refreshIdentity();
    this.mode = 'browsing';
    await sleep(2000);
    this.lastList = await this.browser.listVideos({ max: LIST_MAX });
    if (!this.lastList.length) return { text: `搜索「${keyword}」的结果页打开了,但页面上没读到视频卡片;用 browser_shot 对这个 target 截图。`, failed: true };
    return { text: `搜索「${keyword}」第 ${page} 页,${this.lastList.length} 条:\n${listText(this.lastList)}\nbrowser_video_open 给序号打开。` };
  }

  private async related(): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    const exclude = this.video?.bvid;
    let list = await this.browser.listVideos({ within: '#reco_list, .recommend-list-v1, .rec-list, .video-page-card-small', exclude, max: 15 });
    if (!list.length) list = await this.browser.listVideos({ exclude, max: 15 });
    this.lastList = list;
    if (!list.length) return { text: '页面上没读到相关推荐。', failed: true };
    return { text: `相关推荐 ${list.length} 条:\n${listText(list)}\nbrowser_video_open 给序号打开。` };
  }

  private async comments(args: Args): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    if (this.mode === 'watching' || this.mode === 'paused') await this.leaveWatching();
    const count = typeof args.count === 'number' ? Math.max(1, Math.min(50, Math.round(args.count))) : 15;
    const list = await this.browser.readComments(count);
    if (!list.length) return { text: '已滚到评论区,但还没读到评论(可能还在加载,或这个视频关了评论);用 browser_shot 对这个 target 截图。', failed: true };
    return { text: `评论区前 ${list.length} 条:\n${list.map((c, i) => `${i + 1}. ${c.user}${c.likes ? `(赞 ${c.likes})` : ''}:${c.text}`).join('\n')}` };
  }

  /* ---------- prompt & WebUI ---------- */

  private stateLine(): string {
    const v = this.video;
    const pb = this.lastPlayback;
    switch (this.mode) {
      case 'idle': return this.startError ? `视频页没打开(${this.startError})` : '没有绑定视频页';
      case 'browsing': return v ? `停在视频页《${v.title}》,未进入观看` : `逛页面,${this.browser.url() || '空白'}`;
      case 'watching': return `正在看《${v?.title ?? ''}》,${fmt(pb?.t ?? 0)} / ${fmt(v?.duration ?? pb?.duration ?? 0)}`;
      case 'paused': return `《${v?.title ?? ''}》暂停在 ${fmt(pb?.t ?? 0)}`;
    }
  }

  envPromptVars(): Record<string, string> {
    return {
      'bilibiliVideo.identity': this.identity.isLogin ? `已登录,账号「${this.identity.uname ?? ''}」` : this.identityVerified ? '未登录' : '尚未核验登录，可在 Browser 的 B 站授权面板核验',
      'bilibiliVideo.state': this.stateLine(),
      'bilibiliVideo.intervalSec': String(this.cfg.observe.minIntervalSec),
      'bilibiliVideo.stallSec': String(this.cfg.playback.stallSec),
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    const auth = this.qr.current;
    const modeText: Record<Mode, string> = { idle: en ? 'idle' : '未启动', browsing: en ? 'browsing' : '逛页面', watching: en ? 'watching' : '观看中', paused: en ? 'paused' : '已暂停' };
    return {
      label: en ? 'Bilibili video' : 'B 站视频',
      lamps: [
        { label: en ? 'Sign-in' : '登录', state: this.identity.isLogin ? 'online' : auth.status === 'pending' || auth.status === 'scanned' ? 'loading' : 'offline', hint: this.identity.isLogin ? this.identity.uname : auth.detail ?? (en ? 'not signed in' : '未登录') },
        { label: en ? 'Browser' : '浏览器', state: this.browser.connected ? 'online' : this.startError ? 'error' : 'offline', hint: this.startError ?? (this.browser.connected ? this.browser.url() : en ? 'closed; open it from the playback panel' : '没开;在「播放状态」面板里打开') },
        { label: en ? 'Playback' : '播放', state: this.mode === 'watching' ? 'online' : 'offline', hint: this.stateLine() },
      ],
      badges: [
        { label: en ? 'State' : '状态', value: modeText[this.mode], tone: this.mode === 'watching' ? 'on' : 'plain' },
        { label: en ? 'Scenes' : '观察帧', value: this.sceneCount, tone: 'plain' },
      ],
      panels: [
        { id: 'auth', title: en ? 'Bilibili sign-in' : 'B 站授权', description: en ? 'Scan the QR code with the bilibili app.' : '用手机 B 站扫码登录;登录态与 Browser 共用一个 profile。', getMethods: ['qr'] },
        { id: 'player', title: en ? 'Playback' : '播放状态', description: en ? 'What the bot is watching and the latest observation grid.' : '现在在看什么,最近一张观察帧。', getMethods: ['montage'] },
      ],
      invoke: (panel, method) => this.invoke(panel, method),
      config: [VIDEO_CONFIG_GROUP],

    };
  }

  private async invoke(panel: string, method: string): Promise<unknown> {
    if (panel === 'auth') {
      if (method === 'state') {
        const s = this.qr.current;
        return { status: s.status, detail: s.detail ?? this.identity.detail ?? null, verified: this.identityVerified, startedAt: s.startedAt ?? null, uname: this.identity.uname ?? null, isLogin: this.identity.isLogin, expiresAt: null };
      }
      if (method === 'start') { await this.qr.start(); return { ok: true }; }
      if (method === 'logout') return this.exclusive(async () => {
        this.qr.logout();
        if (this.browser.connected) {
          await this.leaveWatching();
          await this.browser.clearCookies();
          await this.navigate(HOME_URL);
        }
        await this.refreshIdentity();
        return {ok: true};
      });
      if (method === 'refresh') return this.exclusive(async () => { await this.openBrowser('bot'); await this.refreshIdentity(); return { isLogin: this.identity.isLogin, uname: this.identity.uname ?? null }; });
      if (method === 'qr') {
        const text = this.qr.current.qrText;
        if (!text) throw new Error('没有待扫的二维码');
        const png = await QRCode.toBuffer(text, { type: 'png', width: 320, margin: 1 });
        return { $binary: { mime: 'image/png', base64: png.toString('base64') } };
      }
    }
    if (panel === 'player') {
      if (method === 'state') {
        return { mode: this.mode, state: this.stateLine(), url: this.browser.url(), video: this.video ? { title: this.video.title, owner: this.video.owner, duration: this.video.duration, bvid: this.video.bvid } : null, playback: this.lastPlayback, samples: this.samples.length, danmaku: this.danmaku.size, subtitle: this.subtitleLabel || null, scenes: this.sceneCount, lastMontageAt: this.lastMontage?.at ?? null, lastMontageCells: this.lastMontage?.cells ?? 0 };
      }
      if (method === 'montage') {
        if (!this.lastMontage) throw new Error('还没有观察帧');
        return { $binary: { mime: 'image/jpeg', base64: this.lastMontage.jpeg.toString('base64') } };
      }
      if (method === 'browser-open') return this.exclusive(async () => ({message: await this.openBrowser('operator')}));
      if (method === 'browser-close') return this.exclusive(async () => ({message: await this.closeBrowser('operator')}));
    }
    throw new Error(`未知方法 ${panel}/${method}`);
  }
}

function listText(list: readonly ListEntry[]): string {
  return list.map((e) => `${e.n}. ${e.text} [${e.bvid}]`).join('\n');
}

/** mm:ss, or h:mm:ss past an hour. */
export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


export function isBilibili(url: string): boolean { try { return /(^|\.)bilibili\.com$/.test(new URL(url).hostname); } catch { return false; } }
