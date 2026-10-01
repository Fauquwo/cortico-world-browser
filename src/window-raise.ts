/**
 * 把她的窗口抬到"他屏幕上别的程序之上"，并**如实说出他到底看不看得见**。
 *
 * 2026-10-01 当场量的（量法见设计记录，探针在 `state/tools/`）：
 *
 * - `browser_focus` 原来只做「窗口搬回屏幕内 + 激活」——**两件都不改 z 序**，所以窗口回到 (90,70)
 *   仍然压在他正在用的程序底下，而回执写着"他现在看得见"。CDP 里没有抬窗口这一手
 *   （上游 13 个端点没有，`Browser.*` 域也没有 z 序/置顶）⇒ 这一步只有操作系统做得了：
 *   `SetWindowPos(HWND_TOPMOST)` 再立刻 `(HWND_NOTOPMOST)`（先走到所有窗口之上，再落回普通层最上面；
 *   单发 `NOTOPMOST` 对本来就是普通层的窗口是空操作，顺序不能反）。
 * - 他的桌面上有一个**置顶**窗口（她那个 pet，`electron`，类名也是 `Chrome_WidgetWin_1`）。
 *   置顶窗口永远在普通窗口之上 ⇒ 「盖住当前前台窗口」这个判据是错的：pet 与她的窗口并不重叠时
 *   他明明看得见，却会被判成"没抬上去"。所以这里改成量**真正压在她这块矩形上的那个窗口**。
 * - 她的窗口还可能是**操作系统层面的"隐藏"**（`WS_VISIBLE` 关着，而 Chrome 自己认为是 normal）：
 *   那种窗口看不见、任务栏也没有按钮。所以认窗口**不要求可见**，并且抬之前先 `SW_SHOW`。
 * - 认窗口不能靠猜：`Target.getTargetInfo` 的标题只是"那一页"的标题，窗口标题可能不是它
 *   （多 tab、或刚建出来还没导航完）。所以从 CDP 把**窗口的位置尺寸**也带下来，位置对得上得 2 分、
 *   标题对得上得 1 分，分最高者胜；**一个都不对上就说"没找到"**，绝不退而求其次去抬一个别的窗口
 *   （那正是"整出一个啥都没有的背景板"最像的来源）。
 */
import { spawn } from 'node:child_process';

/** 她的窗口平时住的坐标（与 `ownBrowserArgs` 的 `--window-position` 一致）。 */
export const OFFSCREEN_LEFT = -32000;
export const OFFSCREEN_TOP = -32000;

/** 抬窗口这一步的结果。每个字段都是量出来的，不是推断出来的。 */
export interface RaiseResult {
  /** 真的去抬了吗（不是 Windows / 没拿到进程号或位置时是 false）。 */
  attempted: boolean;
  /** 窗口找着了吗（找着了才会去抬）。 */
  ok: boolean;
  /** 抬之前它是不是"操作系统层面的隐藏"（`WS_VISIBLE` 关着）。 */
  wasHidden: boolean;
  /** 抬之前它是不是最小化着（`IsIconic`）——最小化的窗口只有 `SW_RESTORE` 能还原。 */
  wasMinimized: boolean;
  /** 抬的是哪个窗口（标题，自证用）。 */
  windowTitle: string;
  /** 它现在的位置尺寸。 */
  windowRect: string;
  /** 此刻压在这块矩形之上、离它最近的那个窗口的标题（空串 = 没有东西挡着，他看得见）。 */
  blockedBy: string;
  /** 挡着的那个是不是置顶窗口（置顶的永远在所有普通窗口之上，我们盖不过去）。 */
  blockerTopmost: boolean;
  /** 没找着 / 抬不成时的人话原因；成功时是空串。 */
  why: string;
}

/** PowerShell 那一趟的上限。含一次 P/Invoke 编译（本机量到约 950 毫秒）。 */
const RAISE_TIMEOUT_MS = 15000;

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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@ | Out-Null

$targetPid = [int]$env:CORTICO_RAISE_PID
$titleLike = [string]$env:CORTICO_RAISE_TITLE
$wantL = [int]$env:CORTICO_RAISE_LEFT
$wantT = [int]$env:CORTICO_RAISE_TOP
$wantW = [int]$env:CORTICO_RAISE_W
$wantH = [int]$env:CORTICO_RAISE_H
# NOSIZE|NOMOVE|SHOWWINDOW|NOACTIVATE。最后那面旗是量出来的：不带它 SetWindowPos 会顺手激活窗口。
$swp = 0x0002 -bor 0x0001 -bor 0x0040 -bor 0x0010
$topmost = [IntPtr]::new(-1)
$notTopmost = [IntPtr]::new(-2)
$tol = 60

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
function Get-Rect([IntPtr]$h) {
  $r = New-Object CorticoRaiseW+RECT
  [void][CorticoRaiseW]::GetWindowRect($h, [ref]$r)
  return $r
}
function Hits([int]$x, [int]$y, [int]$w, [int]$hh, $r) {
  if ($w -le 0 -or $hh -le 0) { return $false }
  return -not ($r.R -le $x -or $r.L -ge ($x + $w) -or $r.B -le $y -or $r.T -ge ($y + $hh))
}

