/**
 * 把她的窗口抬到"他屏幕上别的程序之上"。
 *
 * 为什么需要这一步（2026-10-02 当场量的，量法见设计记录）：`browser_focus` 原来只做两件事
 * ——`Browser.setWindowBounds` 把窗口从屏幕外搬回屏幕内、`Target.activateTarget` 让它成为
 * 自己窗口里选中的那个 tab。**这两件都不改 z 序**：窗口回到 (90,70) 之后仍然压在他正在用的
 * 程序底下（量到：她的窗口 z 序 35，他的前台窗口 30），所以他看不见——她（和回执）却以为
 * 已经搬到他眼前了。这就是"她给我看，但我看不到"的实底。
 *
 * 靠 CDP 解决不了：13 个上游端点里没有抬窗口的口，`Browser.*` 域也没有 z 序/置顶这一项。
 * 所以这一步走出进程，让 Windows 自己来：
 *
 *   1. `SetWindowPos(HWND_TOPMOST)` —— 走到**所有**窗口之上（含那个占着屏幕的程序）；
 *   2. 紧接着 `SetWindowPos(HWND_NOTOPMOST)` —— 摘掉置顶，但按 Win32 的定义这一步会把它
 *      放在"普通层的最上面"，于是它仍然盖着他那个窗口，而**不会永久霸着最上层**
 *      （他点别的程序，那个程序自然又回到上面来）。
 *
 * **不调 `SetForegroundWindow`**：那一句量到会被 Windows 的前台锁当场拒掉（返回 `false`），
 * 而窗口照样到了最上面——"看见"不需要焦点。再加上 `SWP_NOACTIVATE`（不带它时 `SetWindowPos`
 * 会顺手激活窗口）。但**"不抢焦点"不是保证**：带上旗子之后专门量了三轮（前台全程是他的窗口），
 * 随后一次完整冒烟里前台还是落到了她那儿。我们做的是 z 序，不是"绝不打扰"。
 *
 * 量与抬都在同一个 PowerShell 进程里做完，回执里带**抬完之后的真实相对位置**——失败了就说
 * 失败，不写"他已经看得见了"这种话（上一版就是这么写的，而他看不到）。
 */
import { spawn } from 'node:child_process';

/** 抬窗口这一步的结果。`ok` 为真只代表"它真的在了前台窗口之上"，不是"命令发出去了"。 */
export interface RaiseResult {
  /** 真的去抬了吗（不是 Windows / 没拿到进程号时是 false）。 */
  attempted: boolean;
  /** 窗口找着了、也抬过了。 */
  ok: boolean;
  /** 抬完之后，她的窗口盖在**当前前台窗口**之上吗。这才是"他能不能看见"。 */
  aboveForeground: boolean;
  /** 抬不起来时的原因（人话；脚本里那些短码在 `WHY_IN_WORDS` 里换成说法）。成功时是空串。 */
  why: string;
  /** 抬完那一刻的前台窗口标题（回执里用来点名"挡着的是谁"）。 */
  foregroundTitle: string;
}

/** PowerShell 那一趟的上限。含一次 P/Invoke 编译（本机量到约 950 毫秒）。 */
const RAISE_TIMEOUT_MS = 12000;

/**
 * 脚本本体。通过 `-EncodedCommand` 交给 PowerShell，参数走环境变量——页面标题里可能带引号、
 * 反斜杠，拼进命令行迟早出事，走环境变量就不用逃逸。
 */
const RAISE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CorticoRaiseW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@ | Out-Null

$targetPid = [int]$env:CORTICO_RAISE_PID
$titleLike = [string]$env:CORTICO_RAISE_TITLE
# SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW|SWP_NOACTIVATE。
# 最后那面旗是量出来的：不带它的时候，SetWindowPos 会**顺手把这个窗口激活**（两次冒烟里有一次
# 前台就变成了她自己那个窗口）。带上是"只改 z 序、不动激活"。三轮专门量的都没抢焦点，
# 但一次完整冒烟里还是抢到了——所以这是"少抢"，不是"不抢"。
$swp = 0x0002 -bor 0x0001 -bor 0x0040 -bor 0x0010
$topmost = [IntPtr]::new(-1)
$notTopmost = [IntPtr]::new(-2)

