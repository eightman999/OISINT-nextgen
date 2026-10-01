/*
 * OISINT のWebアプリシェル用Service Worker。
 *
 * 調査内容・認証・API応答はキャッシュしない。アプリシェルの静的アセットだけを
 * network-first で扱い、オフライン時も古いHTMLを調査結果として表示しない。
 */
const CACHE_PREFIX = 'oisint-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const STATIC_ASSET_PATHS = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];
const STATIC_PATH_PREFIXES = ['/_expo/static/', '/assets/', '/icons/'];
const PRIVATE_PATH_PREFIXES = [
  '/api',
  '/auth',
  '/functions',
  '/rest',
  '/storage',
  '/realtime',
  '/supabase',
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isHtmlRequest(request, url) {
  const accept = request.headers.get('accept') || '';
  return (
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname.endsWith('.html') ||
    accept.includes('text/html')
  );
}

function isPrivatePath(url) {
  return PRIVATE_PATH_PREFIXES.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}

function isStaticAssetRequest(request, url) {
  if (request.method !== 'GET' || !isSameOrigin(url) || url.search || url.hash) return false;
  if (isHtmlRequest(request, url) || isPrivatePath(url)) return false;
  if (STATIC_ASSET_PATHS.includes(url.pathname)) return true;
  return STATIC_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function offlineResponse() {
  return new Response('オフラインです。接続を確認して再試行してください。', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-OISINT-Offline': '1',
    },
  });
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (_error) {
    return offlineResponse();
  }
}

async function networkFirstStatic(request) {
  try {
    const response = await fetch(request);
    const responseIsSameOrigin =
      !response.url || new URL(response.url).origin === self.location.origin;
    if (response.ok && !response.redirected && responseIsSameOrigin) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      } catch (_cacheError) {
        // キャッシュ失敗時も、取得できた静的asset自体は返す。
      }
    }
    return response;
  } catch (_error) {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || offlineResponse();
  }
}

self.addEventListener('install', (event) => {
  // skipWaiting は自動実行せず、UIの「更新を適用」操作からだけ受け付ける。
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSET_PATHS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 外部origin・非GETはブラウザへそのまま委ね、キャッシュへ触れない。
  if (request.method !== 'GET' || !isSameOrigin(url)) return;

  // 映像はユーザー操作時に取得する大容量コンテンツなので、Service Workerの
  // cache/networkFirstStaticを経由させずブラウザのネットワークへ委ねる。
  if (request.destination === 'video' || /\.(?:mp4|webm)$/i.test(url.pathname)) {
    return;
  }

  if (isStaticAssetRequest(request, url)) {
    event.respondWith(networkFirstStatic(request));
    return;
  }

  // HTML・認証・Supabase/API・その他の動的応答はnetwork-only。失敗時は古い状態を出さない。
  event.respondWith(networkOnly(request));
});
