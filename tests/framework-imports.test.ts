/**
 * 宿主可以不装某个内建 World:Coopanion 打包时删掉 src/worlds/{minecraft,qq,bilibili,websearch},
 * 只留 console。任何一个跑不到的 World 被写进 import,整个包就在那种宿主上导入失败 —— 0.3.2 撞过一次
 * (弹幕解码借了 bilibili 的 protobuf 读取器)。这里把那条边界钉成测试。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const ALLOWED = new Set(['console']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** 只看真正的模块说明符(`from '…'` 与 `import('…')`),注释里提到路径不算。 */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]cortico\/worlds\/([a-z0-9-]+)\//g;

describe('framework imports', () => {
  test('只引用宿主一定会带的框架模块,不碰内建 World 的内部实现', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SPECIFIER)) {
        if (!ALLOWED.has(match[1])) offenders.push(`${file.slice(SRC.length + 1)} -> cortico/worlds/${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
