/** Bilibili QR sign-in; persistent login belongs to the Browser profile. */

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** The QR code is valid this long on the bilibili side. */
export const QR_LIFETIME_MS = 180_000;
const POLL_MS = 2000;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; absent for session cookies. */
  expires?: number;
}

export type QrStatus = 'none' | 'pending' | 'scanned' | 'authorized' | 'expired' | 'error';

export interface QrState {
  status: QrStatus;
  /** Text to encode while pending or scanned. */
  qrText?: string;
  startedAt?: string;
  detail?: string;
}

export interface Identity {
  isLogin: boolean;
  uname?: string;
  mid?: number;
  detail?: string;
}

/** QR cookies stay in memory until they have been applied to the shared profile. */
export class CookieJar {
  private cookies: StoredCookie[] = [];
  load(): StoredCookie[] { return structuredClone(this.cookies); }
  save(cookies: readonly StoredCookie[]): void { this.cookies = structuredClone([...cookies]); }
  clear(): void { this.cookies = []; }
}

/** Parses one `Set-Cookie` header value into a stored cookie for `.bilibili.com`. */
export function parseSetCookie(line: string): StoredCookie | null {
  const [pair, ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const out: StoredCookie = { name, value, domain: '.bilibili.com', path: '/', secure: true, httpOnly: false };
  for (const a of attrs) {
    const [k, v = ''] = a.trim().split('=');
    const key = k.toLowerCase();
    if (key === 'domain' && v) out.domain = v.startsWith('.') ? v : `.${v}`;
    else if (key === 'path' && v) out.path = v;
    else if (key === 'httponly') out.httpOnly = true;
    else if (key === 'expires' && v) { const t = Date.parse(v); if (Number.isFinite(t)) out.expires = Math.floor(t / 1000); }
    else if (key === 'max-age' && v) { const n = Number(v); if (Number.isFinite(n)) out.expires = Math.floor(Date.now() / 1000) + n; }
  }
  return out;
}

/** Cookies named in the confirm URL's query (`SESSDATA`, `bili_jct`, `DedeUserID`...), used when `Set-Cookie` is absent. */
export function cookiesFromConfirmUrl(url: string): StoredCookie[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const wanted = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const out: StoredCookie[] = [];
  for (const name of wanted) {
    const v = u.searchParams.get(name);
    if (v) out.push({ name, value: v, domain: '.bilibili.com', path: '/', secure: true, httpOnly: name === 'SESSDATA', expires: Math.floor(Date.now() / 1000) + 180 * 86400 });
  }
  return out;
}

export interface QrLoginOptions {
  onAuthorized?: (cookies: StoredCookie[]) => Promise<void>;
  jar: CookieJar;
  onChange?: (state: QrState) => void;
  fetchImpl?: typeof fetch;
}

/** One QR sign-in attempt at a time; `start()` replaces a running one. */
export class QrLogin {
  private state: QrState = { status: 'none' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private key = '';
  private revision = 0;
  private readonly f: typeof fetch;

  constructor(private readonly opts: QrLoginOptions) {
    this.f = opts.fetchImpl ?? fetch;
    if (opts.jar.load().some((c) => c.name === 'SESSDATA')) this.state = { status: 'authorized' };
  }

  get current(): QrState { return this.state; }

  private set(next: QrState): void {
    this.state = next;
    this.opts.onChange?.(next);
  }

  async start(): Promise<QrState> {
    this.stopPolling();
    const revision = this.revision;
    try {
      const r = await this.f(GENERATE_URL, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
      const j = await r.json() as { code?: number; data?: { url?: string; qrcode_key?: string }; message?: string };
      if (revision !== this.revision) return this.state;
      if (j.code !== 0 || !j.data?.url || !j.data.qrcode_key) throw new Error(j.message || `generate 返回 code ${j.code}`);
      this.key = j.data.qrcode_key;
      this.set({ status: 'pending', qrText: j.data.url, startedAt: new Date().toISOString() });
      this.schedule();
    } catch (err) {
      if (revision !== this.revision) return this.state;
      this.set({ status: 'error', detail: `取二维码失败:${(err as Error).message}` });
    }
    return this.state;
  }

  logout(): void {
    this.stopPolling();
    this.opts.jar.clear();
    this.set({ status: 'none' });
  }

  stop(): void { this.stopPolling(); }

  private stopPolling(): void {
    this.revision++;
    this.opts.jar.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => { void this.poll(); }, POLL_MS);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    this.timer = null;
    if (this.state.status !== 'pending' && this.state.status !== 'scanned') return;
    const revision = this.revision;
    try {
      const r = await this.f(`${POLL_URL}?qrcode_key=${encodeURIComponent(this.key)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
      const j = await r.json() as { code?: number; data?: { code?: number; message?: string; url?: string } };
      if (revision !== this.revision) return;
      const code = j.data?.code;
      if (code === 0) {
        const fromHeaders = (r.headers.getSetCookie?.() ?? []).map(parseSetCookie).filter((c): c is StoredCookie => !!c);
        const cookies = fromHeaders.length ? fromHeaders : cookiesFromConfirmUrl(j.data?.url ?? '');
        if (!cookies.some((c) => c.name === 'SESSDATA')) throw new Error('确认成功但响应里没有 SESSDATA');
        const kept = this.opts.jar.load().filter((c) => !cookies.some((n) => n.name === c.name));
        this.opts.jar.save([...kept, ...cookies]);
        await this.opts.onAuthorized?.(this.opts.jar.load());
        this.opts.jar.clear();
        if (revision !== this.revision) return;
        this.set({ status: 'authorized' });
        return;
      }
      if (code === 86038) { this.set({ status: 'expired', detail: '二维码已过期,重新生成一个。' }); return; }
      if (code === 86090 && this.state.status !== 'scanned') this.set({ ...this.state, status: 'scanned', detail: '已扫码,在手机上确认登录。' });
      if (this.state.startedAt && Date.now() - Date.parse(this.state.startedAt) > QR_LIFETIME_MS) { this.set({ status: 'expired', detail: '二维码已过期,重新生成一个。' }); return; }
      this.schedule();
    } catch (err) {
      this.opts.jar.clear();
      if (revision !== this.revision) return;
      this.set({ status: 'error', detail: `轮询失败:${(err as Error).message}` });
    }
  }

}
