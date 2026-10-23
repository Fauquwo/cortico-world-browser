/**
 * 本机书签与历史检索——`browser_find_url` 工具的实现，包内自带，不再借上游的 `find-url.mjs`。
 *
 * 与上游 web-access 2.5.4 的输出逐字段对齐（回执长相不变），两处不同：
 * - 历史用 Node 内建的 **`node:sqlite`** 读，替代外部 `sqlite3` 命令——那条「sqlite3 要在 PATH 上」
 *   的要求随之消失。运行时探测，没有就给清楚的话（书签检索不受影响，书签是 JSON）。
 * - 专属实例模式只查**她那个 profile**（根在 `ownBrowserHome` 下，Chrome 布局）——原先靠
 *   `LOCALAPPDATA` 重定向间接做到，现在是显式参数。
 *
 * History 库在 Chrome 运行时被锁着，所以照旧先拷到临时目录再开库。
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const WEBKIT_EPOCH_DIFF_US = 11644473600000000n; // 1601→1970 的微秒差

export interface FindUrlQuery {
  /** 关键词，多词 AND，匹配 title + url。书签没有关键词不返回（书签无时间维度）。 */
  keywords: string[];
  only?: 'bookmarks' | 'history' | null;
  browser?: 'chrome' | 'edge' | null;
  /** 条数上限，默认 20；0 = 不限。 */
  limit?: number;
  /** 时间窗，仅作用于历史：`1d` / `7h` / `30m` / `YYYY-MM-DD`。 */
  since?: string;
  /** 历史排序：按最近访问 / 按访问次数，默认 recent。 */
  sort?: 'recent' | 'visits';
}

export interface FindUrlContext {
  /** 专属实例模式：查她自己的 profile（这个目录下的 `Google/Chrome/User Data`）。 */
  ownHome?: string;
}

interface DataDir {
  id: 'chrome' | 'edge';
  label: string;
  dir: string;
}

interface HistoryHit {
  browser: string;
  profile: string;
  title: string;
  url: string;
  visit: string;
  visit_count: number;
}

interface BookmarkHit {
  browser: string;
  profile: string;
  name: string;
  url: string;
  folder: string;
}

/** node:sqlite 打开的库，我们用到的面。 */
interface SqliteDatabase {
  prepare: (sql: string) => { all: () => unknown[] };
  close: () => void;
}

/**
 * 跑一次检索。不抛错（参数问题也走 `ok: false`），回执正文与上游脚本 stdout 一致，
 * 失败时的正文与上游 stderr 一致。
 */
export async function findUrl(
  query: FindUrlQuery,
  ctx: FindUrlContext,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  try {
    signal?.throwIfAborted();
    const args = normalize(query);
    const since = args.since ? parseSince(args.since) : null;
    // 历史那一路要先有能开库的运行时；没有就当场说清（上游 sqlite3 缺失时也是整个检索报失败）。
    const sqlite = args.only === 'bookmarks' ? null : loadSqlite();
    const browsers = dataDirs(ctx.ownHome).filter((item) => existsSync(item.dir));
    let picked = browsers;
    if (args.browser) {
      picked = browsers.filter((item) => item.id === args.browser);
      if (picked.length === 0) {
        const available = browsers.map((item) => item.id).join('、') || '无';
        return fail(`未找到浏览器 ${args.browser} 的用户数据目录（已检测到：${available}）`);
      }
    }
    if (picked.length === 0) {
      return fail('未找到任何浏览器（Chrome / Edge）的用户数据目录');
    }

    const doBookmarks = args.only !== 'history';
    const doHistory = args.only !== 'bookmarks';
    const bookmarks: BookmarkHit[] = [];
    const history: HistoryHit[] = [];
    for (const browser of picked) {
      if (Date.now() > deadline) return fail(`书签历史检索超时（${Math.round(timeoutMs / 1000)} 秒）。`);
      signal?.throwIfAborted();
      for (const profile of listProfiles(browser.dir)) {
        const profileDir = join(browser.dir, profile.dir);
        if (!existsSync(profileDir)) continue;
        if (doBookmarks) bookmarks.push(...searchBookmarks(profileDir, profile.name, browser.label, args.keywords));
        if (doHistory && sqlite) {
          history.push(...searchHistory(profileDir, profile.name, browser.label, args.keywords, since, args.limit === 0 ? 0 : args.limit * 2, args.sort, sqlite));
        }
      }
    }

    // 历史跨 profile/浏览器合并后按指定排序重排 + 切顶——与上游同一套。
    if (args.sort === 'visits') {
      history.sort((a, b) => b.visit_count - a.visit_count || b.visit.localeCompare(a.visit));
    } else {
      history.sort((a, b) => b.visit.localeCompare(a.visit));
    }
    const bookmarksOut = args.limit === 0 ? bookmarks : bookmarks.slice(0, args.limit);
    const historyOut = args.limit === 0 ? history : history.slice(0, args.limit);

    // 仅当结果真的横跨多个 browser/profile 时才输出 @ 标注（单源场景不加噪音）。
    const seenBrowsers = new Set([...bookmarksOut, ...historyOut].map((item) => item.browser));
    const seenProfiles = new Set([...bookmarksOut, ...historyOut].map((item) => item.profile));
    const showBrowser = seenBrowsers.size > 1;
    const showProfile = seenProfiles.size > 1;

    const parts: string[] = [];
    if (doBookmarks) parts.push(renderBookmarks(bookmarksOut, showBrowser, showProfile));
    if (doBookmarks && doHistory) parts.push('');
    if (doHistory) parts.push(renderHistory(historyOut, showBrowser, showProfile, args.sort === 'visits' ? '按访问次数' : '按最近访问'));
    return { ok: true, output: parts.join('\n') };
  } catch (err) {
    return fail(describe(err));
  }
}

