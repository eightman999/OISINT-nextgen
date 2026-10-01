import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      {
        find: /^@\/assets\//,
        replacement: fileURLToPath(new URL('./assets/', import.meta.url)),
      },
      {
        find: /^\.\/providers\/selected$/,
        replacement: fileURLToPath(new URL('./src/lib/providers/mock.ts', import.meta.url)),
      },
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./src/', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    // .tsx のコンポーネントテストはファイル先頭の `// @vitest-environment jsdom` pragma で
    // 個別に jsdom を指定する（既存の .ts テストは node 環境のまま）。
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
