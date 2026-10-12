/**
 * `browser_search` 的那一半：把关键词拼成结果页地址，再把结果页抽成条目。
 *
 * 为什么是「打开搜索引擎的结果页」而不是调一个搜索 API：这台机器上 Google 与 DuckDuckGo
 * **打不开**（2026-10-12 在她的 Chrome 里量到 `ERR_TIMED_OUT`），而内置的 websearch World
 * 只认 Brave 的密钥（部署里现在是关的）。剩下的现实选项就是在浏览器里搜。
 *
 * 选择器全部是 2026-10-12 在真结果页上量出来的，不是照印象写的：
 * - Bing 国内版（`cn.bing.com`）：`#b_results > li.b_algo h2 a` 给 10 条，标题与地址都是**真的**，
 *   摘要在 `.b_caption p`，来源站名在 `.tptt`；
 * - 搜狗：`h3 a` 给 8 条，标题干净，但地址是 `sogou.com/link?url=…` 这种**跳转链接**；
 * - 百度：`#content_left div.result h3 a` 给 6 条，同样是跳转链接，且实测打开跳转链接可能落回
 *   百度自己的页——所以它排在最后。
 *
 * 所以默认引擎是 Bing 国内版：只有它把真地址摆在回执里，而她拿到的正是地址。
 */
/** 回执里一行东西的上限。与 `world.ts` 的 truncate 不同：这里不要「还有 N 字没显示」那半句——
 *  一行标题后面缀一句说明会把回执撑成两倍长。 */
function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

export type SearchEngineId = 'bing' | 'sogou' | 'baidu';

/** 一次搜索默认要几条、最多几条。 */
export const SEARCH_COUNT_DEFAULT = 10;
export const SEARCH_COUNT_MAX = 20;
/** 回执里标题与摘要各自的上限（抽回来的原值更长，只在这里截）。 */
const TITLE_MAX = 70;
const SNIPPET_MAX = 110;

interface SearchEngineSpec {
  id: SearchEngineId;
  /** `engine` 参数与回执里用的名字。 */
  label: string;
  /** 结果页地址。 */
  pageUrl: (query: string) => string;
  /**
   * 找「一条结果」的锚点选择器，按顺序试，第一个找得到东西的就用。
   * 每个引擎的结果 DOM 都不一样，而且会变——所以这里是一串而不是一条。
   */
  anchors: string[];
  /** 这条结果的摘要：按顺序试。 */
  snippets: string[];
  /** 来源站名（Bing 有；搜狗把站名写在标题里，所以它是空的）。 */
  sources: string[];
  /** 锚点往上找到这一层算「这一条结果」。 */
  container: string;
  /** 这个引擎在结果里用的是自己的跳转链接（回执里要标出来）。 */
  redirects: boolean;
  /** 这个引擎还要额外提醒什么。 */
  caveat?: string;
}

const BING: SearchEngineSpec = {
  id: 'bing',
  label: 'Bing 国内版',
  pageUrl: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
  anchors: ['#b_results > li.b_algo h2 a', '#b_results h2 a', 'li.b_algo h2 a'],
  snippets: ['.b_caption p', 'p.b_lineclamp2', 'p.b_lineclamp3', '.b_snippet', 'p'],
  sources: ['.tptt'],
  container: 'li.b_algo',
  redirects: false,
};

const SOGOU: SearchEngineSpec = {
  id: 'sogou',
  label: '搜狗',
  pageUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
  anchors: ['#main h3 a', '.results h3 a', 'h3 a'],
  snippets: ['.text-layout', '.space-txt', 'p.str_info', '.str_info'],
  sources: [],
  container: '.vrwrap, .rb, .results > div',
  redirects: true,
};

