import { SEARCH_LABELS, type ApiSearchProviderId } from './search-settings.ts';

export class SearchApiError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

export interface SearchResult { title: string; url: string; summary: string; source: string }
export interface FetchResult { title: string; url: string; content: string }
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export function publicPageUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SearchApiError('url 必须是完整的 HTTP/HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) {
    throw new SearchApiError('url 必须是无账号密码的 HTTP/HTTPS 地址，最多 8192 字符。');
  }
  return url.href;
}

export class SearchApi {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async post(provider: ApiSearchProviderId, path: string, key: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const label = SEARCH_LABELS[provider];
    if (!key.trim()) throw new SearchApiError(`${label} 尚未配置 API key。`);
    const timed = AbortSignal.timeout(Math.max(100, Math.min(timeoutMs || 30000, 120000)));
    const combined = signal ? AbortSignal.any([signal, timed]) : timed;
    try {
      combined.throwIfAborted();
      const response = await this.request(`${provider === 'deepseek' ? 'https://api.deepseek.com/v1/tools' : 'https://api.tavily.com'}/${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: combined, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 ? '密钥无效' : response.status === 402 || response.status === 432 || response.status === 433 ? '余额或额度不足' : response.status === 429 ? '请求限流' : '请求失败';
        throw new SearchApiError(`${label} ${hint}（HTTP ${response.status}）。`, response.status === 408 || response.status === 429 || response.status >= 500);
      }
      // 限制正文读取大小，避免上游整页内容无限进入内存或模型上下文。
      const reader = response.body?.getReader();
      if (!reader) throw new SearchApiError(`${label} 返回空响应。`, true);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw new SearchApiError(`${label} 响应超过 4 MiB。`, true);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new SearchApiError(`${label} 返回了无效 JSON。`, true); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SearchApiError(`${label} 响应格式不正确。`, true);
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (signal?.aborted) throw new SearchApiError('操作已取消。');
      if (timed.aborted) throw new SearchApiError(`${label} 请求超时。`, true);
      if (error instanceof SearchApiError) throw error;
      // 不回显上游错误正文、请求头或底层异常，避免凭证进入日志和工具回执。
      throw new SearchApiError(`${label} 网络请求失败。`, true);
    }
  }

  async search(provider: ApiSearchProviderId, key: string, query: string, count: number, depth: 'basic' | 'advanced', timeoutMs: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const body = provider === 'deepseek' ? { query, count, need_content: false } : {
      query, max_results: count, search_depth: depth, include_answer: false, include_raw_content: false, auto_parameters: false,
    };
    const data = await this.post(provider, 'search', key, body, timeoutMs, signal);
    if (!Array.isArray(data.results)) throw new SearchApiError(`${SEARCH_LABELS[provider]} 缺少 results 数组。`, true);
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of data.results) {
      const row = record(item);
      let url: string;
      try { url = publicPageUrl(text(row.url)); } catch { continue; }
      if (!text(row.title).trim() || seen.has(url)) continue;
      seen.add(url);
      results.push({ title: text(row.title), url, summary: provider === 'deepseek' ? text(row.summary) || text(row.snippet) : text(row.content), source: text(row.site_name) || new URL(url).hostname });
      if (results.length >= count) break;
    }
    if (data.results.length && !results.length) throw new SearchApiError(`${SEARCH_LABELS[provider]} 未返回可用的结果条目。`, true);
    return results;
  }

  async fetchPage(provider: ApiSearchProviderId, key: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<FetchResult> {
    url = publicPageUrl(url);
    const data = await this.post(provider, provider === 'deepseek' ? 'fetch' : 'extract', key,
      provider === 'deepseek' ? { url } : { urls: [url], format: 'markdown', extract_depth: 'basic' }, timeoutMs, signal);
    if (provider === 'deepseek') {
      if (!text(data.content).trim()) throw new SearchApiError('DeepSeek 未返回网页正文。');
      return { title: text(data.title), url, content: text(data.content) };
    }
    const result = record(Array.isArray(data.results) ? data.results[0] : null);
    if (!text(result.raw_content).trim()) throw new SearchApiError('Tavily 未能抓取该网页；可用浏览器打开读取。');
    return { title: text(result.title), url, content: text(result.raw_content) };
  }
}
