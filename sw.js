/* =========================================================
 * Service Worker — 静态资源 Cache First 策略
 * 版本号更新（v2、v3…）即可触发旧缓存清理
 * ========================================================= */
const CACHE_NAME = 'health-pwa-v12';

/* 安装时预缓存全部静态资源，保证首次打开后即可完全离线 */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './oss-config.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  /* 逐个缓存并容忍个别失败（oss-config.js 仅在 Actions 部署产物中存在，本地开发时可能没有） */
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(PRECACHE_ASSETS.map(a => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Cache First：命中缓存直接返回；未命中则请求网络并写入运行时缓存 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  /* 不拦截跨域请求（如阿里云 OSS 同步） */
  if (!req.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => {
        /* 离线且未缓存时，导航请求回退到缓存的首页 */
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
