# Third party code

The Bilibili video module derives from Phantivia/cortico-world-bilibili-video, commit a11d2a763b344f606c2383ccbb8f8a4cd4593515 (MIT). The upstream copyright and license are preserved in src/video/LICENSE.

src/video/pb.ts holds the protobuf wire reader from Cortico's built-in Bilibili World (src/worlds/bilibili/protobuf.ts, MIT, Copyright (c) 2026 Phantivia), trimmed to the three functions the video module calls. It is copied in rather than imported because a host that packages Cortico without the built-in Worlds it does not run (Coopanion drops src/worlds/bilibili) would otherwise fail to load this World at all. The license is preserved in src/video/LICENSE.

Before 0.4.0 this package wrapped eze-is/web-access (MIT, author 一泽 Eze) as an external process. The engine is now implemented in-package (src/cdp-engine.ts) rather than copied; its semantics (browser discovery via DevToolsActivePort, port-probe interception, idle-tab reaping, per-endpoint behavior) follow the upstream implementation, which is MIT-licensed (declared in the upstream README and SKILL.md). The find-url module (src/find-url.ts) reimplements the output format of the upstream scripts/find-url.mjs for receipt compatibility.
