// Telegram WebApp API (https://core.telegram.org/bots/webapps).
//
// Отдельный SDK не подключаем: объект window.Telegram.WebApp создаёт сам клиент
// Telegram (в index.html подключён официальный telegram-web-app.js). Здесь описан
// только минимально необходимый набор интерфейса SelfCRM.
//
// Важно: приложение обязано работать и без Telegram (обычный браузер, Pages),
// поэтому все функции этого модуля возвращают null вместо исключений.

import { Capacitor } from '@capacitor/core'

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

// Облачное хранилище Telegram (Bot API 6.9+). Значения лежат не на устройстве, а в
// облаке аккаунта Telegram, поэтому переживают очистку данных клиента и доступны на
// другом телефоне. Так же устроены и другие методы клиента: результат отдаётся в
// callback (error, result), а не промисом — промисную обёртку см. в src/telegram/cloudStorage.ts.
//
// Ограничения клиента: не больше 1024 ключей и не больше 4096 символов в значении.
export type TelegramCloudCallback<T> = (error: string | null, result?: T) => void

export interface TelegramCloudStorage {
  setItem(key: string, value: string, callback?: TelegramCloudCallback<boolean>): TelegramCloudStorage
  getItem(key: string, callback?: TelegramCloudCallback<string>): TelegramCloudStorage
  getItems(
    keys: string[],
    callback?: TelegramCloudCallback<Record<string, string>>,
  ): TelegramCloudStorage
  removeItem(key: string, callback?: TelegramCloudCallback<boolean>): TelegramCloudStorage
  removeItems(keys: string[], callback?: TelegramCloudCallback<boolean>): TelegramCloudStorage
  getKeys(callback?: TelegramCloudCallback<string[]>): TelegramCloudStorage
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
  // Есть только в клиентах Bot API 6.9+ и только в Telegram: вне мини-приложения
  // облака нет, поэтому все вызовы сначала проверяют наличие (см. cloudStorageSupported).
  CloudStorage?: TelegramCloudStorage
  ready(): void
  expand(): void
  close(): void
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  // Открывает ссылку в браузере средствами клиента (t.me-ссылки клиент обрабатывает сам).
  openLink?(url: string, options?: { try_instant_view?: boolean }): void
  // Открывает чат/канал Telegram внутри клиента: обычный window.open в WebView
  // игнорируется, поэтому без этого вызова нажатие выглядит как «ничего не произошло».
  openTelegramLink?(url: string): void
  // Оплата звёздами Telegram (Bot API 6.1+): клиент показывает свой платёжный лист,
  // а результат отдаёт в callback — строка 'paid', 'cancelled', 'failed' или 'pending'.
  openInvoice?(url: string, callback?: (status: string) => void): void
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

// Открыто ли приложение в клиенте Telegram (Mini App).
//
// Проверка по данным клиента, а не по самому объекту: официальный telegram-web-app.js
// подключается страницей и создаёт `window.Telegram.WebApp` в любом браузере, а поле
// `platform` вне Telegram равно строке 'unknown' (см. webAppPlatform в этом скрипте).
// Раньше непустая строка считалась признаком Telegram, и SelfCRM в обычном браузере
// считала себя мини-приложением: ссылки «открывались» запросами, которых никто не
// получал, а файлы не сохранялись. Теперь клиент должен назвать себя сам — `initData`
// или платформа (`android`, `ios`, `tdesktop`, `macos`, `web`, `weba`, `webk`).
export function isTelegramEnvironment(): boolean {
  const app = getTelegramWebApp()
  if (!app) return false
  if (app.initData) return true
  return Boolean(app.platform && app.platform !== 'unknown')
}

// Доходят ли запросы до клиента Telegram: мини-приложение или другой WebView клиента
// (встроенный браузер, где Telegram тоже вставляет свой прокси). В обоих случаях файл
// из страницы сохранить нельзя — клиент игнорирует blob-ссылки и `<a download>`, — а
// ссылки открывает сам клиент: `window.open` в WebView остаётся без ответа.
//
// Признаки повторяют то, по чему сам telegram-web-app.js отправляет события
// (WebView.postEvent): прокси клиента или `window.external.notify` в Windows-клиенте.
export function insideTelegramWebView(): boolean {
  if (typeof window === 'undefined') return false
  if (isTelegramEnvironment()) return true
  // Скрипт Telegram не загрузился — значит, это не клиент Telegram.
  if (!getTelegramWebApp()) return false
  const proxy = (window as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy
  if (proxy !== undefined) return true
  const external = window.external as { notify?: unknown } | undefined
  return Boolean(external && 'notify' in external)
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

// Куда в итоге попал пользователь: в клиент Telegram, в системный браузер (Android-сборка)
// или в новую вкладку браузера. 'failed' — ссылку открыть не удалось, и интерфейс должен
// сказать об этом текстом: иначе нажатие выглядит как «ничего не произошло».
export type BotChatTarget = 'telegram' | 'system' | 'browser' | 'failed'

// Ссылка на чат/канал Telegram: только такие адреса клиент умеет открывать внутри себя.
function isTelegramLink(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 't.me'
  } catch {
    return false
  }
}

// Открывает внешнюю ссылку (чат с ботом, маршрут в картах, переписку в мессенджере).
//
// В WebView клиента Telegram это делает сам клиент: обычные `window.open` и клики по
// ссылкам внутри мини-приложения игнорируются, поэтому раньше нажатия заканчивались только
// вибрацией. Ссылки `t.me` открываются через `openTelegramLink` (чат — внутри клиента),
// все остальные — через `openLink` (клиент открывает их в браузере). Признак — WebView
// клиента (`insideTelegramWebView`), а не сам объект WebApp: скрипт Telegram загружается
// и в обычном браузере, где ни один запрос до клиента не доходит.
// В Android-сборке (Capacitor) работает только `_system`: с ним ссылка уходит операционной
// системе. В браузере — обычная новая вкладка.
export function openExternalLink(url: string): BotChatTarget {
  const app = getTelegramWebApp()
  if (insideTelegramWebView()) {
    if (isTelegramLink(url) && app?.openTelegramLink) {
      app.openTelegramLink(url)
      return 'telegram'
    }
    if (app?.openLink) {
      app.openLink(url)
      return 'telegram'
    }
  }
  if (typeof window === 'undefined') return 'failed'
  if (Capacitor.isNativePlatform()) {
    window.open(url, '_system')
    return 'system'
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  return opened ? 'browser' : 'failed'
}

// Открывает чат с ботом (частный случай внешней ссылки).
export function openBotChat(url: string = TELEGRAM_BOT_URL): BotChatTarget {
  return openExternalLink(url)
}

// Оплата звёздами Telegram: ссылку на счёт выдаёт бот (createInvoiceLink), а платёжный лист
// показывает клиент — в WebView это единственный работающий способ, обычный переход по
// ссылке там игнорируется. false означает, что оплатить в этом окружении нельзя (браузер
// или старый клиент): интерфейс тогда предлагает бота, где те же счета приходят сообщением.
export function openInvoice(url: string, onStatus: (status: string) => void): boolean {
  const app = getTelegramWebApp()
  if (!insideTelegramWebView() || !app?.openInvoice) return false
  app.openInvoice(url, onStatus)
  return true
}