# 一、认窗口：同一个 pid、类名正好 Chrome_WidgetWin_1（带 _0 后缀那些是辅助窗口，排除）。
$best = [IntPtr]::Zero
$bestScore = 0
$h = [CorticoRaiseW]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  $p = 0
  [void][CorticoRaiseW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $targetPid -and (Get-Class $h) -eq 'Chrome_WidgetWin_1') {
    $score = 0
    $r = Get-Rect $h
    if ([Math]::Abs($r.L - $wantL) -le $tol -and [Math]::Abs($r.T - $wantT) -le $tol -and
        [Math]::Abs(($r.R - $r.L) - $wantW) -le $tol -and [Math]::Abs(($r.B - $r.T) - $wantH) -le $tol) { $score += 2 }
    if ($titleLike -ne '' -and (Get-Text $h).Contains($titleLike)) { $score += 1 }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $h }
  }
  $h = [CorticoRaiseW]::GetWindow($h, 2)
}
if ($best -eq [IntPtr]::Zero -or $bestScore -eq 0) {
  [pscustomobject]@{ ok = $false; why = 'no-window'; wasHidden = $false; windowTitle = ''; windowRect = ''; blockedBy = ''; blockerTopmost = $false } | ConvertTo-Json -Compress
  exit 0
}

$wasHidden = -not [CorticoRaiseW]::IsWindowVisible($best)
$wasMinimized = [CorticoRaiseW]::IsIconic($best)
$myTitle = Get-Text $best

# 二、还原 + 显示 + 抬。三步都要，缺一样他就看不见：
#   SW_RESTORE：最小化的窗口**只有这一步能还原**（SW_SHOW 对最小化窗口只是"显示（仍然最小化）"，
#               窗口还缩在任务栏里，抬 z 序也没用）。她自己查出来的就是这一条：
#               presence_windows 里那条写着"（最小化，位置不可用）"。
#   SW_SHOW   ：给"操作系统层面隐藏"（WS_VISIBLE 关着）那种窗口——连任务栏按钮都没有。
#   TOPMOST→NOTOPMOST：把 z 序抬到别的普通窗口之上（详见文件头）。
if ($wasMinimized) { [void][CorticoRaiseW]::ShowWindow($best, 9) }
[void][CorticoRaiseW]::ShowWindow($best, 5)
[void][CorticoRaiseW]::SetWindowPos($best, $topmost, 0, 0, 0, 0, $swp)
Start-Sleep -Milliseconds 130
[void][CorticoRaiseW]::SetWindowPos($best, $notTopmost, 0, 0, 0, 0, $swp)
Start-Sleep -Milliseconds 160

# 三、量：从 z 序最上面往下走，**第一个压在她这块矩形上的窗口**才是挡着她的那个（走到她自己就停）。
#     不拿"前台窗口"当判据：他的 pet 是置顶窗口，和她的窗口不重叠时他明明看得见。
$mine = Get-Rect $best
$skip = @('Shell_TrayWnd', 'Progman', 'WorkerW', 'XamlExplorerHostIslandWindow', 'ForegroundStaging',
          'IME', 'MSCTFIME UI', 'tooltips_class32', 'TaskListThumbnailWnd', 'SysShadow')
$blockedBy = ''
$blockerTopmost = $false
$h = [CorticoRaiseW]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ($h -eq $best) { break }
  if ([CorticoRaiseW]::IsWindowVisible($h) -and -not [CorticoRaiseW]::IsIconic($h)) {
    $cls = Get-Class $h
    if ($skip -notcontains $cls) {
      $r = Get-Rect $h
      if (Hits $mine.L $mine.T ($mine.R - $mine.L) ($mine.B - $mine.T) $r) {
        $t = Get-Text $h
        $blockedBy = if ($t -ne '') { $t } else { $cls }
        $blockerTopmost = (([CorticoRaiseW]::GetWindowLong($h, -20) -band 0x8) -ne 0)
        break
      }
    }
  }
  $h = [CorticoRaiseW]::GetWindow($h, 2)
}

