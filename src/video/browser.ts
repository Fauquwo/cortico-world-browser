/** A Bilibili page leased from Browser. This adapter never launches or closes Chrome. */
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import type { Logger } from 'cortico/core/types.ts';
import type { VideoConfig } from './config.ts';
import type { StoredCookie } from './login.ts';
import { decodeDanmakuSegment, parseSubtitle, type Danmaku, type SubtitleLine } from './danmaku.ts';

const NAV_TIMEOUT_MS = 30_000;
/** How long after a World goto main-frame navigations still count as the World's. */
const OWN_NAV_WINDOW_MS = 6000;
const EVAL_TIMEOUT_MS = 10_000;
/** The call cannot be carried out for a reason the model should read. */
export class BrowserRefusal extends Error {}

export interface VideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  owner: string;
  /** Seconds, the current part. */
  duration: number;
  /** 1-based current part. */
  p: number;
  parts: Array<{ p: number; title: string; duration: number }>;
  desc: string;
  views: number;
  /** Chapters the uploader marked, seconds. */
  chapters: Array<{ from: number; to: number; title: string }>;
}

export interface Playback {
  t: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  /** 0–4 as `HTMLMediaElement.readyState`. */
  readyState: number;
  /** End of the buffered range that holds the current time, seconds; 0 when none. */
  bufferedEnd: number;
  width: number;
  height: number;
  webFullscreen: boolean;
  /** The player's quality label as shown in its control bar, empty when unreadable. */
  quality: string;
}

export interface Sample {
  t: number;
  jpeg: string;
  /** 64×36 luma of the cropped picture. */
  gray: number[];
  /** Cell size the JPEG was drawn at: the long and short sides turned to the picture's orientation. */
  w: number;
  h: number;
  /** Picture region of the video frame after black bars were cut, video pixels. */
  crop: { x: number; y: number; w: number; h: number };
}

export interface ListEntry {
  n: number;
  bvid: string;
  url: string;
  text: string;
}

export interface SubtitleTrack {
  lan: string;
  label: string;
  url: string;
}

export interface VideoBrowserOptions {
  cfg: VideoConfig;
  acquire: (requested?: string) => Promise<{ targetId: string; browserURL: string }>;
  touch: (targetId: string) => void;
  log: () => Logger | null;
  /** The main frame navigated; `byWorld` is true when a World tool asked for it. */
  onNavigated: (url: string, byWorld: boolean) => void;
  /** The browser went away without `stop()`: window closed by hand, process gone. */
  onLost: () => void;
  onDanmaku: (list: Danmaku[], cid?: number) => void;
  onSubtitleTracks: (cid: number, tracks: SubtitleTrack[]) => void;
}

export class VideoBrowser {
  private browser: Browser | null = null;
  targetId: string | null = null;
  private requested: string | undefined;
  private revision = 0;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private starting: Promise<Page> | null = null;
  /** Main-frame navigations before this instant were asked for by a World tool. */
  private ownNavUntil = 0;
  private lastNavUrl = '';
  private lastNavAt = 0;
  /** cid of the latest player-info response the page received (subtitle list comes with it). */
  playerInfoCid = 0;
  private readonly pendingBodies = new Map<string, string>();
  private responseRevision = 0;

  constructor(private readonly opts: VideoBrowserOptions) {}

  private get cfg() { return this.opts.cfg.browser; }

  get connected(): boolean { return this.browser?.connected === true; }

  async stop(): Promise<void> {
    this.revision++;
    const b = this.browser;
    this.browser = null; this.page = null; this.cdp = null; this.targetId = null;
    this.pendingBodies.clear();
    this.requested = undefined;
    this.playerInfoCid = 0;
    if (b) await b.disconnect().catch(() => {});
  }

