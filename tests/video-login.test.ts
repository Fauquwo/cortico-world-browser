import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieJar, QrLogin } from '../src/video/login.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('QR sign-in into the shared Browser profile', () => {
  it('applies confirmed cookies and then clears the temporary in-memory jar', async () => {
    const jar = new CookieJar();
    const applied: string[] = [];
    const qr = new QrLogin({jar,onAuthorized:async cookies => {applied.push(...cookies.map(c=>c.name));},fetchImpl:async input => {
      if (String(input).includes('generate')) return Response.json({code:0,data:{url:'https://example.test/qr',qrcode_key:'synthetic'}});
      return Response.json({data:{code:0,url:'https://example.test/confirm?SESSDATA=synthetic&DedeUserID=1'}});
    }});
    await qr.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(qr.current.status).toBe('authorized');
    expect(applied).toContain('SESSDATA');
    expect(jar.load()).toEqual([]);
    qr.stop();
  });

  it('ignores confirmation arriving after stop', async () => {
    const jar = new CookieJar();
    let release!: (response:Response) => void;
    let applied = false;
    const qr = new QrLogin({jar,onAuthorized:async () => {applied=true;},fetchImpl:async input => {
      if (String(input).includes('generate')) return Response.json({code:0,data:{url:'https://example.test/qr',qrcode_key:'synthetic'}});
      return new Promise<Response>(resolve => {release=resolve;});
    }});
    await qr.start();
    await vi.advanceTimersByTimeAsync(2000);
    qr.stop();
    release(Response.json({data:{code:0,url:'https://example.test/confirm?SESSDATA=synthetic'}}));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toBe(false);
    expect(jar.load()).toEqual([]);
  });

  it('does not report authorization when applying cookies to Chrome fails', async () => {
    const jar = new CookieJar();
    const qr = new QrLogin({jar,onAuthorized:async () => {throw new Error('browser disconnected');},fetchImpl:async input => {
      if (String(input).includes('generate')) return Response.json({code:0,data:{url:'https://example.test/qr',qrcode_key:'synthetic'}});
      return Response.json({data:{code:0,url:'https://example.test/confirm?SESSDATA=synthetic'}});
    }});
    await qr.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(qr.current).toMatchObject({status:'error',detail:expect.stringContaining('browser disconnected')});
    expect(jar.load()).toEqual([]);
    qr.stop();
  });
});
