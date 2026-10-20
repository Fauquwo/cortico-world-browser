/**
 * 宿主可以不装某个内建 World:Coopanion 打包时删掉 src/worlds/{minecraft,qq,bilibili,websearch},
 * 只留 console。任何一个跑不到的 World 被写进 import,整个包就在那种宿主上导入失败 —— 0.3.2 撞过一次
 * (弹幕解码借了 bilibili 的 protobuf 读取器)。这里把那条边界钉成测试。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';

const SRC = resolve(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Parse real imports, re-exports and dynamic imports, including side-effect imports; ignore comments. */
function builtinImports(text: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0]
      : undefined;
    if (specifier && ts.isStringLiteralLike(specifier) && /^cortico\/worlds(?:\/|$)/.test(specifier.text)) out.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

describe('framework imports', () => {
  test('不引用任何内建 World 的内部实现', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const specifier of builtinImports(text)) offenders.push(`${file.slice(SRC.length + 1)} -> ${specifier}`);
    }
    expect(offenders).toEqual([]);
  });
  test('检查覆盖副作用导入、动态导入和转导出，忽略注释与普通字符串', () => {
    expect(builtinImports(`
      // import 'cortico/worlds/comment.ts';
      const example = "from 'cortico/worlds/example.ts'";
      import 'cortico/worlds/console/index.ts';
      export { x } from 'cortico/worlds/qq/index.ts';
      import('cortico/worlds/bilibili/index.ts');
      require('cortico/worlds/websearch/index.ts');
    `)).toEqual(['cortico/worlds/console/index.ts', 'cortico/worlds/qq/index.ts', 'cortico/worlds/bilibili/index.ts', 'cortico/worlds/websearch/index.ts']);
  });
});
