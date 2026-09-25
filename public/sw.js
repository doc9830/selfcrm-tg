// SelfCRM: офлайн-кэш оболочки Mini App.
//
// Задача service worker — чтобы приложение открывалось без сети (или когда GitHub
// Pages недоступен). Данные CRM здесь не участвуют: они лежат в localStorage
// устройства и без сервера нужны только для версий ассетов, которые мы и кэшируем.
//
// Стратегия:
//   * переход по адресу (навигация) — сеть, при неудаче кэш (index.html);
//   * файлы сборки (assets/*, sw.js, telegram-web-app.js) — кэш, в фоне обновляем.
// Имена файлов сборки содержат хеш, поэтому новый релиз просто добавит новые файлы,
// а index.html всегда берётся из сети, пока она есть.

const CACHE_NAME = 'selfcrm-tg-shell-v1'
const TELEGRAM_SCRIPT = 'https://telegram.org/js/telegram-web-app.js'
const SHELL_URL = './index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin
  // Свои файлы и официальный скрипт Telegram; всё остальное (Дадата, GitHub API)
  // в кэш не кладём — эти запросы не должны мешать работе без сети.
  if (!sameOrigin && url.href !== TELEGRAM_SCRIPT) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  event.respondWith(cacheFirst(request))
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    const cached = (await cache.match(request)) || (await cache.match(SHELL_URL))
    return cached || Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) {
    void refresh(cache, request)
    return cached
  }

  const response = await fetch(request)
  if (isCacheable(response)) await cache.put(request, response.clone())
  return response
}

async function refresh(cache, request) {
  try {
    const response = await fetch(request)
    if (isCacheable(response)) await cache.put(request, response.clone())
  } catch {
    // Нет сети — пользуемся тем, что уже сохранено.
  }
}

// Ответы без CORS (скрипт Telegram) приходят как opaque: их тоже можно хранить.
function isCacheable(response) {
  return Boolean(response) && (response.ok || response.type === 'opaque')
}
