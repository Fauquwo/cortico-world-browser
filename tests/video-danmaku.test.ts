import { describe, expect, it } from 'vitest';
import { DanmakuPool, decodeDanmakuSegment, parseSubtitle, spread, subtitlesBetween } from '../src/video/danmaku.ts';
import { cookiesFromConfirmUrl, parseSetCookie } from '../src/video/login.ts';

/* minimal protobuf writer for fixtures */
function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
function field(no: number, wire: 0 | 2, payload: number[]): number[] {
  return [...varint((no << 3) | wire), ...(wire === 2 ? varint(payload.length) : []), ...payload];
}
function elem(id: number, progressMs: number, mode: number, content: string): number[] {
  const bytes = [...field(1, 0, varint(id)), ...field(2, 0, varint(progressMs)), ...field(3, 0, varint(mode)), ...field(7, 2, [...Buffer.from(content, 'utf8')])];
  return field(1, 2, bytes);
}

describe('decodeDanmakuSegment', () => {
  it('reads id, time and text of each element and skips what has no text', () => {
    const seg = new Uint8Array([...elem(11, 1500, 1, '郭麒麟?'), ...elem(12, 61000, 5, '前方高能'), ...field(1, 2, [...field(2, 0, varint(99))])]);
    const list = decodeDanmakuSegment(seg);
    expect(list).toEqual([
      { id: '11', t: 1.5, mode: 1, content: '郭麒麟?' },
      { id: '12', t: 61, mode: 5, content: '前方高能' },
    ]);
  });

  it('returns nothing for bytes that are not a segment', () => {
    expect(decodeDanmakuSegment(new Uint8Array([0xff, 0xff]))).toEqual([]);
  });
});

describe('DanmakuPool', () => {
  it('merges by id and answers time windows and per-minute counts', () => {
    const pool = new DanmakuPool();
    expect(pool.add([{ id: 'a', t: 5, mode: 1, content: 'x' }, { id: 'b', t: 70, mode: 1, content: 'y' }])).toBe(2);
    expect(pool.add([{ id: 'a', t: 5, mode: 1, content: 'x' }, { id: 'c', t: 130, mode: 1, content: 'z' }])).toBe(1);
    expect(pool.between(0, 70).map((d) => d.id)).toEqual(['a', 'b']);
    expect(pool.between(5, 130).map((d) => d.id)).toEqual(['b', 'c']);
    expect(pool.perMinute()).toEqual([1, 1, 1]);
  });
});

describe('subtitles', () => {
  it('parses the body shape and picks overlapping lines', () => {
    const lines = parseSubtitle({ body: [{ from: 1, to: 3, content: 'a' }, { from: 3.5, to: 6, content: 'b' }, { from: 'x', to: 1, content: 'bad' }] });
    expect(lines.length).toBe(2);
    expect(subtitlesBetween(lines, 2.9, 4).map((l) => l.content)).toEqual(['a', 'b']);
    expect(subtitlesBetween(lines, 6, 9)).toEqual([]);
    expect(parseSubtitle(null)).toEqual([]);
  });

  it('spread keeps order and picks evenly', () => {
    expect(spread([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 3, 5]);
    expect(spread([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('cookies', () => {
  it('parses Set-Cookie attributes and the confirm URL fallback', () => {
    const c = parseSetCookie('SESSDATA=abc%2C1; Path=/; Domain=bilibili.com; Expires=Wed, 08 Apr 2027 00:00:00 GMT; HttpOnly; Secure');
    expect(c).toMatchObject({ name: 'SESSDATA', value: 'abc%2C1', domain: '.bilibili.com', path: '/', httpOnly: true, secure: true });
    expect(c?.expires).toBe(Math.floor(Date.parse('Wed, 08 Apr 2027 00:00:00 GMT') / 1000));
    expect(parseSetCookie('nonsense')).toBeNull();
    const fromUrl = cookiesFromConfirmUrl('https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=1&SESSDATA=s&bili_jct=j&gourl=https%3A%2F%2Fwww.bilibili.com');
    expect(fromUrl.map((x) => x.name).sort()).toEqual(['DedeUserID', 'SESSDATA', 'bili_jct']);
  });
});
