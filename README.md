# cortico-world-browser

> **★ 非即插即用。** 装完包还不能用：先装上游 [web-access](https://github.com/eze-is/web-access)，
> 把目录填进 `worlds.browser.skillDir`；再填 `worlds.browser.browser`，并打开那个浏览器的远程调试开关。
> 缺一样 `preflight` 就会拦住 World，时间线里不会出现 `browser.ready`。步骤见下面「怎么装」。

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

## 在 Coopanion(Coo)上使用

已在 **Coopanion 0.2.5**(Windows x64 便携版)上装机验收:市场里检查与安装成功,重启后**导入成功**;
搜索面板与 B 站播放面板都能打开,设置页显示搜索配置;专属 Chrome 与 cdp-proxy 在线;
六个工具在真实浏览器上依次走通(打开、输入、点击、读回、看标签、关闭),读回了本地测试页里提交的内容;
真模型也跑过一轮(模型自己 `browser_open` 读页面 → 用别的工具干活 → `browser_close`)。
这一次没有测 B 站扫码登录与视频播放,也没测 DeepSeek / Tavily 这类付费搜索 API(要账号与密钥)。
「非即插即用」那一条在 Coo 上同样成立:web-access、`skillDir`、浏览器远程调试三样都要自己配,
Coopanion 不会代劳。

Coo 的扩展市场默认可能走镜像源(npmmirror),镜像上偶尔还没有新版本 —— 检查时报「registry 没有给出
cortico-world-browser 的 x.y.z 版本」,就把 Coo 的扩展源改成官方 `https://registry.npmjs.org` 再装。
装完或改过配置要**整进程重启** Coo 才生效(只重启 World 不够,端口与 profile 会按旧值走)。

**遇到问题**:去 GitHub 开 issue —— https://github.com/biliye/cortico-world-browser/issues;
或者到 QQ 群里 @筆離嘢(和作者名同名)。附上 Coo 版本、本包版本和报错截图,再说清是「连不上 proxy」
「浏览器没连上」还是「页面没打开」那一类 —— 回执里会写明,照着贴就行。

## 市场标签

按官方索引仓的 [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md) 声明了五个标签：

- **`internet`**：搜索、抓取正文、读网页 —— 词表里「让 bot 读取或操作互联网内容」；
- **`browser`**：真正操作一个浏览器（开页、点击、填表、截图），不是只调 HTTP 接口；
- **`video`**：陪看 B 站视频、读字幕与弹幕；
- **`external-setup`**：装完包还不够，要先装上游 [web-access](https://github.com/eze-is/web-access) 并配好远程调试；
- **`high-cost`**（提示级）：观看视频时每 15 秒投一张画面拼图，还会读字幕与弹幕，token 消耗比普通工具快。

没有声明警示标签：它不持续读取屏幕或键鼠，截图与页面内容只在工具被调用时产生。卡片图标是包内
`assets/icon.svg`，英文界面显示 `Browser`（`cortico.locales.en`）。

## 怎么装

要求 **Cortico 0.2.0 及以上**（扩展契约 `world` 6；0.1.x 不认识这个版本号，装载时直接拒绝）。

- **扩展市场**：控制台「扩展 → 扩展市场」搜 `cortico-world-browser`，点安装，然后重启进程。
  npm 上的包已经带好 `dist/webui.js`，不用自己构建。
- **手动**：在部署目录里 `corepack pnpm add --ignore-workspace cortico-world-browser --registry=https://registry.npmjs.org/`
  （本机默认源常是只读镜像，要显式指官方源），或在控制台里安装本包目录。

装完还要做两件事，否则 `preflight` 会拦住 World：

1. 装上游 web-access，把目录填进 `worlds.browser.skillDir`；
2. 填 `worlds.browser.browser`（`chrome` / `edge` / `chromium`），并按下一节打开对应浏览器的远程调试开关。

然后启用 `worlds.browser`，时间线应出现 `browser.ready`；Browser 详情页出现「搜索设置」与「B 站授权」面板。

## 从源码构建

1. `corepack pnpm install && corepack pnpm build:webui` —— 面板产物 `dist/webui.js` 必须先打出来；
   `dist/` 不进包的 git，从仓库克隆后要自己 build（npm 包里已带好）；
2. 装进部署，重启进程，再按上一节启用并填写配置。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`preflight` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现：起停、通用与视频工具、`webUi()` |
| `src/cdp-client.ts` | cdp-proxy 的客户端：起停子进程、HTTP 调用、`find-url.mjs` |
| `src/search.ts` | `browser_search` 的引擎表、抽取表达式与回执排版（纯函数，不带浏览器） |
| `src/search-settings.ts` / `src/search-service.ts` | 搜索配置、优先级路由、失败切换和密钥设置 |
| `src/search-api.ts` | DeepSeek Search/Fetch、Tavily Search/Extract 接口适配 |
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
| `searchEngine` | 兼容旧部署的默认引擎。`search.order` 为空时优先使用它；保存新排序后由新排序决定 |

为什么这样接：上游只从各浏览器**默认 profile** 的 `DevToolsActivePort` 找浏览器（现代 Chrome 用
`--remote-debugging-port` 启动时并不写这个文件），所以本 World 拉起 proxy 时把"家"当 `LOCALAPPDATA`
交给它，再由 `own-browser.ts` 把那个文件写在自己家里——上游据此认出这个实例（`/health` 里仍是
`Chrome`），而操作员日常那个浏览器**一行都不用改**。

`find-url.mjs` 查历史要 `sqlite3` 命令在 PATH 上；没有时它自己的报错会原样回到回执里。
（开了专属实例时，它查的是**她自己那个 profile** 的书签与历史。）

## 搜索与正文抓取（0.3.0）

在 Browser World 的「搜索设置」面板拖拽或用上下箭头调整 DeepSeek、Tavily、Bing、搜狗和百度的顺序，并勾选启用项。保存后下次搜索生效。默认取第一个已启用且配置完整的引擎；未填写密钥的 API 引擎自动跳过。

同一面板分别填写 DeepSeek 和 Tavily API key。密钥由宿主写入部署 `.env`，变量名为 `CORTICO_BROWSER_DEEPSEEK_API_KEY`、`CORTICO_BROWSER_TAVILY_API_KEY`；配置和页面状态仅包含是否已配置。无需更换 bot 的模型。

`browser_search {query, engine?, count?}` 返回实际引擎、标题、地址、来源和摘要。显式指定引擎时只调用这一家，禁用或缺密钥会报错。DeepSeek 搜索词最多 128 个 Unicode 字符。Tavily 可在设置中选择 basic / advanced 搜索深度，advanced 消耗更多额度。

「失败后自动切换」默认关闭。开启后，网络失败、超时、限流、服务错误或无效响应会依次尝试后面的可用引擎；成功但无结果、无效参数、鉴权失败、额度不足或主动取消时停止。回执记录实际使用的引擎和前面失败的尝试。各家结果分数不混排。

`browser_fetch {url, engine?, maxChars?}` 按相同顺序选择可用的 DeepSeek / Tavily，调用 DeepSeek Fetch / Tavily Extract，返回 Markdown 正文。默认最多 8000 字符，上限 40000，截断时明确标记；响应读取上限 4 MiB。抓取不打开 tab、不携带本机 cookie；需要登录、交互或 JavaScript 渲染的内容仍走 `browser_open` / `browser_read`。

配置在 `worlds.browser.search`：`order` 是逗号分隔的引擎 id，`fallbackEnabled` 控制切换，`<engine>.enabled` 控制启用，`tavily.searchDepth` 控制深度。`order` 为空时沿用旧 `searchEngine` 的首选顺序。配置项均由扩展声明，也可以在 World 通用配置表单中编辑。

API 文档：[DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。测试使用本地 HTTP 接口，不消耗真实额度。`pnpm smoke:search-ui` 在临时无界面 Chrome 中验证排序、开关、保存和密钥交互。

### 浏览器页面搜索

她原话：「浏览器给我的是『打开这个地址、读正文』，没有『搜』这一步，主题一模糊我就只剩猜域名、翻站内导航两条路。」
`browser_search` 填的就是这一步：一次调用把关键词变成一批**地址**（标题 + 地址 + 一句摘要），她拿地址去 `browser_open`。

网页引擎不需要 API key。2026-10-12 在本机 Chrome 中测得 Google 与 DuckDuckGo 超时，Bing 国内版、搜狗、百度可用；以下选择器来自当天的结果页：

| 引擎 | 结果锚点 | 抽到几条 | 地址是 | 摘要 |
|---|---|---|---|---|
| Bing 国内版（默认） | `#b_results > li.b_algo h2 a` | 10 | **真地址** | `.b_caption p`，来源站名在 `.tptt` |
| 搜狗 | `h3 a` | 8 | `sogou.com/link?url=…` 跳转链接 | `.text-layout` / `.space-txt` |
| 百度 | `#content_left div.result h3 a` | 6 | `baidu.com/link?url=…` 跳转链接 | 有时在 `[class*=abstract]` |

跳转链接**直接打开**会落到真页（量过搜狗那条落到知乎文章），但地址上看不出站点；百度更差一点 ——
实测有跳转链接打开后落回百度自己的页。旧部署默认 Bing 国内版；工具参数 `engine` 可以按次覆盖。

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

## B 站视频（0.2.0）

B 站视频在同一个 Browser World 内，共用进程、profile 与页面登记，不需要安装独立视频 World。

- `browser_video_open`：给 BV 号、B 站网址或上次列表序号打开视频；不填则回首页。
- `browser_video_attach`：绑定已有 B 站 target；会重新加载并暂停该页，以捕获字幕和弹幕响应。不会取得用户页面的关闭权限。
- `browser_video_play / pause / seek / exit`：播放并观察、暂停、跳转、退出观察。
- `browser_video_look / quality`：看当前大图、查看或切换画质。
- `browser_video_search / related / comments`：站内搜索、推荐和评论。

回执带视频页的 target；截图、滚动、展示、关闭继续用 `browser_shot / scroll / focus / close`。关闭仍受原有页面归属规则约束。
一时只绑定一个视频页，其他网页可继续操作。观看中免于闲置回收；暂停或退出后恢复回收，普通导航和关页会解除观看绑定。

配置子段 `worlds.browser.video` 默认启用，观察最短间隔 15 秒、采样 2 fps、拼图最多 9 格；参数在 Browser 配置页调整。
只有显式播放进入观看后才抽帧、投观察事件；未观看时不采集视频帧。旧延迟观察在暂停、跳转、切换视频或分 P、关页和停止时失效。
没有字幕的视频只有画面；本模块不提供原始音轨或语音识别。

WebUI 新增「B 站授权」与「播放状态」。已有 profile 登录可点「核验登录」，也可手机扫码；二维码结果只在内存暂存，应用到同一 profile 后清空。
登出会清除该 Browser profile 的 B 站 cookie，暂停当前视频并回首页，其他网站的 cookie 保留。

专属实例默认在屏幕外工作。播放面板与 B 站视频配置中新增「看视频时自动抬到桌面」
（`worlds.browser.video.autoBringToFront`，默认 `false`，保存后无需重启）：开始或恢复观看时抬一次，重复播放调用与观察轮询不会反复抢到前面。
自动抬窗仍受 `worlds.browser.bringToFront` 控制；抬窗失败会写进播放回执，播放与观察继续。
关闭自动抬窗后，她仍可用 `browser_focus {target}` 显式展示（需允许弹窗）。你可随时点播放面板的「抬到桌面」，
这个操作由你直接发起，不受她的弹窗权限限制。两种抬窗方式都需要专属实例和已打开的视频页；关掉自动开关不会隐藏已经展示的窗口。
借操作员浏览器时，新的视频独立窗口可能出现在屏幕上；需要不打扰操作员时使用专属实例。

构建：`pnpm build:webui`；`pnpm prepack` 也会生成随包分发的 `dist/webui.js`。
开发验收：`pnpm smoke:video` 在独立临时 profile 的无界面 Chrome 中跑本地合成视频，不读取部署或日常浏览器登录态。

上游来源与 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 事件

服务状态：`browser.ready` / `browser.down`（内部事件，`flush`）。
视频状态：`browser.video.state`（`flush`）；观看观察：`browser.video.scene`（`debounce`，投递时拼图并附字幕与视频历史弹幕）。

**他自己在浏览器里干什么，是拉取式的，不是推的。** 普通浏览活动不做定时采样或推送；视频观察仅在观看中开启。
bot 想知道浏览活动时调一次 `browser_tabs`：回执给出此刻开着的页面，外加**自它上次调用以来**
他新开、转到、关掉的页面（净变化）。中间开了又关的不留痕——那段时间没在看了，这是「她问才看」
必然的代价，写进工具说明了。

（接了**她自己的实例**时这段没有对象：那个浏览器里只有她，所以变化段不报；`browser_tabs` 回的是
她自己的页面。要保留"看他在干什么"，得另开一条只读的观察通道。）

## 边界与代价

- 搜索与正文抓取会消耗所选服务的额度；DeepSeek 与 Tavily 的 key 可选，网页引擎不需要 key。
- `browser_js` 与点击是在**你的账号与登录态**上执行的真实动作；公开发布、下单、发消息都不可撤回。
  本 World 不替 bot 判断这类语义，判断归 Persona。
- 观看视频时投递的画面拼图会进入上下文，并按模型的附件规则每轮重发；长时间连看会让请求体变大。
- 包只写自己的配置段与部署 `.env` 里的两个搜索密钥，不读写 Memory。
