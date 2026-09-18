# cortico-world-browser

Owner: `src/definition.ts`

把本机 [web-access](https://github.com/eze-is/web-access) 的 CDP proxy 接成一个 World：
bot 能在操作员自己那个浏览器里开页、读页、点击、填表、上传、滚动、截图，能查本机的书签与历史，
并且看得见他自己在浏览器里去了哪儿（开了哪个页面、转到哪个站、关掉了什么）。

浏览器带着他所有网站的登录态。`browser_close` 只接受 bot 自己开的页面——关掉他自己开着的页面
是不可逆的，机械上就该拦。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`preflight` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现：起停、轮询他的动向、十二个工具、`console()` |
| `src/cdp-client.ts` | cdp-proxy 的客户端：起停子进程、HTTP 调用、`find-url.mjs` |
| `src/page-scripts.ts` | 注入页面执行的 JS：读页（穿 Shadow DOM 与 iframe）、填表 |
| `src/ENV_PROMPT.md` | 环境提示词模板，占位符 `{{browser.label}}` 与 `{{browser.watching}}` |
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

## 事件

- `browser.ready` / `browser.down`：内部事件，`flush`，服务起停与掉线恢复。
- `browser.activity`：他自己在浏览器里的动向。每 `pollIntervalMs` 取一次页面快照取差，
  只报不是 bot 自己开的那些，攒成一段用延迟渲染投递。默认 `piggyback`——**不叫醒她**，
  等她下一次开口时随那批事件进上下文；想让她当场就知道，把 `wakeOnActivity` 打开。

设计决定与理由见工作区的 `state/design/cortico-world-browser.md`。
