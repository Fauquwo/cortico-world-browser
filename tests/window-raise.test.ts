import { describe, expect, it } from 'vitest';
import { raiseBrowserWindow, raiseSentence } from '../src/window-raise.ts';

/**
 * 这几条钉的是"回执有没有说实话"。
 *
 * 抬窗口那一段（PowerShell + P/Invoke）在单测里跑不了——它要开一个进程、还要一台真的 Windows
 * 桌面；那一段由实机冒烟覆盖（见 `scripts/smoke.ts` 的 `--own` 那条路）。这里钉的是**话术的映射**：
 * 四种结局各自该说成什么，尤其"没抬上去"绝不能写成"他看得见了"（2026-10-02 之前就是这么栽的）。
 */
describe('browser_focus 的回执话术', () => {
  it('抬上去了：说清他看得见，并点名他刚才在用什么', () => {
    const text = raiseSentence({
      attempted: true,
      ok: true,
      aboveForeground: true,
      why: '',
      foregroundTitle: 'ZCode',
    });
    expect(text).toContain('已经抬到他正在用的程序之上');
    expect(text).toContain('ZCode');
    expect(text).toContain('他现在看得见');
  });

  it('抬过了但盖不住前台：说清可能是独占全屏，并给出截图这条退路', () => {
    const text = raiseSentence({
      attempted: true,
      ok: true,
      aboveForeground: false,
      why: '',
      foregroundTitle: '某游戏',
    });
    expect(text).toContain('没能盖住');
    expect(text).toContain('某游戏');
    expect(text).toContain('独占全屏');
    expect(text).toContain('browser_shot');
    expect(text).not.toContain('他现在看得见');
  });

  it('抬不成（没找到窗口）：给出退路，不说他看得见', () => {
    const text = raiseSentence({ attempted: true, ok: false, aboveForeground: false, why: 'no-window', foregroundTitle: '' });
    expect(text).toContain('抬窗口没成');
    expect(text).toContain('no-window');
    expect(text).toContain('browser_shot');
  });

  it('没去抬（不是 Windows / 没拿到进程号）：也要说出来，别让人以为抬过了', () => {
    const text = raiseSentence({
      attempted: false,
      ok: false,
      aboveForeground: false,
      why: '这台机器不是 Windows，抬窗口这一步只有 Windows 上做了',
      foregroundTitle: '',
    });
    expect(text).toContain('没能抬到别的程序上面');
    expect(text).toContain('不是 Windows');
    expect(text).not.toContain('他现在看得见');
  });

  it('连结果都没有（老调用点没带这一项）：按"没抬"说', () => {
    const text = raiseSentence(undefined);
    expect(text).toContain('没能抬到别的程序上面');
  });
});

describe('raiseBrowserWindow 的前置检查', () => {
  it('没拿到进程号时不当场去开 PowerShell，直接把原因说清', async () => {
    const result = await raiseBrowserWindow({ pid: 0, titleLike: '某页' });
    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.why).toContain('进程号');
  });

  it('没读到页面标题时不猜窗口，也把原因说清', async () => {
    const result = await raiseBrowserWindow({ pid: 4242, titleLike: '   ' });
    expect(result.attempted).toBe(false);
    expect(result.why).toContain('标题');
  });
});
