// Telegram WebApp API (https://core.telegram.org/bots/webapps).
//
// Отдельный SDK не подключаем: объект window.Telegram.WebApp создаёт сам клиент
// Telegram (в index.html подключён официальный telegram-web-app.js). Здесь описан
// только минимально необходимый набор интерфейса SelfCRM.
//
// Важно: приложение обязано работать и без Telegram (обычный браузер, Pages),
// поэтому все функции этого модуля возвращают null вместо исключений.

export interface TelegramThemeParams {
  bg_color?: string
  text_color?: string
  hint_color?: string
  link_color?: string
  button_color?: string
  button_text_color?: string
  secondary_bg_color?: string
  header_bg_color?: string
  accent_text_color?: string
  section_bg_color?: string
  section_header_text_color?: string
  subtitle_text_color?: string
  destructive_text_color?: string
}

// Данные пользователя из initDataUnsafe. Это НЕ проверенные данные: их подписывает
// Telegram, но проверить подпись можно только на сервере (initData → server validation).
// В SelfCRM они используются лишь для подписи резервной копии и для отображения.
export interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

export interface TelegramInitDataUnsafe {
  user?: TelegramUser
  auth_date?: number
  hash?: string
  start_param?: string
}

export interface TelegramBackButton {
  isVisible: boolean
  show(): void
  hide(): void
  onClick(callback: () => void): void
  offClick(callback: () => void): void
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
  notificationOccurred(type: 'error' | 'success' | 'warning'): void
  selectionChanged(): void
}

export interface TelegramWebApp {
  initData: string
  initDataUnsafe: TelegramInitDataUnsafe
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  themeParams: TelegramThemeParams
  isExpanded: boolean
  viewportHeight: number
  viewportStableHeight: number
  headerColor: string
  backgroundColor: string
  BackButton: TelegramBackButton
  HapticFeedback?: TelegramHapticFeedback
  ready(): void
  expand(): void
  close(): void
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  // Открывает чат Telegram внутри клиента (t.me-ссылки в WebView иначе уводят в браузер).
  openTelegramLink?(url: string): void
  onEvent(event: string, handler: () => void): void
  offEvent(event: string, handler: () => void): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

// Объект Telegram WebApp или null, если приложение открыто вне Telegram.
export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null
  return window.Telegram?.WebApp ?? null
}

export function isTelegramEnvironment(): boolean {
  const app = getTelegramWebApp()
  return Boolean(app && (app.initData || app.platform))
}

// Telegram ID пользователя — только для идентификации (подпись backup, будущие
// уведомления). Никогда не используется как первичный ключ данных CRM.
export function getTelegramUserId(): number | null {
  const id = getTelegramWebApp()?.initDataUnsafe?.user?.id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

// Человекочитаемое имя пользователя для интерфейса резервных копий.
export function getTelegramUserLabel(): string | null {
  const user = getTelegramWebApp()?.initDataUnsafe?.user
  if (!user) return null
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return name || user.username || null
}

// Чат с ботом, куда пользователь сам отправляет файл резервной копии. Ни токена, ни
// идентификаторов тут нет — это обычная публичная ссылка, её можно показать и в браузере.
export const TELEGRAM_BOT_URL = 'https://t.me/fastcrm_bot'

// Открывает чат с ботом: в Telegram — средствами клиента (WebApp.openTelegramLink),
// в браузере — обычной новой вкладкой. Ошибки не показываем: если браузер заблокировал
// переход, пользователь сам найдёт бота по имени @fastcrm_bot.
export function openBotChat(url: string = TELEGRAM_BOT_URL): void {
  const app = getTelegramWebApp()
  if (app?.openTelegramLink) {
    app.openTelegramLink(url)
    return
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
}