const BAIDU: SearchEngineSpec = {
  id: 'baidu',
  label: '百度',
  pageUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  anchors: ['#content_left div.result h3 a', '#content_left div.result-op h3 a', '#content_left h3 a'],
  snippets: ['[class*=abstract]', '.c-abstract', '.c-span-last', 'span[class*=content-right]'],
  sources: [],
  container: 'div.result, div.result-op, div.c-container',
  redirects: true,
  // 2026-10-12 在真结果页上量到：标题里会被塞进噪声字符（`机械键!盘选购:指南:从!入门到进阶`），
  // 那是它的字体反爬，不是我们抽错了。摘要也常抽不到。所以这一家排在最后，并且直说。
  caveat: '百度会在标题里塞进噪声字符（它的反爬手段），摘要也常常抽不到：能对照，别照着抄。要用就用 Bing 校对一遍。',
};

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngineSpec> = {
  bing: BING,
  sogou: SOGOU,
  baidu: BAIDU,
};

/** 默认引擎。只有它给真地址。 */
export const SEARCH_ENGINE_DEFAULT: SearchEngineId = 'bing';

export function isSearchEngineId(value: string): value is SearchEngineId {
  return value === 'bing' || value === 'sogou' || value === 'baidu';
}

/** 结果页地址。`engine` 不在表里时由调用方先挡掉。 */
export function searchUrl(engine: SearchEngineId, query: string): string {
  return SEARCH_ENGINES[engine].pageUrl(query);
}

/** 一条结果，抽回来之后的形状。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 来源站名，取不到就是空串。 */
  source: string;
  /** 这条地址是引擎自己的跳转链接（看不到真实域名，但打开会落到真页）。 */
  redirect: boolean;
}

/** 结果页抽回来的东西。 */
export interface SearchHarvest {
  /** 页面上匹配到的锚点总数——0 意味着抽取没命中（页面结构变了或那是验证页）。 */
  anchors: number;
  hits: SearchHit[];
  title: string;
  url: string;
}

/**
 * 注入结果页的抽取函数。与 `page-scripts.ts` 一样：纯表达式，走 `browser_js` 那条 `/eval` 通道。
 *
 * 写成「一串锚点选择器 + 拿不到就试下一个」而不是一条硬选择器：结果是活的，
 * 某天某个引擎换一层 DOM，掉的是几条结果，不是整个工具。
 */
const HARVEST_SOURCE = `(spec) => {
  const clean = (value) => String(value === null || value === undefined ? '' : value).replace(/\\s+/g, ' ').trim();
  const firstText = (node, selectors) => {
    if (!node) return '';
    for (const sel of selectors) {
      let el = null;
      try { el = node.querySelector(sel); } catch (err) { continue; }
      if (!el) continue;
      const text = clean(el.innerText || el.textContent);
      if (text) return text.slice(0, 200);
    }
    return '';
  };
  let anchors = [];
  for (const sel of spec.anchors) {
    try { anchors = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (err) { continue; }
    if (anchors.length > 0) break;
  }
  const hits = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (hits.length >= spec.count) break;
    const url = anchor.href || '';
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    let title = clean(anchor.innerText || anchor.textContent);
    if (!title) {
      const heading = anchor.closest && anchor.closest('h2, h3, h4');
      title = heading ? clean(heading.innerText || heading.textContent) : '';
    }
    if (!title) continue;
    const box = (anchor.closest && anchor.closest(spec.container)) || anchor.parentElement;
    seen.add(url);
    hits.push({
      title: title.slice(0, 200),
      url,
      snippet: firstText(box, spec.snippets),
      source: firstText(box, spec.sources),
    });
  }
  return {
    anchors: anchors.length,
    title: document.title,
    url: location.href,
    hits,
  };
}`;

/** 抽取表达式的完整源码。 */
export function searchExpression(engine: SearchEngineId, count: number): string {
  const spec = SEARCH_ENGINES[engine];
  const inline = {
    id: spec.id,
    anchors: spec.anchors,
    snippets: spec.snippets,
    sources: spec.sources,
    container: spec.container,
    count: clampCount(count),
  };
  return `(${HARVEST_SOURCE})(${JSON.stringify(inline)})`;
}

/** 结果条数：3 到 20 之间，默认 10。 */
export function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SEARCH_COUNT_DEFAULT;
  return Math.min(SEARCH_COUNT_MAX, Math.max(3, Math.floor(value)));
}

