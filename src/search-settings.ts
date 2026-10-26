import type { ConfigGroup } from 'cortico/core/types.ts';
import { isSearchEngineId, type SearchEngineId } from './search.ts';

export const SEARCH_PROVIDERS = ['deepseek', 'tavily', 'bing', 'sogou', 'baidu', 'google'] as const;
export type SearchProviderId = typeof SEARCH_PROVIDERS[number];
export type ApiSearchProviderId = 'deepseek' | 'tavily';
export const SEARCH_LABELS: Record<SearchProviderId, string> = {
  deepseek: 'DeepSeek', tavily: 'Tavily', bing: 'Bing 国内版', sogou: '搜狗', baidu: '百度', google: 'Google',
};
export const SEARCH_SECRETS: Record<ApiSearchProviderId, string> = {
  deepseek: 'CORTICO_BROWSER_DEEPSEEK_API_KEY', tavily: 'CORTICO_BROWSER_TAVILY_API_KEY',
};

export interface BrowserSearchConfig {
  /** 空串沿用旧 searchEngine；保存排序后为逗号分隔的引擎 id。 */
  order: string;
  fallbackEnabled: boolean;
  deepseek: { enabled: boolean };
  tavily: { enabled: boolean; searchDepth: 'basic' | 'advanced' };
  bing: { enabled: boolean };
  sogou: { enabled: boolean };
  baidu: { enabled: boolean };
  google: { enabled: boolean };
}

export const SEARCH_DEFAULTS: BrowserSearchConfig = {
  order: '', fallbackEnabled: false,
  deepseek: { enabled: true }, tavily: { enabled: true, searchDepth: 'basic' },
  bing: { enabled: true }, sogou: { enabled: true }, baidu: { enabled: true }, google: { enabled: true },
};

export function isSearchProvider(value: string): value is SearchProviderId {
  return SEARCH_PROVIDERS.some(id => id === value);
}

export function providerOrder(order: string, legacy: SearchEngineId): SearchProviderId[] {
  const selected = order.trim() ? order.split(',').map(id => id.trim()).filter(isSearchProvider) : [legacy];
  return [...new Set([...selected, ...SEARCH_PROVIDERS])];
}

export function isPageProvider(id: SearchProviderId): id is SearchEngineId {
  return isSearchEngineId(id);
}

export const SEARCH_CONFIG_GROUP: ConfigGroup = {
  id: 'world:browser:search', owner: 'world:browser',
  schema: { type: 'object', title: '网页搜索与抓取', properties: {
    'worlds.browser.search.order': {
      type: 'string', title: '引擎顺序',
      description: '在「搜索设置」面板拖拽排序。逗号分隔 deepseek、tavily、bing、sogou、baidu、google；空白沿用旧默认引擎。', 'x-hot': true,
    },
    'worlds.browser.search.fallbackEnabled': {
      type: 'boolean', title: '失败后自动切换', description: '超时、限流或服务不可用时按顺序切换。无结果、密钥无效、余额不足或主动取消时停止。', 'x-hot': true,
    },
    ...Object.fromEntries(SEARCH_PROVIDERS.map(id => [`worlds.browser.search.${id}.enabled`, {
      type: 'boolean' as const, title: `启用 ${SEARCH_LABELS[id]}`, 'x-hot': true,
    }])),
    'worlds.browser.search.tavily.searchDepth': {
      type: 'string', title: 'Tavily 搜索深度', enum: ['basic', 'advanced'],
      description: 'advanced 使用更多额度；仅对 Tavily 生效。', 'x-hot': true,
    },
  } },
};

export interface SearchSettingsState {
  order: SearchProviderId[];
  enabled: Record<SearchProviderId, boolean>;
  configured: Record<ApiSearchProviderId, boolean>;
  fallbackEnabled: boolean;
  tavilySearchDepth: 'basic' | 'advanced';
}
