# OISINT プロダクト・コンセプト映像

2026-09-22以降、生成画像を含むこの映像・posterはアプリに表示しません。
`/concept` は文章による紹介のみを表示します。素材と来歴は記録として保持します。

`oisint-product-concept-v1.mp4` は、OISINT リポジトリ自身の mock Web UI を操作して収録した、15.92 秒の無音コンセプト映像です。`oisint-product-concept-v1.webm` は同じ映像をH.264非対応のWebブラウザ向けにVP9へ変換したフォールバックで、正本はMP4のままです。実在人物、実在店舗画像、外部映像、ストック素材、外部サービス由来の店舗データは含みません。候補カードに映る店舗イラストは、リポジトリ内で来歴と SHA-256 を管理する生成デモ素材です。映像内の説明は日本語字幕として焼き込み、再生画面にも同内容の文章要約を置きます。

関連 Issue: [#443](https://github.com/eightman999/OISINT/issues/443)

## 権利と来歴

- `source_kind`: `first-party-ui-capture`
- `license`: OISINT project-owned first-party material; all rights reserved
- 収録元: commit `63b25b9b048220bb4b5d77edee42f37e0aa98c03` の OISINT mock Web UI
- データ経路: `EXPO_PUBLIC_DATA_PROVIDER_MODE=mock`
- 使用物: リポジトリ内の UI、文言、OISINT ブランド画像、`assets/demo/restaurants/catalog.json` で `sourceKind: ai_generated` として管理する生成デモイラスト
- 除外物: `MOVIE/` 以下の外部 MP4、人物・実在店舗写真、外部映像、ストック素材、第三者サービスの店舗データとサービス表示

個々のファイルの SHA-256、codec、長さ、寸法、収録日時は `manifest.json` を正とします。

## 旧再生契約（画面からの表示は停止済み）

- `/concept` を開いただけでは映像データを取得せず、「映像を見る」の明示操作後だけ player を mount する。
- WebはH.264 Main Level 4.0対応時にMP4を使い、H.264非対応かつVP9対応時だけWebMへフォールバックする。iOS / AndroidはMP4を使う。
- native controls と fullscreen は利用可能にし、autoplay、loop、Picture in Picture、background playback は無効にする。
- 最初の frame までは poster、取得失敗時は poster・alert・retry を表示する。
- 画面と映像内の両方に「コンセプト映像」を表示し、人物・実在店舗映像ではないことを明記する。
- 同内容の文章要約を常設し、無音の焼き込み字幕だけに情報を閉じ込めない。

## 生成手順

前提は Node.js 22、ffmpeg / ffprobe、Playwright Chromium です。収録時の source WebM は一時ディレクトリにだけ保存します。runtime用WebMは、目視確認済みの正本MP4から決定した設定で生成します。

```sh
npm ci
npm --prefix e2e ci
EXPO_PUBLIC_DATA_PROVIDER_MODE=mock npm run web -- --port 8081
```

別のシェルで収録します。

```sh
CONCEPT_CAPTURE_BASE_URL=http://127.0.0.1:8081 \
CONCEPT_CAPTURE_OUTPUT_DIR=/private/tmp/oisint-concept-video-capture \
node e2e/scripts/capture-concept-video.mjs
```

収録結果を Web / iOS / Android で扱える H.264 Main Level 4.0、`yuv420p`、fast-start MP4 に変換し、poster を作ります。

```sh
ffmpeg -ss 1.4 \
  -i /private/tmp/oisint-concept-video-capture/oisint-product-concept-v1-source.webm \
  -an -c:v libx264 -profile:v main -level:v 4.0 -preset slow -crf 24 \
  -pix_fmt yuv420p -r 25 -movflags +faststart \
  assets/demo/video/oisint-product-concept-v1.mp4

ffmpeg -ss 0.4 -i assets/demo/video/oisint-product-concept-v1.mp4 \
  -frames:v 1 -vf 'scale=960:-2' -q:v 3 -update 1 \
  assets/demo/video/oisint-product-concept-v1-poster.jpg

ffmpeg -i assets/demo/video/oisint-product-concept-v1.mp4 \
  -an -c:v libvpx-vp9 -crf 32 -b:v 0 -deadline good -cpu-used 2 -row-mt 1 \
  -pix_fmt yuv420p -r 25 \
  assets/demo/video/oisint-product-concept-v1.webm
```

mock UI の時刻や生成 ID は実行ごとに変わるため、再収録は byte-for-byte 再現ではありません。再生成時は全編を目視し、権利条件を再確認してから `manifest.json` の SHA-256 と実測値を更新します。

## 検証

```sh
npm run test:asset:concept-video
```

検証は、ファイル数、symlink 禁止、SHA-256、容量、MP4 fast-start、MP4 / WebMのduration一致、codec/profile、pixel format、寸法、fps、音声トラックなし、provenance の必須値を確認します。
