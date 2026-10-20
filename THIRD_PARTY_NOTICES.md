# Third party code

The Bilibili video module derives from Phantivia/cortico-world-bilibili-video, commit a11d2a763b344f606c2383ccbb8f8a4cd4593515 (MIT). The upstream copyright and license are preserved in src/video/LICENSE.

src/video/pb.ts holds the protobuf wire reader from Cortico's built-in Bilibili World (src/worlds/bilibili/protobuf.ts, MIT, Copyright (c) 2026 Phantivia), trimmed to the three functions the video module calls. It is copied in rather than imported because a host that packages Cortico without the built-in Worlds it does not run (Coopanion drops src/worlds/bilibili) would otherwise fail to load this World at all. The license is preserved in src/video/LICENSE.
