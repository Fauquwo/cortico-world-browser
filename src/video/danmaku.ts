/**
 * The video's own danmaku and subtitles, as the player loads them: danmaku segments arrive as
 * protobuf `DmSegMobileReply` bodies (field 1 repeated `DanmakuElem`: 1 id, 2 progress ms,
 * 3 mode, 7 content, 9 weight); subtitles as JSON `{ body: [{ from, to, content }] }` in seconds.
 */
import { pbDecode, pbInt, pbText } from './pb.ts';

export interface Danmaku {
  id: string;
  /** Video time in seconds. */
  t: number;
  mode: number;
  content: string;
}

export interface SubtitleLine {
  from: number;
  to: number;
  content: string;
}

/** Decodes one segment body; unreadable input yields an empty list. */
export function decodeDanmakuSegment(bytes: Uint8Array): Danmaku[] {
  const fields = pbDecode(bytes);
  if (!fields) return [];
  const out: Danmaku[] = [];
  for (const f of fields) {
    if (f.field !== 1 || !f.bytes) continue;
    const e = pbDecode(f.bytes);
    const content = pbText(e, 7);
    if (!content) continue;
    const id = pbInt(e, 1);
    const progress = pbInt(e, 2) ?? 0;
    out.push({ id: id === undefined ? `${progress}:${content}` : String(id), t: progress / 1000, mode: pbInt(e, 3) ?? 1, content });
  }
  return out;
}

/** Parses a subtitle file; anything but the documented shape yields an empty list. */
export function parseSubtitle(json: unknown): SubtitleLine[] {
  const body = (json as { body?: unknown })?.body;
  if (!Array.isArray(body)) return [];
  const out: SubtitleLine[] = [];
  for (const row of body) {
    const r = row as { from?: unknown; to?: unknown; content?: unknown };
    if (typeof r.from !== 'number' || typeof r.to !== 'number' || typeof r.content !== 'string') continue;
    out.push({ from: r.from, to: r.to, content: r.content });
  }
  return out;
}

/** Danmaku of one video, merged by id across the segments the player fetches. */
export class DanmakuPool {
  private readonly byId = new Map<string, Danmaku>();
  private sorted: Danmaku[] | null = null;

  add(list: readonly Danmaku[]): number {
    let fresh = 0;
    for (const d of list) {
      if (this.byId.has(d.id)) continue;
      this.byId.set(d.id, d);
      fresh++;
    }
    if (fresh) this.sorted = null;
    return fresh;
  }

  get size(): number { return this.byId.size; }

  clear(): void { this.byId.clear(); this.sorted = null; }

  /** Danmaku with `t` in `(from, to]`, by time. */
  between(from: number, to: number): Danmaku[] {
    this.sorted ??= [...this.byId.values()].sort((a, b) => a.t - b.t);
    return this.sorted.filter((d) => d.t > from && d.t <= to);
  }

  /** Count per minute, index = minute. */
  perMinute(): number[] {
    const out: number[] = [];
    for (const d of this.byId.values()) {
      const m = Math.floor(d.t / 60);
      out[m] = (out[m] ?? 0) + 1;
    }
    for (let i = 0; i < out.length; i++) out[i] ??= 0;
    return out;
  }
}

/** Subtitle lines overlapping `(from, to]`. */
export function subtitlesBetween(lines: readonly SubtitleLine[], from: number, to: number): SubtitleLine[] {
  return lines.filter((l) => l.to > from && l.from <= to);
}

/** Picks up to `max` lines spread evenly over a list, keeping order. */
export function spread<T>(list: readonly T[], max: number): T[] {
  if (list.length <= max) return [...list];
  if (max <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.floor((i * list.length) / max)]);
  return out;
}