/** 把页面回的东西收成 `SearchHarvest`；形状不对时返回 null（调用方据此退回整页正文）。 */
export function normalizeHarvest(value: unknown, engine: SearchEngineId): SearchHarvest | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { anchors?: unknown; title?: unknown; url?: unknown; hits?: unknown };
  if (!Array.isArray(raw.hits)) return null;
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of raw.hits) {
    if (typeof item !== 'object' || item === null) continue;
    const hit = item as { title?: unknown; url?: unknown; snippet?: unknown; source?: unknown };
    const title = typeof hit.title === 'string' ? hit.title.trim() : '';
    const url = typeof hit.url === 'string' ? hit.url.trim() : '';
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title,
      url,
      snippet: typeof hit.snippet === 'string' ? hit.snippet.trim() : '',
      source: typeof hit.source === 'string' ? hit.source.trim() : '',
      redirect: isRedirectLink(engine, url),
    });
  }
  return {
    anchors: typeof raw.anchors === 'number' ? raw.anchors : hits.length,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    hits,
  };
}

/**
 * 这条地址是不是引擎自己的跳转链接（看不到真实域名）。
 *
 * 判据是「引擎的域名 + `/link` 那条路」，不是「域名里含 baidu」：`baike.baidu.com/item/…`
 * 是百度百科的**真地址**，标成跳转链接会让她以为那页打不开。
 * （这条是测试逼出来的：`endsWith('baidu.com')` 那种写法把百科也算进去了。）
 */
export function isRedirectLink(engine: SearchEngineId, url: string): boolean {
  if (!SEARCH_ENGINES[engine].redirects) return false;
  const host = hostOf(url);
  const path = pathOf(url);
  if (engine === 'baidu') return host.endsWith('baidu.com') && path.startsWith('/link');
  if (engine === 'sogou') return host.endsWith('sogou.com') && path.startsWith('/link');
  return false;
}

export interface RenderOptions {
  target: string;
  /** 抽取一条都没命中时，附在回执末尾的整页正文（为空表示不附）。 */
  fallbackText?: string;
}

/**
 * 回执。**先说清拿到的是地址、以及下一步怎么用**——她的原话是「没有搜这一步，主题一模糊就只剩
 * 猜域名、翻站内导航两条路」，这份回执要正好接在那两句话上。
 */
export function renderSearch(engine: SearchEngineId, query: string, harvest: SearchHarvest, opts: RenderOptions): string {
  const spec = SEARCH_ENGINES[engine];
  const head = `搜索「${clip(query, 60)}」（${spec.label}）${harvest.hits.length > 0 ? `：${harvest.hits.length} 条` : '：一条都没抽出来'}`;
  const where = `结果页：${harvest.url || searchUrl(engine, query)}（target ${opts.target}，想自己细看这一页就 browser_read 它）`;
  if (harvest.hits.length === 0) {
    const why =
      harvest.anchors === 0
        ? '这一页上没有匹配到结果的锚点：多半是引擎换了页面结构，或者它给了验证页/空白页。'
        : `页面上有 ${harvest.anchors} 个候选，但一条都没能组成条目（标题或地址是空的）。`;
    return [head, where, why, opts.fallbackText ? `这一页此刻的正文（自己从里面挑）：\n${opts.fallbackText}` : '']
      .filter((part) => part !== '')
      .join('\n');
  }
  const lines = harvest.hits.map((hit, index) => {
    const meta = [hit.source ? `[${hit.source}]` : '', hit.redirect ? '（跳转链接）' : ''].filter((part) => part !== '').join('');
    const body = [clip(hit.title, TITLE_MAX), hit.url, [meta, hit.snippet ? clip(hit.snippet, SNIPPET_MAX) : ''].filter((p) => p !== '').join(' ')]
      .filter((part) => part !== '');
    return `${index + 1}. ${body.join('\n   ')}`;
  });
  const tail = [
    spec.redirects
      ? `（${spec.label}的地址是它自己的跳转链接：打开会落到真页，但从地址上看不出是哪个站点。）`
      : '',
    spec.caveat ?? '',
    '要读哪一条，就用 browser_open 打开它的地址——**别去点结果页上的链接**：那些是 `target=_blank`，程序化的点击开不出新页面（真鼠标那一下才行），而按地址打开没有这一层。',
  ]
    .filter((part) => part !== '')
    .join('\n');
  return [head, where, ...lines, tail].join('\n');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}
