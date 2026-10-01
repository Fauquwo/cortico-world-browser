# cortico-world-browser

Owner: `src/definition.ts`

把本机 [web-access](https://github.com/eze-is/web-access) 的 CDP proxy 接成一个 World：
bot 能在浏览器里开页、读页、点击、填表、上传、滚动、截图，能查本机的书签与历史，
接的是操作员日常那个浏览器时还能自己看一眼他在干什么（拉取式，见下面的「事件」）。

两种接法：

- **借他日常那个浏览器**（默认）：带着他所有网站的登录态，页面开在后台 tab 里。`browser_close`
  只接受 bot 自己开的页面——关掉他自己开着的页面是不可逆的，机械上就该拦。
- **给她自己的实例**（`ownBrowser: true`）：本 World 拉起一个专属 Chrome（独立 profile 与调试端口），
  页面开在她自己的窗口里、并且会被带到前台。**要让她播视频就得用这一种**——量到过：后台 tab 里
  媒体根本加载不起来（页面调 `play()`，`readyState` 一直 0），而 `Target.activateTarget` 之后同一句
  `play()` 立刻走完。代价是登录态不共享，要用的站点得在这个 profile 里登一次。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`preflight` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现：起停、十三个工具、`console()` |
| `src/cdp-client.ts` | cdp-proxy 的客户端：起停子进程、HTTP 调用、`find-url.mjs` |
| `src/own-browser.ts` | 她自己的实例：起停、写发现文件、直接说 CDP（`Target.activateTarget`） |
| `src/page-scripts.ts` | 注入页面执行的 JS：读页（穿 Shadow DOM 与 iframe）、填表 |
| `src/ENV_PROMPT.md` | 环境提示词模板，占位符 `{{browser.label}}` / `{{browser.kind}}` / `{{browser.front}}` |
| `scripts/smoke.ts` | 开发用冒烟：对着真的 proxy 走一遍开页、读页、截图；`--own` 时含"能不能播" |
| `tests/` | 干装载、起停、工具回执、变化聚合、专属实例；假 proxy 是一个真的 HTTP 服务 |

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
| `bringToFront` | 默认开：开页/导航后把 tab 调到前台。**关掉她就播不了媒体** |

为什么这样接：上游只从各浏览器**默认 profile** 的 `DevToolsActivePort` 找浏览器（现代 Chrome 用
`--remote-debugging-port` 启动时并不写这个文件），所以本 World 拉起 proxy 时把"家"当 `LOCALAPPDATA`
交给它，再由 `own-browser.ts` 把那个文件写在自己家里——上游据此认出这个实例（`/health` 里仍是
`Chrome`），而操作员日常那个浏览器**一行都不用改**。

`find-url.mjs` 查历史要 `sqlite3` 命令在 PATH 上；没有时它自己的报错会原样回到回执里。
（开了专属实例时，它查的是**她自己那个 profile** 的书签与历史。）

## 起停

先探 `GET /health`，通了就复用（操作员自己或他的 coding agent 已经在跑的情况下不重复拉起），
探不通才 spawn；`stop()` 只关自己拉起的那个。因此两份东西可以共用一个 proxy。
专属实例同一套：先探它的 `/json/version`，探得到就复用（顺手把发现文件刷新成它现在的 ws 路径），
探不到才拉起，`stop()` 同样只关自己拉起的。

起好之后还会**核对 proxy 连的确实是那个实例**（`/health` 的 `chromePort`）：端口上挂着一个连别处的
旧 proxy 时，当场投 `browser.down` 说清，而不是静默地去操作操作员的浏览器。

## 前台与后台（决定她能不能播东西）

2026-10-01 在本机量到的（一台真的 Chrome，隐藏 tab 与前台 tab 各测一遍）：

| 测什么 | 后台 tab | 带到前台之后 |
|---|---|---|
| 同步读 DOM | 正常 | 正常 |
| 定时器 | 刚开出来还灵；闲置几分钟后**整个 tab 被冻结**，200 毫秒的定时器 30 秒都不响 | 正常 |
| `audio.play()` 不靠手势 | **既不 resolve 也不 reject**，`readyState` 停在 0、`currentTime` 不动 | `resolved`、`readyState: 4`、时间开始走 |

启动参数治不了后台那一条（试过 `--autoplay-policy=no-user-gesture-required` 等），**只有把 tab 调到
前台**。所以：`browser_open` / `browser_navigate` 之后会自动带到前台；`browser_focus` 用来把闲置
很久、已经冻住的页面叫醒。专属实例的启动参数里还有一条
`--disable-features=CalculateNativeWinOcclusion`：不然她的窗口被别人盖住时，正在播的视频会被掐掉。

上游 13 个端点里没有"调到前台"，所以 `own-browser.ts` 直连浏览器自己的 WebSocket 发
`Target.activateTarget`（Node 22 原生 `WebSocket`，不加依赖）。

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
