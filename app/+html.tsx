import type { PropsWithChildren } from 'react';
import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';

import { colors } from '@/theme';

// サイト共通のOGP/meta（#179 / #228）。文言は app.json の web.name / web.description と同一。
// title / meta description は app/_layout.tsx の Head、favicon は app.json の web.favicon が
// 静的HTMLへ出力するため、ここでは重複させない。
// og:image は調査内容（raw_query 等）を露出させない決定的なブランド画像だけを指定する。
const SITE_NAME = 'OISINT';
const SITE_TITLE = 'OISINT | 根拠で選ぶレストラン調査';
const SITE_DESCRIPTION = '公開情報と根拠を比べ、みんなでレストランを決める調査サービス';
// 本番URL（spec.md §8 / wrangler.toml の custom_domain）
const SITE_URL = 'https://oisint.com/';
const SITE_IMAGE = `${SITE_URL}ogp.png`;
const SITE_IMAGE_ALT = 'OISINT — 根拠つきで、みんなで決める';
// app.json の splash backgroundColor / src/theme.ts の colors.bg と同一
const THEME_COLOR = colors.bg;

export default function RootHtml({ children }: PropsWithChildren) {
  const { htmlAttributes, bodyAttributes, headNodes, bodyNodes } = useServerDocumentContext();

  return (
    <html {...htmlAttributes} lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLOR} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta property="og:site_name" content={SITE_NAME} />
        <meta property="og:title" content={SITE_TITLE} />
        <meta property="og:description" content={SITE_DESCRIPTION} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:locale" content="ja_JP" />
        <meta property="og:image" content={SITE_IMAGE} />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={SITE_IMAGE_ALT} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content={SITE_IMAGE} />
        <ScrollViewStyleReset />
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
