// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  // import/no-unresolved は Node resolver で解決できない import specifier を使う
  // 4 レーンに限って無効化する（issue #456）:
  //   - supabase/**: Deno の @std/assert 等
  //   - e2e/**:      @playwright/test / @axe-core/playwright（e2e/ 配下の独立 node_modules）
  //   - apps/api/**: cloudflare:workers / @cloudflare/vitest-pool-workers
  //   - scripts/**:  npm: プレフィックス import（Deno 実行スクリプト）
  // src/・app/ のアプリコードでは expoConfig の同ルールを有効のまま保つ。
  // flat config は後続ブロック優先のため、この off は上記 files にのみ効く。
  {
    files: ['supabase/**', 'e2e/**', 'apps/api/**', 'scripts/**'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
  // scripts/** は Node で実行するスクリプト群。Buffer 等の Node globals を
  // languageOptions.globals で認識させる（no-undef は無効化しない）。
  {
    files: ['scripts/**'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: [
      'dist/*',
      // DBBuild/ は Python 実装のみで JS/TS ファイルが存在しないため除外する。
      // 将来 JS/TS を追加する場合はこの除外を見直すこと（issue #456）。
      'DBBuild/*',
      // .claude/ は Claude Code 専用ワークフロー（args 注入・トップレベル return の
      // 独自 DSL）で、標準の JS として解析できないため除外する。
      '.claude/*',
    ],
  },
  // 色は src/theme.ts のトークン経由で参照する（issue #219）。
  // 生の hex 色リテラルを置けるのは src/theme.ts のみ。二重ガードとして
  // scripts/check-theme-tokens.sh も CI（frontend-ci.yml）で実行される。
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    ignores: ['src/theme.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: '色リテラルは src/theme.ts に定義し、@/theme のトークンを参照してください。',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'テンプレート内の色リテラルも src/theme.ts のトークンへ移してください。',
        },
      ],
    },
  },
]);
