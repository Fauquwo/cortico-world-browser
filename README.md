# cortico-world-browser

Owner: `src/definition.ts`

把本机 [web-access](https://github.com/eze-is/web-access) 的 CDP proxy 接成一个 World：
bot 能在浏览器里搜索、开页、读页、点击、填表、上传、滚动、截图，能查本机的书签与历史，
接的是操作员日常那个浏览器时还能自己看一眼他在干什么（拉取式，见下面的「事件」）。

两种接法：

- **借他日常那个浏览器**（默认）：带着他所有网站的登录态，页面开在后台 tab 里。`browser_close`
  只接受 bot 自己开的页面——关掉他自己开着的页面是不可逆的，机械上就该拦。
- **给她自己的实例**（`ownBrowser: true`）：本 World 拉起一个专属 Chrome（独立 profile 与调试端口），
  每个页面开在**它自己的窗口**里、窗口停在**屏幕外**——媒体照播，但操作员看不见、键盘焦点也不会被抢。
  她要打断他时才用 `browser_focus` 把某个页面搬到他眼前。代价是登录态不共享，要用的站点得在这个
  profile 里登一次。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`preflight` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现：起停、十四个工具、`console()` |
| `src/cdp-client.ts` | cdp-proxy 的客户端：起停子进程、HTTP 调用、`find-url.mjs` |
| `src/search.ts` | `browser_search` 的引擎表、抽取表达式与回执排版（纯函数，不带浏览器） |
| `src/own-browser.ts` | 她自己的实例：起停、写发现文件、直接说 CDP（建窗口 / 激活 / 搬窗口） |
| `src/window-raise.ts` | "搬到他眼前"的最后一步：抬 z 序（CDP 做不到，交给 Windows 的 `SetWindowPos`） |
| `src/page-scripts.ts` | 注入页面执行的 JS：读页（穿 Shadow DOM 与 iframe）、填表 |
| `src/ENV_PROMPT.md` | 环境提示词模板，占位符 `{{browser.label}}` / `{{browser.kind}}` / `{{browser.front}}` |
| `scripts/smoke.ts` | 开发用冒烟：对着真的 proxy 走一遍开页、读页、截图；`--own` 时含"能不能播"与"抬不抬得起来" |
| `tests/` | 干装载、起停、工具回执、变化聚合、专属实例、focus 回执话术；假 proxy 是一个真的 HTTP 服务 |

## 配置

`worlds.browser` 段。必填两项：`skillDir`（装了 web-access 的目录）与 `browser`
（`chrome` / `edge` / `chromium`，必须是你要操作的那一个）；漏填由 `preflight` 拦下。

上游那边要打开对应浏览器的远程调试开关：地址栏进 `chrome://inspect#remote-debugging`
（Edge 是 `edge://inspect#remote-debugging`），勾选「Allow remote debugging for this browser instance」。
没打开时 World 会投一条 `browser.down`，工具回失败并说明这一步——不是这个包坏了。

**给她自己的实例**时不用动任何开关，但要把这几项配齐（漏了 `preflight` 会逐条点名）：

| 项 | 填什么 |
|---|---|
| `ownBrowser` | `true` |
| `ownBrowserExe` | `chrome.exe` 的绝对路径（专属实例只拉 Chrome） |
| `ownBrowserHome` | 她的"家"目录。profile 落在 `<home>\Google\Chrome\User Data` |
| `ownBrowserPort` | 这个实例的调试端口，默认 `9223`（别和 9222 上的日常浏览器撞） |
| `bringToFront` | 默认 `true`：**允不允许她打断你**（把某个页面搬到你眼前）。这不是"页面能不能播"的开关——她的页面默认在屏幕外，媒体照样播 |
| `searchEngine` | `browser_search` 的默认引擎，默认 `bing`（国内版）。也可填 `sogou` / `baidu`；别填 Google 或 DuckDuckGo，这台机器上打不开。这一项是热的：改完下一次搜索就生效 |

为什么这样接：上游只从各浏览器**默认 profile** 的 `DevToolsActivePort` 找浏览器（现代 Chrome 用
`--remote-debugging-port` 启动时并不写这个文件），所以本 World 拉起 proxy 时把"家"当 `LOCALAPPDATA`
交给它，再由 `own-browser.ts` 把那个文件写在自己家里——上游据此认出这个实例（`/health` 里仍是
`Chrome`），而操作员日常那个浏览器**一行都不用改**。

`find-url.mjs` 查历史要 `sqlite3` 命令在 PATH 上；没有时它自己的报错会原样回到回执里。
（开了专属实例时，它查的是**她自己那个 profile** 的书签与历史。）

## 搜索（2026-10-12 加的）

她原话：「浏览器给我的是『打开这个地址、读正文』，没有『搜』这一步，主题一模糊我就只剩猜域名、翻站内导航两条路。」
`browser_search` 填的就是这一步：一次调用把关键词变成一批**地址**（标题 + 地址 + 一句摘要），她拿地址去 `browser_open`。

为什么不做成一个搜索 API：内置的 `websearch` World 只认 Brave 的密钥（部署里是关的），
而在这台机器的真 Chrome 里量到的现实是 —— **Google 与 DuckDuckGo 打不开**（`ERR_TIMED_OUT`），
能用的是 Bing 国内版、搜狗、百度。三个引擎的选择器是 2026-10-12 在真结果页上量出来的，不是照印象写的：

| 引擎 | 结果锚点 | 抽到几条 | 地址是 | 摘要 |
|---|---|---|---|---|
| Bing 国内版（默认） | `#b_results > li.b_algo h2 a` | 10 | **真地址** | `.b_caption p`，来源站名在 `.tptt` |
| 搜狗 | `h3 a` | 8 | `sogou.com/link?url=…` 跳转链接 | `.text-layout` / `.space-txt` |
| 百度 | `#content_left div.result h3 a` | 6 | `baidu.com/link?url=…` 跳转链接 | 有时在 `[class*=abstract]` |

跳转链接**直接打开**会落到真页（量过搜狗那条落到知乎文章），但地址上看不出站点；百度更差一点 ——
实测有跳转链接打开后落回百度自己的页。所以默认引擎是 Bing 国内版：只有它把真地址摆在回执里。
`worlds.browser.searchEngine` 改默认值，工具参数 `engine` 可以按次覆盖。

抽取写成「一串锚点选择器，第一个找得到东西的就用」，并留了退路：一条都没抽到时把整页正文交回去，
回执里说清是「引擎换了结构 / 给了验证页」，而不是让她以为搜索坏了。

## 点链接与「新开的那张页面」

结果页上的链接都是 `target=_blank`。2026-10-12 在她的实例里（独立窗口、屏幕外、`background: true`）量到：

| 怎么点 | 结果 |
|---|---|
| `browser_click` 默认（JS `el.click()`） | **新页面 0 个**，也不报错 |
| `browser_click` + `native: true`（CDP 真鼠标事件） | **新页面 1 个**，落的就是那条结果的真地址 |
| 用那条地址 `browser_open` | 一样到位 —— 所以搜索这条路根本不点 |

顺带补了一个洞：点击的旧回执只说原页面「点击后此刻」，新开出来的页面**一个字都不提**，
而它也不在她的页面表里 —— `browser_close` 拒关、闲置回收也扫不到。现在点完会比对一次页面表，
把新出现的写进回执；**专属实例里**（那个浏览器里没有别人）再顺手登记成她开的，于是能读、能关、闲置会被收。
借操作员日常那个浏览器时**不登记**：两次快照之间也可能有他自己开的东西，认成她的就会将来替她关掉它。


## 起停

先探 `GET /health`，通了就复用（操作员自己或他的 coding agent 已经在跑的情况下不重复拉起），
探不通才 spawn；`stop()` 只关自己拉起的那个。因此两份东西可以共用一个 proxy。
专属实例同一套：先探它的 `/json/version`，探得到就复用（顺手把发现文件刷新成它现在的 ws 路径），
探不到才拉起，`stop()` 同样只关自己拉起的。

起好之后还会**核对 proxy 连的确实是那个实例**（`/health` 的 `chromePort`）：端口上挂着一个连别处的
旧 proxy 时，当场投 `browser.down` 说清，而不是静默地去操作操作员的浏览器。

## 前台与后台（决定她会不会打扰你）

2026-10-01 在本机量到的。这里有三件**互相独立**的事，别混：**页面活不活**、**操作员看不看得见**、
**键盘焦点在谁那儿**。

| 怎么开这一页 | visibility | 媒体 | 抢键盘焦点 | 盖到他屏幕上 |
|---|---|---|---|---|
| 后台 tab（上游 `/new`） | hidden | **播不了**（`readyState` 停在 0） | 不抢 | 不盖 |
| 后台 tab + 调到前台（早些的实装） | visible | 能播 | **抢** | **盖** |
| 新窗口 + 不激活 | visible | 能播 | 不抢 | 盖（新窗口落在 z 序顶上） |
| **新窗口 + 屏幕外**（现在的默认） | **visible** | **能播** | **不抢** | **不盖** |

结论：媒体要的不是"前台"，而是"那个页面是它所在窗口里**被选中的那一个**"。所以她的每个页面开在
自己的窗口里（`Target.createTarget({ newWindow: true, background: true })`，不走上游 `/new`——
那个只建后台 tab），实例启动时带 `--window-position=-32000,-32000`，于是这些窗口都在屏幕外：
媒体照播、截图照截、不抢焦点、不挡他。

要打断他时才搬回来：`browser_focus` = `Browser.setWindowBounds`（回屏幕内）+ `Target.activateTarget`
+ 抬 z 序（下一节）。上游 13 个端点里没有前两个，所以 `own-browser.ts` 直连浏览器自己的 WebSocket
（Node 22 原生 `WebSocket`，不加依赖）。

## "搬到他眼前"里，抬窗口那一步（2026-10-01 加的）

2026-10-01 他报「她想展示到我屏幕上时，如果别的应用占着屏幕，我看不到 Chrome」。量到的实底：
上面那两件（`setWindowBounds` + `activateTarget`）**都不改 z 序**，所以窗口回到屏幕内之后仍然压在
他正在用的程序底下（z 序 35 对前台 30），而他拿到的回执写着「他现在看得见这个页面了」——**是回执
在说谎**。`Browser.*` 域里没有 z 序/置顶这一项，所以这一步走出进程（`src/window-raise.ts`）：

1. 按「同一个 PID + 类名 `Chrome_WidgetWin*` + 标题里含这一页的标题」认出她那个窗口
   （只看 PID 会把"要恢复页面吗？"那种对话框一起抬上来）；
2. `SetWindowPos(HWND_TOPMOST)` → `SetWindowPos(HWND_NOTOPMOST)`：先走到所有窗口（含占着屏幕的那个）
   之上，再落到**普通层的最上面**——看得见，但不会永久霸着最上层（他一点别的程序，那个程序回到上面）；
3. **不调 `SetForegroundWindow`**（量到它当场返回 `false`：Windows 的前台锁不认后台进程，而窗口照样
   到了最上面），并带上 `SWP_NOACTIVATE`（不带它时 `SetWindowPos` 会顺手激活窗口）。但**"不抢焦点"
   不是保证**：带旗子后专门量了三轮（前台全程是他的窗口），随后一次完整冒烟里前台还是落到了她那儿
   ——这一步做的是 z 序，不是"绝不打扰"；
4. 抬完当场量一次 z 序，回执按**量到的结果**说话：抬上去了才说「看得见」；被独占全屏那种程序挡住时
   直说，并让她改用 `browser_shot` 截图。

代价：这一步多花约 950 毫秒（一次 PowerShell + P/Invoke 编译）。只在 `browser_focus` 这条罕见路径上，
没去优化。

## 抬之前要先把窗口"还回来"（当天接着查出来的两件事）

1. **窗口可能是"操作系统层面的隐藏"**（`WS_VISIBLE` 关着，而 Chrome 自己认为是 `normal`）：
   那种窗口看不见、**任务栏连按钮都没有**。来历量到了：spawn 时带 `windowsHide: true` 会把 `SW_HIDE`
   经 STARTUPINFO 传给子进程，Chrome 的**第一个窗口**（启动那次、以及重启后恢复上次会话出来的那个）
   于是生来就是隐藏的。所以：**spawn 不带这面旗**（chrome.exe 是 GUI 程序，不隐藏也不会弹控制台），
   抬窗口那一步里再补一次 `SW_SHOW` 兜底。
2. **窗口可能是最小化着的**：`SW_SHOW` 对最小化窗口只是"显示（仍然最小化）"，只有 `SW_RESTORE` 能还原。
   她自己在 `presence_windows` 里查到过这一条（「最小化，位置不可用」）。
3. 顺带：`--window-position=-32000,-32000` 只管启动那一刻开的窗口；**重启时 Chrome 会按上次保存的位置
   恢复窗口**（很可能就是"上次给他看过、停在屏幕里"的位置）。所以每次就绪之后会把她的窗口统一挪回屏幕外
   （`parkWindowsOffscreen`），免得重启等于替她弹一次窗口。

没量清的写在 `state/design/cortico-world-browser.md`（独占全屏、多显示器、一个窗口里多 tab 且要展示的
不是活动 tab）。

上游的 `tabIdleMinutes`（闲置自动关页）管不到这些窗口——上游不认识我们直连建的窗口，所以本 World
自己补了一份回收（每次工具调用顺便扫一眼，不挂定时器）。

## 失败怎么念（哪一类，决定贴哪句话）

工具失败时回执里会写明是**哪一类**。这不是修辞：2026-09-30 那次就是几类被混成同一句把 bot 带偏了
——她连着三次 `browser_open example.com` 拿到「连不上 cdp-proxy + 去开远程调试」，于是把
「browser 别再试了」写进了自己的笔记；而浏览器与 proxy 全程都是好的，打不开的是那个域名。

| 哪一类 | 什么情况 | 回执里会说 |
|---|---|---|
| 连不上 proxy | HTTP 层面就没通（proxy 没起、或本地超时掐了） | 末尾贴「去开哪个浏览器的远程调试开关」 |
| 浏览器没连上 | proxy 在，但它没 attach 上浏览器 | 同上——**只有这两类与那个开关有关** |
| 页面没打开 | 导航那一段没在窗口内完成：多半是这个地址打不开或太慢 | 说清 proxy 与浏览器都是通的，让它换个地址、过会儿再试，别记成浏览器坏了 |
| 命令没回话 | 命令发出去没回话（页面自己卡着） | 同上 |

分类在 `src/cdp-client.ts` 的 `classifyRelayError()`，文案在 `src/world.ts` 的 `explain()`。

## 开页是两步（认得住页面，不留孤儿）

`browser_open` 先 `POST /new`（正文 `about:blank`，本机量过 167 毫秒）**拿到 targetId 就先认下来**，
再单独 `POST /navigate` 去那个地址。上游的 `/new` 本来是「建 tab → 导航 → 等加载」一条龙，宿主打不开
时会拖到它自己的 30 秒 CDP 超时；客户端若在那之前放弃，回执丢了、**tab 就留在他浏览器里没人认领**
（`browser_close` 也拒绝关，2026-09-30 那三条 `example.com` 孤儿就是这么来的）。拆开之后，导航失败的
那个页面仍归 bot：回执里带 target，它稍后可以再读一次或直接关掉。

导航那一段的超时单独放宽到至少 35 秒（`NAV_TIMEOUT_MIN_MS`）：上游的 CDP 超时就是 30 秒，客户端也卡
30 秒的话永远只能拿到本地那句 `aborted due to timeout`，把上游的真话挡在外面。

## 事件

只有两条，都是服务状态：`browser.ready` / `browser.down`（内部事件，`flush`）。

**他自己在浏览器里干什么，是拉取式的，不是推的。** World 不做任何定时采样，也不往事件队列里
塞东西。bot 想知道的时候调一次 `browser_tabs`：回执给出此刻开着的页面，外加**自它上次调用以来**
他新开、转到、关掉的页面（净变化）。中间开了又关的不留痕——那段时间没在看了，这是「她问才看」
必然的代价，写进工具说明了。

（接了**她自己的实例**时这段没有对象：那个浏览器里只有她，所以变化段不报；`browser_tabs` 回的是
她自己的页面。要保留"看他在干什么"，得另开一条只读的观察通道——见设计记录的「待定」。）

设计决定与理由见工作区的 `state/design/cortico-world-browser.md`。
