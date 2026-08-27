import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  banner: {
    // shebang + CJS 依赖（commander 等）在 ESM 产物中 require 内置模块所需的垫片
    js: "#!/usr/bin/env node\nimport { createRequire as __eatCreateRequire } from 'node:module';const require = __eatCreateRequire(import.meta.url);",
  },
  // 依赖全部内联，产物单文件即可运行（bin 分发形态）
  noExternal: [/.*/],
  platform: 'node',
  target: 'node18',
});
