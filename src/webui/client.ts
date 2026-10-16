/**
 * WebUI panels: `auth` shows the sign-in QR code and polls until bilibili confirms it;
 * `player` shows what is playing and the latest observation grid. Server response shapes are
 * declared here; the browser side imports no Node module.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface AuthState {
  status: 'none' | 'pending' | 'scanned' | 'authorized' | 'expired' | 'error';
  detail: string | null;
  startedAt: string | null;
  uname: string | null;
  isLogin: boolean;
  verified: boolean;
  expiresAt: string | null;
}

const AUTH_TEXT: Record<AuthState['status'], string> = {
  none: '未登录',
  pending: '等待扫码',
  scanned: '已扫码,等手机确认',
  authorized: '已登录',
  expired: '二维码过期',
  error: '出错',
};

const authPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: 'B 站授权', en: 'bilibili sign-in', desc: '用手机 B 站扫码。登录态与 Browser 共用一个 profile。' });
    root.appendChild(card.el);
    const body = ui.h('div');
    const qrBox = ui.h('div');
    qrBox.style.margin = '12px 0';
    const err = ui.msgline();
    card.body.append(body, qrBox, err);
    let polling = false;
    let shownQrAt: string | null = null;

    const act = async (method: string) => {
      err.textContent = '';
      try {
        await ctx.invoke(method);
        await load();
      } catch (e) {
        err.textContent = String(e);
      }
    };

    const showQr = async (startedAt: string | null) => {
      if (shownQrAt === startedAt) return;
      shownQrAt = startedAt;
      qrBox.replaceChildren();
      if (!startedAt) return;
      const blob = await ctx.invokeBinary('qr');
      if (ctx.signal.aborted) return;
      const img = ui.h('img');
      img.alt = '登录二维码';
      img.width = 240;
      img.height = 240;
      img.style.background = '#fff';
      img.style.padding = '8px';
      img.src = URL.createObjectURL(blob);
      ctx.own({ dispose: () => URL.revokeObjectURL(img.src) });
      qrBox.append(img);
    };

    async function load() {
      const s = await ctx.invoke<AuthState>('state');
      if (ctx.signal.aborted) return;
      polling = s.status === 'pending' || s.status === 'scanned';
      body.replaceChildren();
      const row = ui.rowbar();
      row.append(ui.pill(s.isLogin ? '已登录' : !s.verified && s.status === 'none' ? '尚未核验' : AUTH_TEXT[s.status], s.isLogin ? 'on' : 'off'));
      if (s.uname) row.append(ui.h('span', null, s.uname));
      if (s.expiresAt) row.append(ui.h('span', null, `cookie 有效期至 ${s.expiresAt.slice(0, 10)}`));
      row.append(ui.h('span', 'grow'));
      row.append(ui.button(s.isLogin ? '重新扫码' : '生成二维码', { variant: 'primary', onClick: () => void act('start') }));
      row.append(ui.button('核验登录', { onClick: () => void act('refresh') }));
      if (s.isLogin || s.status !== 'none') row.append(ui.button('登出', { variant: 'danger', onClick: () => void act('logout') }));
      body.append(row);
      if (s.detail) body.append(ui.msgline(s.detail, s.status === 'error'));
      await showQr(polling ? s.startedAt : null);
    }

    ctx.interval(() => { if (polling) void load().catch((e: unknown) => { err.textContent = String(e); }); }, 2000);
    void load().catch((e: unknown) => { err.textContent = String(e); });
  },
};

interface PlayerState {
  mode: string;
  state: string;
  url: string;
  video: { title: string; owner: string; duration: number; bvid: string } | null;
  playback: { t: number; duration: number; paused: boolean; readyState: number; width: number; height: number } | null;
  samples: number;
  danmaku: number;
  subtitle: string | null;
  scenes: number;
  lastMontageAt: string | null;
  lastMontageCells: number;
}

const MODE_TEXT: Record<string, string> = { idle: '未启动', browsing: '逛页面', watching: '观看中', paused: '已暂停' };

const playerPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '播放状态', en: 'playback', desc: 'B 站页面默认关着,在这里打开;bot 也能用工具开关。' });
    root.appendChild(card.el);
    const bar = ui.rowbar();
    const err = ui.msgline();
    const act = async (method: string) => {
      err.textContent = '';
      const hold = ui.disable(openBtn, closeBtn);
      try {
        const r = await ctx.invoke<{ message: string }>(method);
        ui.toast(r.message, 'ok');
        await load();
      } catch (e) {
        err.textContent = String(e);
      } finally {
        hold.dispose();
      }
    };
    const openBtn = ui.button('打开 B 站页面', { variant: 'primary', onClick: () => void act('browser-open') });
    const closeBtn = ui.button('关闭 B 站页面', { variant: 'danger', onClick: () => void act('browser-close') });
    bar.append(openBtn, closeBtn, ui.h('span', 'grow'));
    card.body.append(bar);
    const info = ui.h('div');
    const img = ui.h('img');
    img.alt = '最近一张观察帧';
    img.style.maxWidth = '100%';
    img.style.marginTop = '12px';
    img.hidden = true;
    card.body.append(info, err, img);
    let shownAt: string | null = null;
    let url: string | null = null;

    const fmt = (s: number) => {
      const t = Math.max(0, Math.floor(s));
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
      return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`;
    };

    const load = async () => {
      const s = await ctx.invoke<PlayerState>('state');
      if (ctx.signal.aborted) return;
      openBtn.disabled = s.mode !== 'idle';
      closeBtn.disabled = s.mode === 'idle';
      info.replaceChildren(ui.kv([
        { k: '状态', v: ui.pill(MODE_TEXT[s.mode] ?? s.mode, s.mode === 'watching' ? 'on' : 'plain') },
        { k: '页面', v: s.url || '—' },
        { k: '视频', v: s.video ? `${s.video.title}(${s.video.owner},${fmt(s.video.duration)})` : '—' },
        { k: '进度', v: s.playback ? `${fmt(s.playback.t)} / ${fmt(s.playback.duration)} ${s.playback.paused ? '暂停' : '播放'} ${s.playback.width}×${s.playback.height}` : '—' },
        { k: '候选帧', v: String(s.samples) },
        { k: '视频弹幕', v: `${s.danmaku} 条` },
        { k: '字幕', v: s.subtitle ?? '无' },
        { k: '观察帧', v: `${s.scenes} 张${s.lastMontageAt ? `,最近 ${s.lastMontageAt.slice(11, 19)} ${s.lastMontageCells} 格` : ''}` },
      ]));
      if (s.lastMontageAt && s.lastMontageAt !== shownAt) {
        shownAt = s.lastMontageAt;
        const blob = await ctx.invokeBinary('montage');
        if (ctx.signal.aborted) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        img.src = url;
        img.hidden = false;
      }
    };
    ctx.own({ dispose: () => { if (url) URL.revokeObjectURL(url); } });
    ctx.interval(() => { void load().catch((e: unknown) => { err.textContent = String(e); }); }, 2000);
    void load().catch((e: unknown) => { err.textContent = String(e); });
  },
};

const bundle: WebUiClientBundle = { panels: { auth: authPanel, player: playerPanel } };

export default bundle;
