import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Built-in skills are maintained as real folders, then embedded for all three clients.
  loader: { '.md': 'text', '.yaml': 'text' },
});
