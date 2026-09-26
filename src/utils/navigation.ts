// Построение маршрута до адреса клиента.
//
// На Android (Capacitor) открывается системный выбор навигатора через geo:-intent.
//
// В Telegram Mini App тот же системный выбор получается через страницу-мост (public/route.html):
// сам клиент geo:-ссылки не принимает — официальный telegram-web-app.js выбрасывает ошибку для
// всех схем, кроме http/https, — поэтому клиенту отдаётся страница рядом с приложением, а он
// открывает её в своём браузере: там geo:-ссылку принимает уже браузер и передаёт системе
// (Android показывает выбор приложения, как в APK-версии).
//
// В браузере — Яндекс.Карты поиском по адресу (`text`): улицу и дом Яндекс ищет сам по своей базе.
// Маршрутная ссылка (`rtext`) годится только для координат: текст адреса она не принимает и
// открывается без пункта назначения.

import { insideTelegramWebView, openExternalLink } from '../telegram/webapp'

export interface RoutePoint {
  lat: number
  lng: number
  label?: string
  // Полный текстовый адрес (с домом). Если он есть, маршрут строится по нему —
  // навигатор сам уточнит точку по своей базе, а не по «центру населённого пункта».
  address?: string
}

// Нативная сборка Android (Capacitor). Признак нужен и ссылкам на клиента (geo:, tel:),
// и обратной связи: письмо передаётся системе тем же способом (utils/feedback.ts).
export function isNativeAndroid(): boolean {
  // Без окна (тесты, серверный рендер) платформы нет: проверка идёт до обращения к window.
  if (typeof window === 'undefined') return false
  const cap = (
    window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
    }
  ).Capacitor
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    return cap.getPlatform ? cap.getPlatform() === 'android' : true
  }
  return false
}

// Координаты считаются заданными, если они не нулевые: 0/0 — признак «точка на карте не
// выбрана» (так их сохраняет карточка клиента, см. ClientForm в screens/ClientDetail.tsx).
export function hasRouteCoords(dest: RoutePoint): boolean {
  return (
    Number.isFinite(dest.lat) && Number.isFinite(dest.lng) && (dest.lat !== 0 || dest.lng !== 0)
  )
}

// geo:-URI для Android. При открытии система сама предложит выбор приложения
// (Google Maps, Яндекс.Карты, Яндекс.Навигатор, 2ГИС и т.д.).
//
// Точку задаём полным текстовым адресом (`geo:0,0?q=<адрес>`): и Яндекс.Карты, и Google Maps
// ищут дом по своей базе и строят маршрут к нему. Так же ведёт себя версия приложения для
// Android — поведение одно и то же в обоих репозиториях (см. docs/UPSTREAM_SYNC.md).
//
// Координаты — запасной вариант: подсказки Дадаты для деревень, СНТ и новых домов отдают
// координаты населённого пункта, и маршрут по ним уводил в его центр. Подпись (имя клиента)
// ставим только в этом варианте: когда точка задана адресом, название точки — сам адрес.
export function buildRouteUri(dest: RoutePoint): string {
  const address = (dest.address ?? '').trim()
  if (address) return `geo:0,0?q=${encodeURIComponent(address)}`

  const label = (dest.label ?? '').trim()
  return `geo:0,0?q=${dest.lat},${dest.lng}${label ? `(${encodeURIComponent(label)})` : ''}`
}

// Ссылка «адрес в Яндекс.Картах»: точку Яндекс ищет сам по тексту адреса (`text`), поэтому
// в навигатор уходит улица и дом, а не приблизительные координаты. Так же ведёт себя поиск
// на сайте карт. Координаты клиента, если они есть, передаём подсказкой `ll` — карта
// открывается в нужном районе, и поиск не уводит в одноимённую улицу другого посёлка.
export function buildAddressSearchUri(dest: RoutePoint): string {
  const query = encodeURIComponent((dest.address ?? '').trim())
  const hint = hasRouteCoords(dest) ? `&ll=${dest.lng},${dest.lat}` : ''
  return `https://yandex.ru/maps/?text=${query}${hint}`
}

// https-ссылка на маршрут в Яндекс.Картах: `~` означает «откуда» = текущее местоположение
// пользователя, дальше идёт точка назначения. Нужна, когда адреса у клиента нет и точку задают
// только координаты: текст адреса такая ссылка не принимает (см. buildAddressSearchUri).
export function buildWebRouteUri(dest: RoutePoint): string {
  return `https://yandex.ru/maps/?rtext=~${dest.lat},${dest.lng}&rtt=auto`
}

// Страница-мост для маршрута (public/route.html). Клиент Telegram отдаёт её своему браузеру,
// а браузер уже передаёт geo:-ссылку системе — так в мини-приложении получается системный выбор
// навигатора, как в APK-версии. Сам клиент geo: не принимает: официальный telegram-web-app.js
// выбрасывает ошибку для всех схем, кроме http/https (openLink).
const ROUTE_BRIDGE_PAGE = 'route.html'