// ——— 参数 ———

interface NormalizedQuery {
  keywords: string[];
  only: 'bookmarks' | 'history' | null;
  browser: 'chrome' | 'edge' | null;
  limit: number;
  since: string | null;
  sort: 'recent' | 'visits';
}

function normalize(query: FindUrlQuery): NormalizedQuery {
  const keywords = query.keywords.map((word) => word.trim()).filter(Boolean);
  const only = query.only === 'bookmarks' || query.only === 'history' ? query.only : null;
  const browser = query.browser === 'chrome' || query.browser === 'edge' ? query.browser : null;
  const limitRaw = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.round(query.limit) : 20;
  if (limitRaw < 0) throw new Error('--limit 需为非负整数');
  const sort = query.sort === 'visits' ? 'visits' : 'recent';
  return { keywords, only, browser, limit: limitRaw, since: query.since?.trim() || null, sort };
}

function parseSince(raw: string): Date {
  const m = raw.match(/^(\d+)([dhm])$/);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    const ms = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无效 --since 值: ${raw}（用 1d / 7h / 30m / YYYY-MM-DD）`);
  }
  return d;
}

// ——— 数据目录与 profile ———

function dataDirs(ownHome?: string): DataDir[] {
  // 专属实例模式：她那个 profile 按 Chrome 的布局住在 <home>/Google/Chrome/User Data，
  // 只查她（她家里没有 Edge，原先靠 LOCALAPPDATA 重定向间接保证的也是这件事）。
  if (ownHome && ownHome.trim() !== '') {
    return [{ id: 'chrome', label: 'Chrome', dir: join(ownHome.trim(), 'Google', 'Chrome', 'User Data') }];
  }
  switch (process.platform) {
    case 'darwin':
      return [
        { id: 'chrome', label: 'Chrome', dir: join(homedir(), 'Library/Application Support/Google/Chrome') },
        { id: 'edge', label: 'Edge', dir: join(homedir(), 'Library/Application Support/Microsoft Edge') },
      ];
    case 'linux':
      return [
        { id: 'chrome', label: 'Chrome', dir: join(homedir(), '.config/google-chrome') },
        { id: 'edge', label: 'Edge', dir: join(homedir(), '.config/microsoft-edge') },
      ];
    case 'win32':
      return [
        { id: 'chrome', label: 'Chrome', dir: join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data') },
        { id: 'edge', label: 'Edge', dir: join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data') },
      ];
    default:
      return [];
  }
}

/** 枚举 profile：Local State 的 info_cache 优先，读不到就退回 Default。 */
function listProfiles(dataDir: string): Array<{ dir: string; name: string }> {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    const info = state.profile?.info_cache ?? {};
    const list = Object.keys(info).map((dir) => ({ dir, name: typeof info[dir]?.name === 'string' ? (info[dir].name as string) : dir }));
    if (list.length > 0) return list;
  } catch {
    // 回退
  }
  return [{ dir: 'Default', name: 'Default' }];
}

// ——— 书签 ———

function searchBookmarks(profileDir: string, profileName: string, browserLabel: string, keywords: string[]): BookmarkHit[] {
  const file = join(profileDir, 'Bookmarks');
  if (!existsSync(file)) return [];
  let data: { roots?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (keywords.length === 0) return []; // 书签无时间维度，无关键词不返回
  const needles = keywords.map((k) => k.toLowerCase());
  const out: BookmarkHit[] = [];
  const walk = (node: unknown, trail: string[]): void => {
    if (!node || typeof node !== 'object') return;
    const item = node as { type?: unknown; name?: unknown; url?: unknown; children?: unknown };
    if (item.type === 'url') {
      const name = typeof item.name === 'string' ? item.name : '';
      const url = typeof item.url === 'string' ? item.url : '';
      const hay = `${name} ${url}`.toLowerCase();
      if (needles.every((n) => hay.includes(n))) {
        out.push({ browser: browserLabel, profile: profileName, name, url, folder: trail.join(' / ') });
      }
    }
    if (Array.isArray(item.children)) {
      const sub = typeof item.name === 'string' && item.name !== '' ? [...trail, item.name] : trail;
      for (const child of item.children) walk(child, sub);
    }
  };
  for (const root of Object.values(data.roots ?? {})) walk(root, []);
  return out;
}

// ——— 历史 ———

function searchHistory(
  profileDir: string,
  profileName: string,
  browserLabel: string,
  keywords: string[],
  since: Date | null,
  limit: number,
  sort: 'recent' | 'visits',
  sqlite: (file: string) => SqliteDatabase,
): HistoryHit[] {
  const src = join(profileDir, 'History');
  if (!existsSync(src)) return [];
  const tmp = join(tmpdir(), `cortico-browser-history-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  try {
    copyFileSync(src, tmp);
    const db = sqlite(tmp);
    try {
      const conds = ['last_visit_time > 0'];
      for (const kw of keywords) {
        const esc = kw.toLowerCase().replace(/'/g, "''");
        conds.push(`LOWER(title || ' ' || url) LIKE '%${esc}%'`);
      }
      if (since) {
        const webkitUs = BigInt(since.getTime()) * 1000n + WEBKIT_EPOCH_DIFF_US;
        conds.push(`last_visit_time >= ${webkitUs}`);
      }
      const limitClause = limit === 0 ? -1 : limit;
      const orderBy = sort === 'visits' ? 'visit_count DESC, last_visit_time DESC' : 'last_visit_time DESC';
      const sql = `SELECT title, url,
        datetime((last_visit_time - 11644473600000000)/1000000, 'unixepoch', 'localtime') AS visit,
        visit_count
        FROM urls WHERE ${conds.join(' AND ')}
        ORDER BY ${orderBy} LIMIT ${limitClause};`;
      const rows = db.prepare(sql).all() as Array<{ title?: unknown; url?: unknown; visit?: unknown; visit_count?: unknown }>;
      return rows.map((row) => ({
        browser: browserLabel,
        profile: profileName,
        title: typeof row.title === 'string' ? row.title : '',
        url: typeof row.url === 'string' ? row.url : '',
        visit: typeof row.visit === 'string' ? row.visit : '',
        visit_count: typeof row.visit_count === 'number' ? row.visit_count : 0,
      }));
    } finally {
      try { db.close(); } catch { /* 已关 */ }
    }
  } catch (err) {
    if (/node:sqlite|DatabaseSync/.test(describe(err))) throw err; // 没有内建 SQLite：这是要说清的环境问题
    return []; // 库坏了、被锁死了之类的单个 profile 问题，别把整个检索带崩（与上游一致）
  } finally {
    try { unlinkSync(tmp); } catch { /* 拷贝前就失败的情况 */ }
  }
}

/**
 * 打开（临时拷贝出来的）历史库。Node 没带 `node:sqlite` 时给出能照着办的话。
 * `node:sqlite` 是内建模块，`createRequire` 走 CommonJS 出口拿它最稳（不受包 exports 限制，
 * 也避开某些版本上动态 `import()` 对内建模块的告警差异）。
 */
function loadSqlite(): ((file: string) => SqliteDatabase) | null {
  try {
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
    return (file: string) => new DatabaseSync(file);
  } catch (err) {
    throw new Error(
      `这个 Node.js 没有可用的内建 SQLite（node:sqlite）：${describe(err)}。` +
        '历史检索要 Node 22.13+ 或 23.4+（官方构建自带）；书签检索不受影响。',
    );
  }
}

// ——— 输出 ———

// 用 `|` 作字段分隔符；字段内含 `|` 的替换成 `│`（全宽竖线）避免歧义。
const clean = (value: unknown): string => String(value ?? '').replaceAll('|', '│').trim();

function originTag(item: { browser: string; profile: string }, showBrowser: boolean, showProfile: boolean): string | null {
  if (showBrowser && showProfile) return '@' + clean(item.browser) + '-' + clean(item.profile);
  if (showBrowser) return '@' + clean(item.browser);
  if (showProfile) return '@' + clean(item.profile);
  return null;
}

function renderBookmarks(items: BookmarkHit[], showBrowser: boolean, showProfile: boolean): string {
  const lines = [`[书签] ${items.length} 条`];
  for (const b of items) {
    const segs = [clean(b.name) || '(无标题)', clean(b.url)];
    if (b.folder) segs.push(clean(b.folder));
    const tag = originTag(b, showBrowser, showProfile);
    if (tag) segs.push(tag);
    lines.push('  ' + segs.join(' | '));
  }
  return lines.join('\n');
}

function renderHistory(items: HistoryHit[], showBrowser: boolean, showProfile: boolean, sortLabel: string): string {
  const lines = [`[历史] ${items.length} 条（${sortLabel}）`];
  for (const h of items) {
    const segs = [clean(h.title) || '(无标题)', clean(h.url), h.visit];
    if (h.visit_count > 1) segs.push(`visits=${h.visit_count}`);
    const tag = originTag(h, showBrowser, showProfile);
    if (tag) segs.push(tag);
    lines.push('  ' + segs.join(' | '));
  }
  return lines.join('\n');
}

function fail(message: string): { ok: boolean; output: string } {
  return { ok: false, output: message };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
