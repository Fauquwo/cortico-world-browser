/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { BROWSER } from './definition.ts';

export default BROWSER;
export { BROWSER };
export { BrowserWorld } from './world.ts';
export type { BrowserWorldOptions } from './world.ts';
export type { BrowserConfigSection } from './config.ts';
