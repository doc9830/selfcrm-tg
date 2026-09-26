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
//
// Отдельно кэшируются страницы-мосты: mailto.html (письмо обратной связи) и route.html
// (маршрут до клиента). Их открывает браузер клиента Telegram из мини-приложения, и без
// сети они всё равно нужны — иначе вместо письма или маршрута откроется пустая страница
// или оболочка приложения.

const CACHE_NAME = 'selfcrm-tg-shell-v2'
const TELEGRAM_SCRIPT = 'https://telegram.org/js/telegram-web-app.js'
const SHELL_URL = './index.html'
// Файлы, которые нужны всегда: их кладём в кэш сразу при установке service worker.
const PRECACHE = [SHELL_URL, './mailto.html', './route.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // Ошибка загрузки любого файла не должна отменять установку: приложение обязано
      // работать и без этого кэша.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))
      await self.skipWaiting()
    })(),
  )
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