  async bind(targetId: string): Promise<void> {
    await this.stop();
    this.requested = targetId;
    await this.ensure();
  }

  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page;
    this.starting ??= this.open().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async open(): Promise<Page> {
    const revision = this.revision;
    const lease = await this.opts.acquire(this.requested);
    const browser = await puppeteer.connect({browserURL: lease.browserURL, defaultViewport: null});
    try {
      const target = await browser.waitForTarget(async target => {
        if (target.type() !== 'page') return false;
        const session = await target.createCDPSession();
        try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId === lease.targetId; }
        finally { await session.detach().catch(() => {}); }
      }, {timeout: 10_000});
      const page = await target.page();
      if (!page || revision !== this.revision) throw new BrowserRefusal('视频会话已经结束');
      this.browser = browser; this.page = page; this.targetId = lease.targetId;
      this.requested = lease.targetId;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = null; this.page = null; this.cdp = null; this.targetId = null;
        this.requested = undefined;
        this.pendingBodies.clear();
        this.opts.onLost();
      });
      page.on('close', () => {
        if (this.page !== page) return;
        void this.stop(); this.opts.onLost();
      });
      await this.attach(page);
      if (revision !== this.revision) throw new BrowserRefusal('视频会话已经结束');
      return page;
    } catch (error) {
      if (this.browser === browser) await this.stop();
      else await browser.disconnect().catch(() => {});
      throw error;
    }
  }

  private async attach(page: Page): Promise<void> {
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.on('dialog', (d) => { void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}); });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (this.page !== page) return;
      const url = frame.url();
      this.responseRevision++;
      this.pendingBodies.clear();
      // a goto fires several main-frame navigations (redirects, the page's own history writes);
      // everything inside the window after the World's goto is the World's
      const byWorld = Date.now() < this.ownNavUntil;
      if (url === this.lastNavUrl && Date.now() - this.lastNavAt < 10_000) return;
      this.lastNavUrl = url;
      this.lastNavAt = Date.now();
      this.opts.onNavigated(url, byWorld);
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');

    const upos = this.cfg.uposHost.trim();
    if (upos) {
      // media segments are fetched from upos-*.bilivideo.com; redirect them to the configured mirror
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*://upos-*.bilivideo.com/*', requestStage: 'Request' }] });
      cdp.on('Fetch.requestPaused', (e) => {
        let url = e.request.url;
        try { const u = new URL(url); u.host = upos; url = u.toString(); } catch { /* leave as is */ }
        void cdp.send('Fetch.continueRequest', { requestId: e.requestId, url }).catch(() => {});
      });
    }
    cdp.on('Network.responseReceived', (e) => {
      if (this.cdp !== cdp) return;
      const url = e.response.url;
      if (/seg\.so/.test(url) || /\/x\/player\/(wbi\/)?v2\?/.test(url)) this.pendingBodies.set(e.requestId, url);
    });
    cdp.on('Network.loadingFinished', (e) => {
      if (this.cdp !== cdp) return;
      const url = this.pendingBodies.get(e.requestId);
      if (!url) return;
      this.pendingBodies.delete(e.requestId);
      const revision = this.responseRevision;
      void cdp.send('Network.getResponseBody', { requestId: e.requestId }).then((r) => {
        if(this.cdp === cdp && revision === this.responseRevision) this.onBody(url, r.body, r.base64Encoded);
      }).catch(() => {});
    });
    cdp.on('Network.loadingFailed', e => { this.pendingBodies.delete(e.requestId); });
    this.cdp = cdp;
  }

  private onBody(url: string, body: string, b64: boolean): void {
    if (/seg\.so/.test(url)) {
      if (!b64) return;
      const list = decodeDanmakuSegment(Buffer.from(body, 'base64'));
      if (list.length) this.opts.onDanmaku(list, Number(new URL(url).searchParams.get('oid')) || undefined);
      return;
    }
    try {
      const j = JSON.parse(b64 ? Buffer.from(body, 'base64').toString('utf8') : body) as { data?: { subtitle?: { subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }> } } };
      const cid = Number(new URL(url).searchParams.get('cid') ?? 0);
      this.playerInfoCid = cid;
      const tracks = (j.data?.subtitle?.subtitles ?? []).filter((s) => s.subtitle_url).map((s) => ({ lan: s.lan ?? '', label: s.lan_doc ?? s.lan ?? '', url: s.subtitle_url!.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url! }));
      this.opts.onSubtitleTracks(cid, tracks);
    } catch { /* not the shape we read */ }
  }

  async applyCookies(cookies: StoredCookie[]): Promise<void> {
    await this.ensure();
    await this.cdp!.send('Network.setCookies', {cookies});
  }

  async clearCookies(): Promise<void> {
    if (!this.page) return;
    const context = this.page.browserContext();
    const cookies = (await context.cookies()).filter(c=> /(^|\.)bilibili\.com$/.test(c.domain));
    await context.deleteCookie(...cookies);
  }

  /* ---------- navigation ---------- */

  async goto(url: string): Promise<void> {
    const page = await this.ensure();
    this.playerInfoCid = 0;
    if(this.targetId) this.opts.touch(this.targetId);
    this.ownNavUntil = Date.now() + OWN_NAV_WINDOW_MS;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new BrowserRefusal(`打不开 ${url}:${(err as Error).message}`);
    }
    this.ownNavUntil = Date.now() + OWN_NAV_WINDOW_MS;
  }

  /** Runs a page function with a deadline; a page that stops answering fails the call instead of hanging it. */
  private async withDeadline<T>(p: Promise<T>, what: string, ms = EVAL_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new BrowserRefusal(`${what}:页面 ${ms / 1000} 秒没有应答`)), ms); });
    try { return await Promise.race([p, deadline]); } finally { if (timer) clearTimeout(timer); }
  }

  url(): string { return this.page?.url() ?? ''; }

  /** Who the page thinks is signed in, from the page's own nav call. */
  async identity(): Promise<{ isLogin: boolean; uname?: string; detail?: string }> {
    const page = await this.ensure();
    return page.evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const j = await r.json();
      return { isLogin: j?.data?.isLogin === true, uname: j?.data?.uname };
    }).catch(e => ({ isLogin: false, detail: String(e) }));
  }

  /* ---------- the video page ---------- */

  /** Waits for the player's video element after a navigation. */
  async waitForVideo(ms = 15_000): Promise<boolean> {
    const page = await this.ensure();
    return page.waitForSelector('video', { timeout: ms }).then(() => true).catch(() => false);
  }

  async videoInfo(): Promise<VideoInfo | null> {
    const page = await this.ensure();
    return page.evaluate(() => {
      const st = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
      const v = st?.videoData as Record<string, unknown> | undefined;
      if (!v || typeof v.bvid !== 'string') return null;
      const p = Number(st?.p ?? 1) || 1;
      const pages = Array.isArray(v.pages) ? (v.pages as Array<Record<string, unknown>>) : [];
      const current = pages.find((x) => Number(x.page) === p) ?? pages[0];
      const owner = v.owner as Record<string, unknown> | undefined;
      const stat = v.stat as Record<string, unknown> | undefined;
      const chapters = Array.isArray(st?.viewPoints) ? (st!.viewPoints as Array<Record<string, unknown>>) : [];
      return {
        bvid: v.bvid as string,
        aid: Number(v.aid ?? 0),
        cid: Number(current?.cid ?? v.cid ?? 0),
        title: String(v.title ?? ''),
        owner: String(owner?.name ?? ''),
        duration: Number(current?.duration ?? v.duration ?? 0),
        p,
        parts: pages.map((x) => ({ p: Number(x.page), title: String(x.part ?? ''), duration: Number(x.duration ?? 0) })),
        desc: String(v.desc ?? ''),
        views: Number(stat?.view ?? 0),
        chapters: chapters.map((c) => ({ from: Number(c.from ?? 0), to: Number(c.to ?? 0), title: String(c.content ?? '') })),
      } satisfies VideoInfo;
    });
  }

  async playback(): Promise<Playback | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const container = document.querySelector('.bpx-player-container');
      let bufferedEnd = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime - 0.5) bufferedEnd = v.buffered.end(i);
      }
      const quality = (document.querySelector('.bpx-player-ctrl-quality-result') as HTMLElement | null)?.innerText?.trim() ?? '';
      return { t: v.currentTime, duration: v.duration || 0, paused: v.paused, ended: v.ended, readyState: v.readyState, bufferedEnd, width: v.videoWidth, height: v.videoHeight, webFullscreen: container?.getAttribute('data-screen') === 'web', quality };
    }).catch(() => null);
  }

  /** The player's quality menu: labels in menu order, the active one marked. */
  async qualityOptions(): Promise<Array<{ label: string; active: boolean }>> {
    const page = await this.ensure();
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.bpx-player-ctrl-quality-menu-item')).map((el) => ({ label: el.innerText.replace(/\s+/g, ' ').trim(), active: el.classList.contains('bpx-state-active') })));
  }

  /** Clicks the quality menu item whose label contains `want` (the audience sees the menu flash); false when there is none. */
  async setQuality(want: string): Promise<boolean> {
    const page = await this.ensure();
    return this.withDeadline(page.evaluate((w) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('.bpx-player-ctrl-quality-menu-item'));
      const hit = items.find((el) => el.innerText.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')));
      if (!hit) return false;
      hit.click();
      return true;
    }, want), '切换画质');
  }

  async setWebFullscreen(on: boolean): Promise<void> {
    const page = await this.ensure();
    const now = (await this.playback())?.webFullscreen ?? false;
    if (now === on) return;
    await this.withDeadline(page.evaluate(() => { (document.querySelector('.bpx-player-ctrl-web') as HTMLElement | null)?.click(); }), '网页全屏');
  }

  /** Starts playback; the play() promise is not awaited, the poll sees whether frames arrive. */
  async play(fromSec?: number): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate((from) => {
      const v = document.querySelector('video');
      if (!v) throw new Error('页面上没有播放器');
      if (typeof from === 'number') v.currentTime = from;
      void v.play().catch(() => {});
    }, fromSec), '播放');
  }

  async pause(): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate(() => { document.querySelector('video')?.pause(); }), '暂停');
  }

  async seek(sec: number): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate((s) => { const v = document.querySelector('video'); if (v) v.currentTime = s; }, sec), '跳转');
  }

  /**
   * One frame of the video as a cell-sized JPEG plus a 64×36 luma map; null when the player is
   * not ready. Black bars (pillarbox or letterbox baked into the stream) are cut: a 96×54 probe
   * finds the columns and rows whose brightest pixel stays black, and the crop is the union of
   * the last four probes, so a dark scene does not shrink it and bars must hold ~2 s to do so.
   * The cell takes the picture's orientation: `cellLong`×`cellShort` for landscape, turned for portrait.
   */
  async sample(cellLong: number, cellShort: number, quality: number): Promise<Sample | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(`(${SAMPLE_FRAME})(${cellLong}, ${cellShort}, ${quality})`).catch(() => null) as Promise<Sample | null>;
  }

  /** The current frame at up to `maxW`×`maxH`, inside the detected crop, optionally a region of it in 0–1 fractions. */
  async frame(maxW: number, maxH: number, quality: number, region?: { x: number; y: number; width: number; height: number }): Promise<{ jpeg: string; width: number; height: number; t: number } | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(`(${LOOK_FRAME})(${maxW}, ${maxH}, ${quality}, ${JSON.stringify(region ?? null)})`).catch(() => null) as Promise<{ jpeg: string; width: number; height: number; t: number } | null>;
  }

  /** Lays cell JPEGs into a row-major grid and returns the grid JPEG. */
  async montage(cells: readonly string[], cols: number, rows: number, cellW: number, cellH: number, quality: number): Promise<string | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(async (jpegs, nc, nr, w, h, q) => {
      const c = document.createElement('canvas');
      c.width = nc * w; c.height = nr * h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      await Promise.all(jpegs.map((src, i) => new Promise<void>((res) => {
        const im = new Image();
        im.onload = () => { ctx.drawImage(im, (i % nc) * w, Math.floor(i / nc) * h, w, h); res(); };
        im.onerror = () => res();
        im.src = `data:image/jpeg;base64,${src}`;
      })));
      return c.toDataURL('image/jpeg', q).split(',')[1] ?? '';
    }, [...cells], cols, rows, cellW, cellH, quality).catch(() => null);
  }

  async fetchSubtitle(url: string): Promise<SubtitleLine[]> {
    const page = await this.ensure();
    // the subtitle CDN answers with a wildcard CORS origin, which a credentialed fetch rejects
    const json = await page.evaluate(async (u) => {
      for (const credentials of ['omit', 'include'] as const) {
        try {
          const r = await fetch(u, { credentials });
          if (r.ok) return await r.json();
        } catch { /* try the other mode */ }
      }
      return null;
    }, url).catch(() => null);
    return parseSubtitle(json);
  }

  /* ---------- the page as the audience sees it ---------- */

  async screenshot(quality: number): Promise<{ jpeg: Uint8Array; title: string; url: string }> {
    const page = await this.ensure();
    const jpeg = await page.screenshot({ type: 'jpeg', quality: Math.round(quality * 100), optimizeForSpeed: true });
    return { jpeg, title: await page.title().catch(() => ''), url: page.url() };
  }

  async scrollScreens(n: number): Promise<{ y: number; height: number }> {
    const page = await this.ensure();
    return page.evaluate((k) => {
      window.scrollBy({ top: k * window.innerHeight * 0.8, behavior: 'smooth' });
      return { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight) };
    }, n);
  }

  /** Video cards on the current page: every `/video/BV…` link, one entry per video, in page order. */
  async listVideos(opts: { within?: string; exclude?: string; max: number }): Promise<ListEntry[]> {
    const page = await this.ensure();
    return page.evaluate((within, exclude, max) => {
      const scope = (within && document.querySelector(within)) || document.body;
      const seen = new Set<string>();
      const out: Array<{ n: number; bvid: string; url: string; text: string }> = [];
      for (const a of Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href*="/video/BV"]'))) {
        const m = a.href.match(/\/video\/(BV[0-9A-Za-z]{10})/);
        if (!m || seen.has(m[1]) || m[1] === exclude) continue;
        const card = (a.closest('[class*="card"], li, .video-page-card-small, .bili-video-card') as HTMLElement | null) ?? a;
        const text = (card.innerText || a.title || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        seen.add(m[1]);
        out.push({ n: out.length + 1, bvid: m[1], url: `https://www.bilibili.com/video/${m[1]}`, text: text.slice(0, 160) });
        if (out.length >= max) break;
      }
      return out;
    }, opts.within ?? '', opts.exclude ?? '', opts.max);
  }

  /** Scrolls the card for `bvid` into view so the audience sees what is about to open. */
  async revealVideo(bvid: string): Promise<boolean> {
    const page = await this.ensure();
    const shown = await page.evaluate((id) => {
      const a = document.querySelector<HTMLAnchorElement>(`a[href*="/video/${id}"]`);
      if (!a) return false;
      (a.closest('[class*="card"], li') ?? a).scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }, bvid);
    if (shown) await new Promise((r) => setTimeout(r, 900));
    return shown;
  }

  /** Scrolls to the comment section and reads loaded comments through the component's shadow roots. */
  async readComments(count: number): Promise<Array<{ user: string; likes: string; text: string }>> {
    const page = await this.ensure();
    await page.evaluate(() => { (document.querySelector('#comment, bili-comments, #commentapp') as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    // the component loads once it is in view; poll for it instead of guessing a delay
    // (a string, not a function: the TS loader wraps inner functions in helpers the page does not have)
    let out: Array<{ user: string; likes: string; text: string }> = [];
    for (let i = 0; i < 15 && !out.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      // the section loads on an intersection observer; keep nudging the scroll so it fires
      await page.evaluate(() => { (document.querySelector('#comment, bili-comments, #commentapp') as HTMLElement | null)?.scrollIntoView({ block: 'start' }); window.scrollBy(0, 80); }).catch(() => {});
      out = await page.evaluate(`(${READ_COMMENTS})(${count})`) as typeof out;
    }
    return out;
  }
}

/** Page-side sampling keeps video pixels out of the browser screenshot path. */
const SAMPLE_FRAME = `(cellLong, cellShort, q) => {
  const v = document.querySelector('video');
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight;
  // probe for black bars
  const PW = 96, PH = 54, BLACK = 24;
  const p = window.__bvProbe || (window.__bvProbe = document.createElement('canvas'));
  if (p.width !== PW) { p.width = PW; p.height = PH; }
  const px = p.getContext('2d', { willReadFrequently: true });
  px.drawImage(v, 0, 0, PW, PH);
  const d = px.getImageData(0, 0, PW, PH).data;
  const colMax = new Array(PW).fill(0), rowMax = new Array(PH).fill(0);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = (y * PW + x) * 4;
    const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (l > colMax[x]) colMax[x] = l;
    if (l > rowMax[y]) rowMax[y] = l;
  }
  let x0 = 0, x1 = PW - 1, y0 = 0, y1 = PH - 1;
  while (x0 < x1 && colMax[x0] < BLACK) x0++;
  while (x1 > x0 && colMax[x1] < BLACK) x1--;
  while (y0 < y1 && rowMax[y0] < BLACK) y0++;
  while (y1 > y0 && rowMax[y1] < BLACK) y1--;
  let det = { x: x0 / PW, y: y0 / PH, w: (x1 - x0 + 1) / PW, h: (y1 - y0 + 1) / PH };
  if (det.w < 0.2 || det.h < 0.2) det = { x: 0, y: 0, w: 1, h: 1 };
  const hist = window.__bvCropHist || (window.__bvCropHist = []);
  hist.push(det);
  if (hist.length > 4) hist.shift();
  let cx0 = 1, cy0 = 1, cx1 = 0, cy1 = 0;
  for (const r of hist) { cx0 = Math.min(cx0, r.x); cy0 = Math.min(cy0, r.y); cx1 = Math.max(cx1, r.x + r.w); cy1 = Math.max(cy1, r.y + r.h); }
  const crop = { x: Math.round(cx0 * W), y: Math.round(cy0 * H), w: Math.max(16, Math.round((cx1 - cx0) * W)), h: Math.max(16, Math.round((cy1 - cy0) * H)) };
  window.__bvCrop = crop;
  // cell orientation follows the picture
  const portrait = crop.h > crop.w;
  const w = portrait ? cellShort : cellLong, h = portrait ? cellLong : cellShort;
  const c = window.__bvCell || (window.__bvCell = document.createElement('canvas'));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  const s = Math.min(w / crop.w, h / crop.h);
  const dw = Math.round(crop.w * s), dh = Math.round(crop.h * s);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  const jpeg = (c.toDataURL('image/jpeg', q).split(',')[1]) || '';
  const g = window.__bvGray || (window.__bvGray = document.createElement('canvas'));
  if (g.width !== 64) { g.width = 64; g.height = 36; }
  const gx = g.getContext('2d', { willReadFrequently: true });
  gx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, 64, 36);
  const gd = gx.getImageData(0, 0, 64, 36).data;
  const gray = [];
  for (let i = 0; i < gd.length; i += 4) gray.push((gd[i] * 299 + gd[i + 1] * 587 + gd[i + 2] * 114) / 1000);
  return { t: v.currentTime, jpeg, gray, w, h, crop };
}`;

const LOOK_FRAME = `(mw, mh, q, r) => {
  const v = document.querySelector('video');
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const crop = window.__bvCrop || { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
  const sx = crop.x + (r ? r.x * crop.w : 0), sy = crop.y + (r ? r.y * crop.h : 0);
  const sw = r ? r.width * crop.w : crop.w, sh = r ? r.height * crop.h : crop.h;
  const scale = Math.min(1, mw / sw, mh / sh) * (r ? Math.max(1, Math.min(mw / sw, mh / sh)) : 1);
  const w = Math.max(16, Math.round(sw * scale)), h = Math.max(16, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
  return { jpeg: (c.toDataURL('image/jpeg', q).split(',')[1]) || '', width: w, height: h, t: v.currentTime };
}`;

const READ_COMMENTS = `(max) => {
  const deep = (root, sel, acc) => {
    acc = acc || [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.matches(sel)) acc.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, sel, acc);
    }
    return acc;
  };
  // text sits in nested shadow roots (user info, rich text, action buttons); read through all of them
  const deepText = (node) => {
    let s = '';
    const walk = (n) => {
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType === 1 && (n.tagName === 'STYLE' || n.tagName === 'SCRIPT')) return;
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const ch of Array.from(n.childNodes)) walk(ch);
    };
    walk(node);
    return s.replace(/\\s+/g, ' ').trim();
  };
  const pick = (el, sel) => {
    const hits = deep(el.shadowRoot || el, sel);
    return hits.length ? deepText(hits[0]) : '';
  };
  const out = [];
  for (const r of deep(document, 'bili-comment-renderer')) {
    const user = pick(r, '#user-name, .user-name, bili-comment-user-info');
    const text = pick(r, 'bili-rich-text, #content, .content');
    const likes = pick(r, '#like, .like');
    if (text) out.push({ user, likes, text: text.slice(0, 300) });
    if (out.length >= max) break;
  }
  if (out.length) return out;
  for (const el of Array.from(document.querySelectorAll('.reply-item'))) {
    const user = (el.querySelector('.user-name') || {}).textContent || '';
    const text = (el.querySelector('.reply-content') || {}).textContent || '';
    const likes = (el.querySelector('.reply-like') || {}).textContent || '';
    if (text.trim()) out.push({ user: user.trim(), likes: likes.trim(), text: text.trim().slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}`;
