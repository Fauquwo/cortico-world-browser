/** Bilibili-specific tools; window, scrolling and screenshots use the existing Browser tools. */
import type { ToolDef } from 'cortico/core/types.ts';

type Decl = Omit<ToolDef, 'handler'>;

export const VIDEO_TOOL_DECLS: readonly Decl[] = [
  {name:'browser_video_attach', tags:['act'], description:'将 browser_open 打开的 B 站页面绑定为当前视频页。target 是 Browser 的页面 ID。为捕获字幕与弹幕响应会重新加载页面，并暂停当前播放。', parameters:{type:'object', properties:{target:{type:'string'}}, required:['target']}},
  {
    name: 'browser_video_open',
    tags: ['act'],
    description: '在绑定的 B 站页面里打开一个页面:B 站视频(BV 号或网址,可带分 P)、上一次列表里的序号,或不给参数回首页。打开视频页只是打开,不播放;回执带标题、UP 主、时长、分 P、简介开头、有没有字幕、弹幕总数。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'BV 号、B 站网址,或上一次搜索/推荐列表里的序号(如 "3");省略回首页' },
        p: { type: 'integer', minimum: 1, description: '分 P 序号,默认 1' },
      },
      required: [],
    },
  },
  {
    name: 'browser_video_play',
    tags: ['act'],
    description: '从当前打开的视频页开始观看:网页全屏、播放,之后按 World 配置的间隔自动收到一张观察帧(画面拼图 + 这段的字幕和视频弹幕)。可从指定秒数开始。',
    parameters: { type: 'object', properties: { fromSec: { type: 'number', minimum: 0, description: '从这一秒开始;省略则从当前位置' } }, required: [] },
  },
  {
    name: 'browser_video_pause',
    tags: ['act'],
    description: '暂停播放,观察帧停止;画面停在当前帧。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_video_seek',
    tags: ['act'],
    description: '跳到视频里的某一秒(或相对当前位置前后跳),继续播放。',
    parameters: {
      type: 'object',
      properties: {
        toSec: { type: 'number', minimum: 0, description: '绝对位置,秒' },
        bySec: { type: 'number', description: '相对位置,秒,负数往回' },
      },
      required: [],
    },
  },
  {
    name: 'browser_video_look',
    tags: ['read', 'snapshot'],
    description: '看清当前这一帧:取一张大图(默认整帧,可给区域放大)。不影响播放。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1, description: '区域左上角横坐标,0–1 的比例' },
        y: { type: 'number', minimum: 0, maximum: 1, description: '区域左上角纵坐标,0–1 的比例' },
        width: { type: 'number', minimum: 0.05, maximum: 1, description: '区域宽,0–1 的比例' },
        height: { type: 'number', minimum: 0.05, maximum: 1, description: '区域高,0–1 的比例' },
      },
      required: [],
    },
  },
  {
    name: 'browser_video_quality',
    tags: ['act', 'read'],
    description: '看或改播放画质。不带参数列出播放器画质菜单里的档位和当前档;带 level 就在菜单里点那一档(如 "720P"、"480P"、"自动")。视频老是卡住时降一档。',
    parameters: { type: 'object', properties: { level: { type: 'string', description: '档位文字的一部分,如 "720P";省略只看' } }, required: [] },
  },
  {
    name: 'browser_video_exit',
    tags: ['act'],
    description: '退出观看:退出网页全屏、暂停,回到可以逛页面的状态;页面留在这个视频。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_video_search',
    tags: ['act', 'read'],
    description: '在绑定的 B 站页面里打开 B 站搜索结果页,回执是编号的结果列表(标题、UP 主、时长、播放量、发布时间)。之后 browser_video_open 给编号就能打开其中一条。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索词' },
        page: { type: 'integer', minimum: 1, description: '第几页,默认 1' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'browser_video_related',
    tags: ['read'],
    description: '当前视频页右侧的相关推荐,编号列表;之后 browser_video_open 给编号就能打开。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_video_comments',
    tags: ['act', 'read'],
    description: '把页面滚到评论区并读取已加载的评论(热评在前):楼主、点赞数、正文。',
    parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 50, description: '最多读几条,默认 15' } }, required: [] },
  },
];
