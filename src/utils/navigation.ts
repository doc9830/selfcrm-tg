// Построение маршрута до адреса клиента.
// На Android (Capacitor) открывается системный выбор навигатора через geo:-intent.
// В Telegram Mini App и в браузере — маршрут в Яндекс.Картах (в Mini App ссылку
// открывает клиент Telegram, потому что window.open в WebView игнорируется).

import { openExternalLink } from '../telegram/webapp'

export interface RoutePoint {
  lat: number
  lng: number
  label?: string
  // Полный текстовый адрес (с домом). Нужен как подпись точки и как запасной способ
  // построить маршрут, если координаты не сохранены.
  address?: string
}

function isNativeAndroid(): boolean {
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

// Подпись точки на карте: полный адрес точнее имени клиента, поэтому он в приоритете.
function routeLabel(dest: RoutePoint): string {
  return (dest.address ?? '').trim() || (dest.label ?? '').trim()
}

// geo:-URI для Android. При открытии система сама предложит выбор приложения
// (Google Maps, Яндекс.Карты, Яндекс.Навигатор, 2ГИС и т.д.).
//
// Точку задаём координатами: текстовый адрес в `q` понимают Google Maps и Яндекс.Карты,
// но не Яндекс.Навигатор и 2ГИС — при выборе такого навигатора открывалась пустая карта
// без точки. Текст адреса передаём только подписью в скобках — навигатор покажет его как
// название точки, но маршрут построит по координатам.
export function buildRouteUri(dest: RoutePoint): string {
  if (hasRouteCoords(dest)) {
    const point = `${dest.lat},${dest.lng}`
    const label = routeLabel(dest)
    return `geo:${point}?q=${point}${label ? `(${encodeURIComponent(label)})` : ''}`
  }
  const address = (dest.address ?? '').trim()
  if (address) return `geo:0,0?q=${encodeURIComponent(address)}`
  return `geo:0,0?q=${dest.lat},${dest.lng}`
}

// https-ссылка на маршрут в Яндекс.Картах: `~` означает «откуда» = текущее местоположение
// пользователя, дальше идёт точка назначения. Координаты приоритетнее текста — навигатор
// не переспрашивает адрес и не теряет точку.
export function buildWebRouteUri(dest: RoutePoint): string {
  const address = (dest.address ?? '').trim()
  const target = hasRouteCoords(dest) ? `${dest.lat},${dest.lng}` : encodeURIComponent(address)
  return `https://yandex.ru/maps/?rtext=~${target}&rtt=auto`
}

export function openRoute(dest: RoutePoint): void {
  if (!dest) return
  const hasAddress = Boolean((dest.address ?? '').trim())
  if (!hasRouteCoords(dest) && !hasAddress) return

  if (isNativeAndroid()) {
    // `_system` заставляет Capacitor передать ссылку операционной системе,
    // которая показывает выбор приложения для навигации.
    // Координаты есть — отдаём geo: (любой навигатор построит маршрут к точке).
    // Координат нет — открываем ссылку Яндекс.Карт: она сама находит дом по адресу.
    window.open(
      hasRouteCoords(dest) ? buildRouteUri(dest) : buildWebRouteUri(dest),
      '_system',
    )
    return
  }

  // В браузере — новая вкладка, в Telegram Mini App — средства клиента Telegram.
  openExternalLink(buildWebRouteUri(dest))
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