function Get-Text([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][CorticoRaiseW]::GetWindowTextW($h, $sb, 512)
  $sb.ToString()
}
function Get-Class([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][CorticoRaiseW]::GetClassNameW($h, $sb, 256)
  $sb.ToString()
}

# 找她那个窗口：同一个进程、可见、类名是 Chrome 的窗口类。
# 优先标题里带这一页标题的那个（一个进程可能有好几个窗口，例如"要恢复页面吗？"那种对话框）；
# 退路是这个进程第一个有标题的可见窗口——总比什么都不做强，但会写进回执的 why 里。
$found = [IntPtr]::Zero
$fallback = [IntPtr]::Zero
$h = [CorticoRaiseW]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  $p = 0
  [void][CorticoRaiseW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $targetPid -and [CorticoRaiseW]::IsWindowVisible($h) -and ((Get-Class $h) -like 'Chrome_WidgetWin*')) {
    $t = Get-Text $h
    if ($titleLike -ne '' -and $t.Contains($titleLike)) { $found = $h; break }
    if ($fallback -eq [IntPtr]::Zero -and $t -ne '') { $fallback = $h }
  }
  $h = [CorticoRaiseW]::GetWindow($h, 2)
}
if ($found -eq [IntPtr]::Zero) { $found = $fallback }
if ($found -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $false; aboveForeground = $false; why = 'no-window'; foregroundTitle = '' } | ConvertTo-Json -Compress
  exit 0
}

[void][CorticoRaiseW]::SetWindowPos($found, $topmost, 0, 0, 0, 0, $swp)
Start-Sleep -Milliseconds 120
[void][CorticoRaiseW]::SetWindowPos($found, $notTopmost, 0, 0, 0, 0, $swp)
Start-Sleep -Milliseconds 80