// Адрес страницы-моста собирается от текущего адреса приложения, поэтому работает и на GitHub
// Pages, и при любой другой раздаче. null — собрать не удалось (нет окна или нечего открывать):
// тогда остаётся обычная ссылка на карты.
export function routeBridgeUrl(dest: RoutePoint): string | null {
  if (typeof window === 'undefined' || !window.location) return null
  const address = (dest.address ?? '').trim()
  if (!address && !hasRouteCoords(dest)) return null
  try {
    const page = new URL(ROUTE_BRIDGE_PAGE, window.location.href)
    // У адреса приложения свой хеш-маршрут («#/clients/<id>») и параметры: мосту не нужны.
    page.hash = ''
    page.search = ''
    if (address) page.searchParams.set('address', address)
    if (hasRouteCoords(dest)) {
      page.searchParams.set('lat', String(dest.lat))
      page.searchParams.set('lng', String(dest.lng))
    }
    const label = (dest.label ?? '').trim()
    if (label) page.searchParams.set('label', label)
    return page.toString()
  } catch {
    return null
  }
}

export function openRoute(dest: RoutePoint): void {
  if (!dest) return
  const address = (dest.address ?? '').trim()
  // Открывать нечего: ни адреса, ни координат.
  if (!address && !hasRouteCoords(dest)) return

  if (isNativeAndroid()) {
    // `_system` заставляет Capacitor передать ссылку операционной системе, которая показывает
    // выбор приложения для навигации, а `geo:0,0?q=<адрес>` находит дом по тексту адреса.
    window.open(buildRouteUri(dest), '_system')
    return
  }

  // Telegram Mini App: клиент открывает geo:-ссылку сам не может, зато открывает страницу-мост —
  // её обработкой занимается его браузер, и система показывает выбор приложения для навигации.
  if (insideTelegramWebView()) {
    const bridge = routeBridgeUrl(dest)
    if (bridge) {
      openExternalLink(bridge)
      return
    }
  }

  // Браузер — новая вкладка. С адресом отдаём Яндексу поиск по адресу (дом найдёт он сам),
  // без адреса — маршрут по координатам: он открывается сразу с пунктом назначения.
  openExternalLink(address ? buildAddressSearchUri(dest) : buildWebRouteUri(dest))
}

// tel:-URI для звонка клиенту. Убираем из номера всё, кроме цифр и ведущего «+»,
// чтобы получить корректную ссылку на набор (E.164 для международных номеров).
export function buildTelUri(phone: string): string {
  return `tel:${(phone ?? '').replace(/[^\d+]/g, '')}`
}

// Открывает звонилку. На Android (Capacitor) ссылка передаётся системе через
// `_system` (как и geo:-маршрут). В браузере — обычный tel: на текущей странице.
export function openTel(phone: string): void {
  const clean = (phone ?? '').trim()
  if (!clean) return
  const uri = buildTelUri(clean)
  if (isNativeAndroid()) {
    window.open(uri, '_system')
  } else {
    window.location.href = uri
  }
}

// ----- Мессенджеры -----
//
// Интеграции с Telegram и WhatsApp нет: приложение только открывает переписку с
// клиентом по его номеру — в установленном мессенджере или в веб-версии.
// Телефон приводим к международному виду: «8 900…» и «900…» → «7900…».

export function phoneDigits(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.length === 10) return `7${digits}`
  return digits
}

// Веб-ссылка Telegram: открывает чат с номером (в браузере и в приложении).
export function buildTelegramUri(phone: string): string {
  return `https://t.me/+${phoneDigits(phone)}`
}

// Приложение Telegram на Android: схема tg:// надёжнее веб-ссылки.
export function buildTelegramAppUri(phone: string): string {
  return `tg://resolve?phone=${phoneDigits(phone)}`
}

// Веб-ссылка WhatsApp (работает и в браузере, и в приложении).
export function buildWhatsAppUri(phone: string): string {
  return `https://wa.me/${phoneDigits(phone)}`
}

// Приложение WhatsApp на Android.
export function buildWhatsAppAppUri(phone: string): string {
  return `whatsapp://send?phone=${phoneDigits(phone)}`
}

function openMessenger(phone: string, webUri: string, appUri: string): void {
  if (!phoneDigits(phone)) return
  if (isNativeAndroid()) {
    window.open(appUri, '_system')
    return
  }
  // В Telegram Mini App ссылку открывает клиент Telegram (window.open в WebView не работает).
  openExternalLink(webUri)
}

export function openTelegram(phone: string): void {
  openMessenger(phone, buildTelegramUri(phone), buildTelegramAppUri(phone))
}

export function openWhatsApp(phone: string): void {
  openMessenger(phone, buildWhatsAppUri(phone), buildWhatsAppAppUri(phone))
}
