# cortico-world-browser

Owner: `src/definition.ts`

把本机 [web-access](https://github.com/eze-is/web-access) 的 CDP proxy 接成一个 World：
bot 能在操作员自己那个浏览器里开页、读页、点击、填表、上传、滚动、截图，能查本机的书签与历史，
想知道他在浏览器里干什么时也能自己看一眼（拉取式，见下面的「事件」）。

浏览器带着他所有网站的登录态。`browser_close` 只接受 bot 自己开的页面——关掉他自己开着的页面
是不可逆的，机械上就该拦。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`preflight` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现：起停、轮询他的动向、十二个工具、`console()` |
| `src/cdp-client.ts` | cdp-proxy 的客户端：起停子进程、HTTP 调用、`find-url.mjs` |
| `src/page-scripts.ts` | 注入页面执行的 JS：读页（穿 Shadow DOM 与 iframe）、填表 |
| `src/ENV_PROMPT.md` | 环境提示词模板，占位符 `{{browser.label}}` |
| `scripts/smoke.ts` | 开发用冒烟：对着真的 proxy 走一遍开页、读页、截图 |
| `tests/` | 干装载、起停、工具回执、动向聚合；假 proxy 是一个真的 HTTP 服务 |

## 配置

`worlds.browser` 段。必填两项：`skillDir`（装了 web-access 的目录）与 `browser`
（`chrome` / `edge` / `chromium`，必须是你要操作的那一个）；漏填由 `preflight` 拦下。

上游那边要打开对应浏览器的远程调试开关：地址栏进 `chrome://inspect#remote-debugging`
（Edge 是 `edge://inspect#remote-debugging`），勾选「Allow remote debugging for this browser instance」。
没打开时 World 会投一条 `browser.down`，工具回失败并说明这一步——不是这个包坏了。

`find-url.mjs` 查历史要 `sqlite3` 命令在 PATH 上；没有时它自己的报错会原样回到回执里。

## 起停

先探 `GET /health`，通了就复用（操作员自己或他的 coding agent 已经在跑的情况下不重复拉起），
探不通才 spawn；`stop()` 只关自己拉起的那个。因此两份东西可以共用一个 proxy。

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
他新开、转到、关掉的页面（净变化）。中间开了又关的不留痕——那段时间没人在看，这是「她问才看」
必然的代价，写进工具说明了。

设计决定与理由见工作区的 `state/design/cortico-world-browser.md`。