[pscustomobject]@{
  ok             = $true
  why            = ''
  wasHidden      = $wasHidden
  wasMinimized   = $wasMinimized
  windowTitle    = $myTitle
  windowRect     = "$($mine.L),$($mine.T) $($mine.R - $mine.L)x$($mine.B - $mine.T)"
  blockedBy      = $blockedBy
  blockerTopmost = $blockerTopmost
} | ConvertTo-Json -Compress
`;

/** 从 PowerShell 的输出里挑出那行 JSON（前面可能有别的噪声行）。导出只为让单测能钉住这里的映射。 */
export function parseRaiseOutput(stdout: string): Omit<RaiseResult, 'attempted'> | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (const line of lines.reverse()) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const why = typeof raw.why === 'string' ? raw.why : '';
      return {
        ok: raw.ok === true,
        wasHidden: raw.wasHidden === true,
        wasMinimized: raw.wasMinimized === true,
        windowTitle: typeof raw.windowTitle === 'string' ? raw.windowTitle : '',
        windowRect: typeof raw.windowRect === 'string' ? raw.windowRect : '',
        blockedBy: typeof raw.blockedBy === 'string' ? raw.blockedBy : '',
        blockerTopmost: raw.blockerTopmost === true,
        why: why === '' ? '' : (WHY_IN_WORDS[why] ?? why),
      };
    } catch {
      // 这一行不是 JSON，接着看上一行
    }
  }
  return null;
}

/** 脚本里那些短原因码要说成人话——回执是给她（和调试的我）读的。 */
const WHY_IN_WORDS: Record<string, string> = {
  'no-window': '没找到她那个浏览器窗口（位置和标题都对不上，可能已被关掉）',
};

/**
 * 抬她的窗口。任何一层出问题都只返回结果，不抛错——抬不成不该把 browser_focus 判成失败。
 *
 * `expect` 是 CDP 那边刚给这个窗口设过的位置尺寸（`Browser.setWindowBounds` 之后读回来的），
 * 拿来在同一个浏览器的多个窗口里认出"这一页在的那个"。
 */
export async function raiseBrowserWindow(opts: {
  pid: number;
  /** 页面标题；用来在同一个浏览器的多个窗口里认出"这一页在的那个"。 */
  titleLike: string;
  expect: { left: number; top: number; width: number; height: number };
  timeoutMs?: number;
}): Promise<RaiseResult> {
  const skipped = (why: string): RaiseResult => ({
    attempted: false,
    ok: false,
    wasHidden: false,
    wasMinimized: false,
    windowTitle: '',
    windowRect: '',
    blockedBy: '',
    blockerTopmost: false,
    why,
  });

  if (process.platform !== 'win32') {
    return skipped('这台机器不是 Windows，抬窗口这一步只有 Windows 上做了');
  }
  if (!Number.isFinite(opts.pid) || opts.pid <= 0) {
    return skipped('没读到浏览器进程号（SystemInfo.getProcessInfo 没回话）');
  }
  const { left, top, width, height } = opts.expect;
  if (![left, top, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) {
    return skipped('没读到这个窗口的位置尺寸，认不出该抬哪个窗口');
  }

  const encoded = Buffer.from(RAISE_SCRIPT, 'utf16le').toString('base64');
  const timeoutMs = opts.timeoutMs ?? RAISE_TIMEOUT_MS;
  const env = {
    ...process.env,
    CORTICO_RAISE_PID: String(opts.pid),
    CORTICO_RAISE_TITLE: opts.titleLike,
    CORTICO_RAISE_LEFT: String(Math.round(left)),
    CORTICO_RAISE_TOP: String(Math.round(top)),
    CORTICO_RAISE_W: String(Math.round(width)),
    CORTICO_RAISE_H: String(Math.round(height)),
  };

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

    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env,
      windowsHide: true,
    });

    const timer = setTimeout(() => done(skipped('抬窗口那一步超时了')), timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(skipped(`起不了 PowerShell：${err.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = parseRaiseOutput(stdout);
      if (!parsed) {
        const detail = (stderr.trim() || stdout.trim() || '没有输出').split('\n')[0].slice(0, 160);
        done(skipped(`PowerShell 没回可读的结果：${detail}`));
        return;
      }
      done({ attempted: true, ...parsed });
    });
  });
}

/**
 * 给回执的那句话：她（和调试的我）要能一眼看出"他到底看不看得见"。
 *
 * 这里是**纯函数**：真实抬窗口那一段要开 PowerShell，跑不进单测；把话术单独拎出来，
 * 四种结局都能钉住。**"没抬上去"绝不能写成"他看得见了"**——上一版就是这么栽的。
 */
export function raiseSentence(result: RaiseResult | undefined): string {
  const shot = '用 browser_shot 截图发给他更稳';
  if (!result || (!result.attempted && !result.ok)) {
    const why = result?.why ? `（${result.why}）` : '';
    return `窗口只搬回了屏幕内，没能抬到别的程序上面${why}——他可能看不到，${shot}。`;
  }
  if (!result.ok) {
    return `没能把它搬到他眼前：${result.why || '原因不明'}——他可能看不到，${shot}。`;
  }
  const which = result.windowTitle ? `（抬的是「${result.windowTitle}」）` : '';
  const hiddenNote = result.wasHidden
    ? '它刚才在操作系统那边是"隐藏"的（那种窗口连任务栏都没有按钮），已经一并显示出来了。'
    : result.wasMinimized
      ? '它刚才在任务栏里是最小化着的，已经先还原、再抬上去。'
      : '';
  if (result.blockedBy === '') {
    return `它现在在他屏幕上、上面没有别的东西挡着${which}，他看得见。${hiddenNote}`;
  }
  const topmostNote = result.blockerTopmost
    ? '那个窗口是**置顶**的（永远在所有普通窗口之上），怎么抬都盖不过去。'
    : '它压在上面，我们抬不动它。';
  return (
    `窗口抬过了，但屏幕上还有「${result.blockedBy}」压在它上面${which}：${topmostNote}` +
    `${hiddenNote}他可能看不到，${shot}。`
  );
}
