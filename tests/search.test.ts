import { describe, expect, it } from 'vitest';
import {
  SEARCH_COUNT_DEFAULT,
  SEARCH_ENGINES,
  clampCount,
  isRedirectLink,
  isSearchEngineId,
  normalizeHarvest,
  renderSearch,
  searchExpression,
  searchUrl,
} from '../src/search.ts';

describe('搜索：地址与引擎', () => {
  it('三个引擎的结果页地址，关键词都编码进去', () => {
    expect(searchUrl('bing', '怎么挑机械键盘')).toBe(
      `https://cn.bing.com/search?q=${encodeURIComponent('怎么挑机械键盘')}`,
    );
    expect(searchUrl('sogou', 'a b')).toContain('sogou.com/web?query=a%20b');
    expect(searchUrl('baidu', 'a b')).toContain('baidu.com/s?wd=a%20b');
  });

  it('只认量过能用的三个引擎名', () => {
    expect(isSearchEngineId('bing')).toBe(true);
    expect(isSearchEngineId('sogou')).toBe(true);
    expect(isSearchEngineId('baidu')).toBe(true);
    // 这两个在这台机器上打不开（2026-10-12 量到），所以它们不在表里。
    expect(isSearchEngineId('google')).toBe(false);
    expect(isSearchEngineId('duckduckgo')).toBe(false);
    expect(Object.keys(SEARCH_ENGINES).sort()).toEqual(['baidu', 'bing', 'sogou']);
  });

  it('条数：默认 10，夹在 3 到 20 之间', () => {
    expect(clampCount(undefined)).toBe(SEARCH_COUNT_DEFAULT);
    expect(clampCount(Number.NaN)).toBe(SEARCH_COUNT_DEFAULT);
    expect(clampCount(1)).toBe(3);
    expect(clampCount(7)).toBe(7);
    expect(clampCount(999)).toBe(20);
    expect(clampCount(8.6)).toBe(8);
  });

  it('抽取表达式是能解析的 JS，并带上了这个引擎的选择器与条数', () => {
    for (const engine of ['bing', 'sogou', 'baidu'] as const) {
      const expression = searchExpression(engine, 5);
      expect(() => new Function(`return ${expression}`)).not.toThrow();
      expect(expression).toContain(SEARCH_ENGINES[engine].anchors[0]);
      expect(expression).toContain('"count":5');
    }
  });
});

describe('搜索：把页面回的东西收成条目', () => {
  it('过滤掉空标题、空地址与重复地址', () => {
    const harvest = normalizeHarvest(
      {
        anchors: 4,
        title: '搜索页',
        url: 'https://cn.bing.com/search?q=x',
        hits: [
          { title: '第一条', url: 'https://a.example/1', snippet: '摘要', source: '甲站' },
          { title: '', url: 'https://a.example/2' },
          { title: '没地址', url: '' },
          { title: '重复的', url: 'https://a.example/1' },
          '不是对象',
        ],
      },
      'bing',
    );
    expect(harvest?.hits).toHaveLength(1);
    expect(harvest?.hits[0]).toEqual({
      title: '第一条',
      url: 'https://a.example/1',
      snippet: '摘要',
      source: '甲站',
      redirect: false,
    });
  });

  it('形状不对时返回 null（调用方据此退回整页正文）', () => {
    expect(normalizeHarvest(null, 'bing')).toBeNull();
    expect(normalizeHarvest({ value: 1 }, 'bing')).toBeNull();
    expect(normalizeHarvest({ hits: '不是数组' }, 'bing')).toBeNull();
  });

  it('搜狗/百度的跳转链接标出来，Bing 的真地址不会', () => {
    expect(isRedirectLink('bing', 'https://www.sogou.com/link?url=x')).toBe(false);
    expect(isRedirectLink('sogou', 'https://www.sogou.com/link?url=x')).toBe(true);
    expect(isRedirectLink('sogou', 'https://zhuanlan.zhihu.com/p/1')).toBe(false);
    expect(isRedirectLink('baidu', 'http://www.baidu.com/link?url=x')).toBe(true);
    expect(isRedirectLink('baidu', 'https://baike.baidu.com/item/x')).toBe(false);
  });
});

describe('搜索：回执', () => {
  const harvest = {
    anchors: 10,
    title: '怎么挑机械键盘 - 搜索',
    url: 'https://cn.bing.com/search?q=x',
    hits: [
      { title: '机械键盘推荐：青轴、红轴怎么选 - 知乎', url: 'https://zhuanlan.zhihu.com/p/257307801', snippet: '一句话摘要', source: '知乎专栏', redirect: false },
      { title: '入门指南', url: 'https://sspai.com/post/64972', snippet: '', source: '', redirect: false },
    ],
  };

  it('每条都给标题、地址与摘要，并说清用 browser_open 按地址开', () => {
    const text = renderSearch('bing', '怎么挑机械键盘', harvest, { target: 'T9' });
    expect(text).toContain('搜索「怎么挑机械键盘」（Bing 国内版）：2 条');
    expect(text).toContain('1. 机械键盘推荐：青轴、红轴怎么选 - 知乎');
    expect(text).toContain('https://zhuanlan.zhihu.com/p/257307801');
    expect(text).toContain('[知乎专栏] 一句话摘要');
    expect(text).toContain('target T9');
    expect(text).toContain('别去点结果页上的链接');
    // Bing 给的是真地址，不该出现跳转链接那句提醒。
    expect(text).not.toContain('跳转链接');
  });

  it('跳转链接的引擎：逐条标出来，并在末尾说清看不到真域名', () => {
    const text = renderSearch(
      'sogou',
      '机械键盘',
      {
        anchors: 8,
        title: '搜狗搜索',
        url: 'https://www.sogou.com/web?query=x',
        hits: [{ title: '一篇讲键盘的', url: 'https://www.sogou.com/link?url=abc', snippet: '', source: '', redirect: true }],
      },
      { target: 'T3' },
    );
    expect(text).toContain('（跳转链接）');
    expect(text).toContain('看不出是哪个站点');
  });

  it('百度那一家会把「标题里有反爬噪声」这条一起说出去', () => {
    const text = renderSearch(
      'baidu',
      '机械键盘',
      {
        anchors: 5,
        title: '百度搜索',
        url: 'https://www.baidu.com/s?wd=x',
        hits: [{ title: '机械键!盘选购:指南', url: 'http://www.baidu.com/link?url=x', snippet: '', source: '', redirect: true }],
      },
      { target: 'T6' },
    );
    expect(text).toContain('噪声字符');
    expect(text).toContain('（跳转链接）');
  });

  it('一条都没抽出来：说清是哪种没命中，并把整页正文附在末尾', () => {
    const text = renderSearch(
      'bing',
      '机械键盘',
      { anchors: 0, title: '验证', url: 'https://cn.bing.com/verify', hits: [] },
      { target: 'T4', fallbackText: '请完成下列验证' },
    );
    expect(text).toContain('一条都没抽出来');
    expect(text).toContain('换了页面结构');
    expect(text).toContain('请完成下列验证');
  });

  it('有锚点但没能组成条目时，回执说清是「候选有、条目没有」', () => {
    const text = renderSearch('bing', '机械键盘', { anchors: 12, title: 'x', url: 'u', hits: [] }, { target: 'T5' });
    expect(text).toContain('12 个候选');
  });
});
