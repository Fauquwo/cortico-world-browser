import { describe, expect, it } from 'vitest';
import type { RaiseResult } from '../src/window-raise.ts';
import { parseRaiseOutput, raiseBrowserWindow, raiseSentence } from '../src/window-raise.ts';

/** 一个"抬成了、没东西挡着"的结果，各条用例按需改几项。 */
const raised = (patch: Partial<RaiseResult> = {}): RaiseResult => ({
  attempted: true,
  ok: true,
  wasHidden: false,
  wasMinimized: false,
  windowTitle: '某个页面 - Google Chrome',
  windowRect: '90,70 1100x800',
  blockedBy: '',
  blockerTopmost: false,
  why: '',
  ...patch,
});

/**
 * 这几条钉的是"回执有没有说实话"。
 *
 * 抬窗口那一段（PowerShell + P/Invoke）在单测里跑不了——它要开进程、还要一张真的 Windows 桌面；
 * 那一段由实机冒烟覆盖。这里钉的是**话术的映射**，尤其"他看不见"的三种情形都不许写成"他看得见"
 * （2026-10-01 之前就是这么栽的：每一步都成功，回执写"他现在看得见"，而他屏幕上什么都没有）。
 */
describe('browser_focus 的回执话术', () => {
  it('抬上去了、上面没东西：说他看得见，并报出抬的是哪个窗口', () => {
    const text = raiseSentence(raised());
    expect(text).toContain('上面没有别的东西挡着');
    expect(text).toContain('他看得见');
    expect(text).toContain('某个页面');
  });

  it('被**置顶**窗口挡着（他的 pet 就是这种）：说清置顶盖不过去，并给出截图这条退路', () => {
    const text = raiseSentence(raised({ blockedBy: '她', blockerTopmost: true }));
    expect(text).toContain('「她」');
    expect(text).toContain('置顶');
    expect(text).toContain('盖不过去');
    expect(text).toContain('browser_shot');
    expect(text).not.toContain('他看得见');
  });

  it('被普通窗口挡着：照实说被挡住了', () => {
    const text = raiseSentence(raised({ blockedBy: '某编辑器' }));
    expect(text).toContain('某编辑器');
    expect(text).toContain('压在上面');
    expect(text).not.toContain('他看得见');
  });

  it('抬之前那窗口在操作系统那边是隐藏的：一并说明已显示出来（任务栏按钮也是这么回来的）', () => {
    const text = raiseSentence(raised({ wasHidden: true }));
    expect(text).toContain('隐藏');
    expect(text).toContain('任务栏');
  });

  it('抬之前那窗口最小化着：说清是先还原再抬的（她自己查出来的就是这一条）', () => {
    const text = raiseSentence(raised({ wasMinimized: true }));
    expect(text).toContain('最小化');
    expect(text).toContain('还原');
    expect(text).toContain('他看得见');
  });

  it('没找到窗口（位置标题都对不上）：不许退而求其次去抬别的窗口', () => {
    const text = raiseSentence(raised({ ok: false, windowTitle: '', why: '没找到她那个浏览器窗口（位置和标题都对不上，可能已被关掉）' }));
    expect(text).toContain('没能把它搬到他眼前');
    expect(text).toContain('没找到');
    expect(text).toContain('browser_shot');
    expect(text).not.toContain('他看得见');
  });

  it('没去抬（不是 Windows / 没拿到进程号或位置）：也要说出来', () => {
    const text = raiseSentence({
      attempted: false,
      ok: false,
      wasHidden: false,
      wasMinimized: false,
      windowTitle: '',
      windowRect: '',
      blockedBy: '',
      blockerTopmost: false,
      why: '这台机器不是 Windows，抬窗口这一步只有 Windows 上做了',
    });
    expect(text).toContain('没能抬到别的程序上面');
    expect(text).toContain('不是 Windows');
    expect(text).not.toContain('他看得见');
  });

  it('连结果都没有（老调用点没带这一项）：按"没抬"说', () => {
    expect(raiseSentence(undefined)).toContain('没能抬到别的程序上面');
  });
});

describe('raiseBrowserWindow 的前置检查：不猜，直接把原因说清', () => {
  const expectBox = { left: 90, top: 70, width: 1100, height: 800 };

  it('没拿到进程号时不当场去开 PowerShell', async () => {
    const result = await raiseBrowserWindow({ pid: 0, titleLike: '某页', expect: expectBox });
    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.why).toContain('进程号');
  });

  it('没读到窗口位置尺寸时也不猜', async () => {
    const result = await raiseBrowserWindow({ pid: 4242, titleLike: '某页', expect: { left: 90, top: 70, width: 0, height: 0 } });
    expect(result.attempted).toBe(false);
    expect(result.why).toContain('位置尺寸');
  });
});

describe('读 PowerShell 的回执', () => {
  it('短原因码说成人话，不当成噪声丢掉', () => {
    const parsed = parseRaiseOutput('{"ok":false,"why":"no-window"}');
    expect(parsed?.ok).toBe(false);
    expect(parsed?.why).toContain('没找到她那个浏览器窗口');
  });

  it('成功那条按原样收下来：标题、位置、挡着的是谁、是不是置顶', () => {
    const parsed = parseRaiseOutput(
      '{"ok":true,"why":"","wasHidden":true,"wasMinimized":false,"windowTitle":"甲 - Google Chrome","windowRect":"90,70 1100x800","blockedBy":"她","blockerTopmost":true}',
    );
    expect(parsed).toEqual({
      ok: true,
      wasHidden: true,
      wasMinimized: false,
      windowTitle: '甲 - Google Chrome',
      windowRect: '90,70 1100x800',
      blockedBy: '她',
      blockerTopmost: true,
      why: '',
    });
  });

  it('前面有别的噪声行（Add-Type 之类）时不慌，取最后那行 JSON', () => {
    const parsed = parseRaiseOutput('WARNING: 什么\n{"ok":true,"blockedBy":"","windowTitle":"甲"}');
    expect(parsed?.windowTitle).toBe('甲');
  });

  it('一行 JSON 都没有时返回 null，让调用方去说"没回可读的结果"', () => {
    expect(parseRaiseOutput('Exception calling "SetWindowPos"\n')).toBeNull();
  });
});
