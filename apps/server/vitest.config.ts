import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
  plugins: [
    // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，改用 swc 转译
    swc.vite({ module: { type: 'commonjs' } }),
  ],
});