# 抬完就量：她在前台窗口之上吗？从 z 序链数下标，小的在上面。
$fg = [CorticoRaiseW]::GetForegroundWindow()
$mine = -1
$front = -1
$i = 0
$h = [CorticoRaiseW]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ($h -eq $found) { $mine = $i }
  if ($h -eq $fg) { $front = $i }
  $h = [CorticoRaiseW]::GetWindow($h, 2)
  $i++
  if ($mine -ge 0 -and $front -ge 0) { break }
}
$above = ($mine -ge 0) -and (($front -lt 0) -or ($mine -le $front))
[pscustomobject]@{
  ok = ($mine -ge 0)
  aboveForeground = $above
  why = ''
  foregroundTitle = (Get-Text $fg)
} | ConvertTo-Json -Compress
`;

/** 抬她的窗口。任何一层出问题都只返回结果，不抛错——抬不成不该把 browser_focus 判成失败。 */
export async function raiseBrowserWindow(opts: {
  pid: number;
  /** 页面标题；用来在同一个浏览器的多个窗口里认出"这一页在的那个"。 */
  titleLike: string;
  timeoutMs?: number;
}): Promise<RaiseResult> {
  const skipped = (why: string): RaiseResult => ({
    attempted: false,
    ok: false,
    aboveForeground: false,
    why,
    foregroundTitle: '',
  });

  if (process.platform !== 'win32') {
    return skipped('这台机器不是 Windows，抬窗口这一步只有 Windows 上做了');
  }
  if (!Number.isFinite(opts.pid) || opts.pid <= 0) {
    return skipped('没读到浏览器进程号（SystemInfo.getProcessInfo 没回话）');
  }
  if (!opts.titleLike.trim()) {
    return skipped('没读到这一页的标题，认不出该抬哪个窗口');
  }

  const encoded = Buffer.from(RAISE_SCRIPT, 'utf16le').toString('base64');
  const timeoutMs = opts.timeoutMs ?? RAISE_TIMEOUT_MS;

  return await new Promise<RaiseResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: RaiseResult) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 关不掉无所谓，它自己会退
      }
      resolve(result);
    };

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, CORTICO_RAISE_PID: String(opts.pid), CORTICO_RAISE_TITLE: opts.titleLike },
        windowsHide: true,
      },
    );

    const timer = setTimeout(
      () => done({ attempted: true, ok: false, aboveForeground: false, why: '抬窗口那一步超时了', foregroundTitle: '' }),
      timeoutMs,
    );

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ attempted: true, ok: false, aboveForeground: false, why: `起不了 PowerShell：${err.message}`, foregroundTitle: '' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = parseRaiseOutput(stdout);
      if (!parsed) {
        const detail = (stderr.trim() || stdout.trim() || '没有输出').split('\n')[0].slice(0, 160);
        done({ attempted: true, ok: false, aboveForeground: false, why: `PowerShell 没回可读的结果：${detail}`, foregroundTitle: '' });
        return;
      }
      done({ attempted: true, ...parsed });
    });
  });
}

/** 脚本里那些短原因码要说成人话——回执是给她（和调试的我）读的。 */
const WHY_IN_WORDS: Record<string, string> = {
  'no-window': '没找到她那个浏览器窗口（这一页的标题可能已经变了，或者窗口被关掉了）',
};

/** 从 PowerShell 的输出里挑出那行 JSON（前面可能有别的噪声行）。导出只为让单测能钉住这里的映射。 */
export function parseRaiseOutput(stdout: string): Omit<RaiseResult, 'attempted'> | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (const line of lines.reverse()) {
    try {
      const raw = JSON.parse(line) as { ok?: unknown; aboveForeground?: unknown; why?: unknown; foregroundTitle?: unknown };
      const why = typeof raw.why === 'string' ? raw.why : '';
      return {
        ok: raw.ok === true,
        aboveForeground: raw.aboveForeground === true,
        why: why === '' ? '' : (WHY_IN_WORDS[why] ?? why),
        foregroundTitle: typeof raw.foregroundTitle === 'string' ? raw.foregroundTitle : '',
      };
    } catch {
      // 这一行不是 JSON，接着看上一行
    }
  }
  return null;
}

/**
 * 给回执的那句话：她（和调试的我）要能一眼看出"他到底看不看得见"。
 *
 * 这里是**纯函数**：真实抬窗口那一段要开 PowerShell，跑不进单测；把话术单独拎出来，
 * 四种结局都能钉住。
 */
export function raiseSentence(result: RaiseResult | undefined): string {
  if (!result || (!result.attempted && !result.ok)) {
    const why = result?.why ? `（${result.why}）` : '';
    return `窗口只搬回了屏幕内，没能抬到别的程序上面${why}——他可能看不到：可以让他 Alt+Tab，或者用 browser_shot 截图发给他。`;
  }
  if (result.ok && result.aboveForeground) {
    const who = result.foregroundTitle ? `（他刚才在用「${result.foregroundTitle}」）` : '';
    return `并且已经抬到他正在用的程序之上${who}，他现在看得见。`;
  }
  if (result.ok && !result.aboveForeground) {
    const who = result.foregroundTitle ? `「${result.foregroundTitle}」` : '另一个程序';
    return (
      `窗口抬过了，但它没能盖住${who}——多半那个程序占的是整块屏幕（独占全屏），` +
      '这种情况谁的窗口都盖不上去。他可能看不到：可以让他 Alt+Tab，或者用 browser_shot 截图发给他。'
    );
  }
  return `抬窗口没成：${result.why || '原因不明'}——他可能看不到，用 browser_shot 截图发给他更稳。`;
}
