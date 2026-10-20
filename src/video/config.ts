/** Config section `worlds.browser.video`, defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';



export interface VideoConfig {
  enabled: boolean;
  /** Raise the video window once when a viewing session starts; manual display stays available. */
  autoBringToFront: boolean;
  browser: { uposHost: string };
  playback: {
    /** Playback not advancing this long while not paused is reported as a stall. */
    stallSec: number;
  };
  observe: {
    /** Shortest gap between two observation frames; a longer model round stretches it. */
    minIntervalSec: number;
    /** Frames per second of video the observation aims for; the grid grows with the gap. */
    frameDensity: number;
    /** Grid cap, 1–9. */
    maxFrames: number;
    cellWidth: number;
    cellHeight: number;
    /** Frames sampled from the player per second, the pool the observation picks from. */
    captureFps: number;
    /** Geometric ratio of sampling positions measured back from the newest frame. */
    ratio: number;
    /** dHash Hamming distance under which two frames count as the same picture. */
    dedupeHamming: number;
    /** Mean absolute luma difference (0–255) between successive samples that counts as a cut. */
    cutThreshold: number;
    /** Mean luma (0–255) under which a sample counts as black. */
    blackLuma: number;
    /** JPEG quality 0–1 of frames and grids. */
    jpegQuality: number;
  };
  /** The video's own danmaku, loaded from its history as the player does. */
  danmaku: {
    enabled: boolean;
    /** Lines quoted per observation; the rest is counted. */
    maxPerScene: number;
  };
  subtitle: {
    enabled: boolean;
  };
}

export const VIDEO_DEFAULTS: VideoConfig = {
  enabled: true,
  autoBringToFront: false,
  browser: { uposHost: '' },
  playback: { stallSec: 6 },
  observe: {
    minIntervalSec: 15,
    frameDensity: 0.8,
    maxFrames: 9,
    cellWidth: 640,
    cellHeight: 360,
    captureFps: 2,
    ratio: 0.618,
    dedupeHamming: 6,
    cutThreshold: 40,
    blackLuma: 16,
    jpegQuality: 0.8,
  },
  danmaku: { enabled: true, maxPerScene: 12 },
  subtitle: { enabled: true },
};

const K = 'worlds.browser.video';

export const VIDEO_CONFIG_GROUP: ConfigGroup = {
  id: 'world:browser:video',
  owner: 'world:browser',
  schema: {
    type: 'object',
    title: 'B 站视频',
    properties: {
      [`${K}.enabled`]: { type: 'boolean', title: '启用 B 站视频模块', 'x-hot': false },
      [`${K}.autoBringToFront`]: { type: 'boolean', title: '看视频时自动抬到桌面', description: '默认关闭。开始观看时抬起一次专属浏览器，仍受「允许她弹到你眼前」控制；关闭后仍可用 browser_focus 或播放面板手动展示。关闭不会把已展示的窗口藏回去。', 'x-hot': true },
      [`${K}.observe.minIntervalSec`]: { type: 'number', title: '观察间隔', minimum: 2, maximum: 120, 'x-suffix': 's', description: '两张观察帧之间最短的间隔;模型一轮更长时间隔跟着变长,格数按密度补上。', 'x-hot': true },
      [`${K}.observe.frameDensity`]: { type: 'number', title: '帧密度', minimum: 0.1, maximum: 2, 'x-suffix': '帧/s', description: '一张观察帧覆盖的时间里平均每秒取几帧;格数 = 间隔 × 密度,封顶在格数上限。', 'x-hot': true },
      [`${K}.observe.maxFrames`]: { type: 'integer', title: '格数上限', minimum: 1, maximum: 9, 'x-hot': true },
      [`${K}.observe.cellWidth`]: { type: 'integer', title: '单格宽', minimum: 160, maximum: 1920, 'x-suffix': 'px' },
      [`${K}.observe.cellHeight`]: { type: 'integer', title: '单格高', minimum: 90, maximum: 1080, 'x-suffix': 'px' },
      [`${K}.observe.captureFps`]: { type: 'number', title: '采样帧率', minimum: 0.5, maximum: 5, 'x-suffix': 'fps', 'x-hot': false, description: '从播放器抽帧进候选池的频率。' },
      [`${K}.observe.ratio`]: { type: 'number', title: '位置公比', minimum: 0.3, maximum: 0.9, description: '采样点从最新帧往回按等比排布的公比;0.618 是黄金分割。', 'x-hot': true },
      [`${K}.observe.dedupeHamming`]: { type: 'integer', title: '相同画面阈值', minimum: 0, maximum: 20, description: 'dHash 汉明距离小于它的两帧视为同一画面,只留一帧。', 'x-hot': true },
      [`${K}.observe.cutThreshold`]: { type: 'number', title: '切换阈值', minimum: 5, maximum: 200, description: '相邻样本平均亮度差超过它记为画面切换,采样点吸附到切换后的第一帧。', 'x-hot': true },
      [`${K}.observe.blackLuma`]: { type: 'number', title: '黑场亮度', minimum: 0, maximum: 64, 'x-hot': true },
      [`${K}.observe.jpegQuality`]: { type: 'number', title: 'JPEG 质量', minimum: 0.3, maximum: 1, 'x-hot': true },
      [`${K}.danmaku.enabled`]: { type: 'boolean', title: '附视频弹幕', description: '把这段时间里视频自带的历史弹幕写进观察帧。', 'x-hot': true },
      [`${K}.danmaku.maxPerScene`]: { type: 'integer', title: '每张引用弹幕数', minimum: 0, maximum: 60, 'x-hot': true },
      [`${K}.subtitle.enabled`]: { type: 'boolean', title: '附字幕', description: '视频有 CC 或 AI 字幕时,把这段时间的字幕写进观察帧。', 'x-hot': true },
      [`${K}.browser.uposHost`]: { type: 'string', title: '视频分片 CDN 主机', 'x-hot': false, description: '填了就把 upos-*.bilivideo.com 的分片请求改到这个主机,例如海外用 upos-hz-mirrorakam.akamaized.net;留空由播放器自己选。改后重启 World 生效。' },
      [`${K}.playback.stallSec`]: { type: 'number', title: '卡住判定', minimum: 2, maximum: 60, 'x-suffix': 's', description: '播放没有推进超过这么久就投一条卡住事件。', 'x-hot': true },
    },
  },
};
