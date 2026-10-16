/**
 * 面板 bundle:`src/webui/client.ts` → `dist/webui.js`,产物路径写在 package.json 的
 * `cortico.webUiClient`。浏览器侧对 `cortico/*` 只允许 `import type`,构建期擦除。
 */
import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [{ in: `${root}src/webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
});
