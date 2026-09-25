// Промисная обёртка над облачным хранилищем Telegram (WebApp.CloudStorage, Bot API 6.9+).
//
// Зачем облако: данные CRM лежат в localStorage WebView устройства, а он исчезает при
// очистке данных Telegram, переустановке клиента или смене телефона. Значения в
// CloudStorage привязаны к аккаунту Telegram, поэтому копия доступна с любого
// устройства, где открыт мини-апп (см. src/db/cloudBackup.ts).
//
// Клиент отдаёт результат в callback (error, result), а при старом клиенте
// (младше Bot API 6.9) вообще выбрасывает WebAppMethodUnsupported. Здесь всё сведено
// к промисам и понятным русским сообщениям: экран настроек показывает текст ошибки
// как есть, без технических кодов.
//
// Вне Telegram (`cloudStorageSupported() === false`) функций вызывать нельзя: они
// отвергают промис, поэтому интерфейс сначала спрашивает о поддержке и, если облака нет,
// объясняет причину по `cloudStorageAvailability()`.

import { getTelegramWebApp, isTelegramEnvironment, type TelegramCloudStorage } from './webapp'

// Ошибки клиента, которые пользователю нужно объяснить человеческим языком.
const CLOUD_ERROR_TEXT: Record<string, string> = {
  WebAppMethodUnsupported:
    'Облако Telegram недоступно: версия клиента устарела. Обновите Telegram и попробуйте снова',
  UNKNOWN_ERROR: 'Telegram не ответил на запрос к облаку. Проверьте интернет и попробуйте снова',
  VALUE_TOO_LONG: 'Telegram не принял слишком большое значение. Сохраните копию заново',
  KEY_TOO_LONG: 'Telegram не принял слишком длинное имя ключа',
  STORAGE_LIMIT_EXCEEDED: 'В облаке Telegram закончилось место: удалите ненужные копии',
}

// Доступно ли облако в текущем окружении: только внутри Telegram и только в клиентах
// Bot API 6.9+. Этот признак решает интерфейс — показывать облачные кнопки или нет.
export function cloudStorageSupported(): boolean {
  return cloudStorageAvailability() === 'ready'
}

// Почему облака нет — чтобы интерфейс объяснял причину, а не просто прятал кнопки:
//   ready            — мини-приложение в Telegram, клиент умеет CloudStorage (Bot API 6.9+);
//   old-client       — Telegram есть, но клиент старее: облачных методов в нём нет, нужно обновление;
//   outside-telegram — браузер или Android-сборка: облако есть только у мини-приложения.
//
// Проверять один лишь window.Telegram нельзя: официальный telegram-web-app.js создаёт в браузере
// объект-заглушку с пустым initData и platform = 'unknown', а облака в нём нет.
export type CloudStorageAvailability = 'ready' | 'old-client' | 'outside-telegram'

export function cloudStorageAvailability(): CloudStorageAvailability {
  const app = getTelegramWebApp()
  if (isTelegramEnvironment() && app?.CloudStorage) return 'ready'
  const insideClient = Boolean(app?.initData) || Boolean(app?.platform && app.platform !== 'unknown')
  return insideClient ? 'old-client' : 'outside-telegram'
}

function cloudApi(): TelegramCloudStorage {
  const app = getTelegramWebApp()
  const storage = app?.CloudStorage
  if (!isTelegramEnvironment() || !storage) {
    throw new Error(
      'Облако Telegram доступно только в мини-приложении Telegram: откройте SelfCRM из бота',
    )
  }
  return storage
}

// error приходит строкой (код Telegram) или объектом ошибки — приводим к тексту.
function cloudFailure(action: string, error: unknown): Error {
  const code =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error
          ? String(error)
          : ''
  const known = CLOUD_ERROR_TEXT[code]
  if (known) return new Error(known)
  return new Error(code ? `Не удалось ${action}. Telegram вернул ошибку: ${code}` : `Не удалось ${action}`)
}

// Общий путь всех вызовов: подписка на callback клиента + превращение ошибки в reject.
function callCloud<T>(
  action: string,
  run: (api: TelegramCloudStorage, done: (error: string | null, result?: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let api: TelegramCloudStorage
    try {
      api = cloudApi()
    } catch (e) {
      reject(e)
      return
    }
    try {
      run(api, (error, result) => {
        if (error) reject(cloudFailure(action, error))
        else resolve(result as T)
      })
    } catch (e) {
      // Старый клиент падает ещё до callback (WebAppMethodUnsupported).
      reject(cloudFailure(action, e))
    }
  })
}

export function cloudSetItem(key: string, value: string): Promise<void> {
  return callCloud<void>('сохранить данные в облаке Telegram', (api, done) => {
    api.setItem(key, value, (error) => done(error))
  })
}

// Значение ключа или null, если ключа в облаке нет: для интерфейса «копии нет» — это
// обычное состояние, а не ошибка.
export function cloudGetItem(key: string): Promise<string | null> {
  return callCloud<string | null>('прочитать данные из облака Telegram', (api, done) => {
    api.getItem(key, (error, result) => done(error, result ?? null))
  })
}

// Значения нескольких ключей сразу: читать и писать копию по частям (см. cloudBackup)
// дешевле одним запросом, чем сотней отдельных.
export function cloudGetItems(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return Promise.resolve({})
  return callCloud<Record<string, string>>(
    'прочитать данные из облака Telegram',
    (api, done) => {
      api.getItems(keys, (error, result) => done(error, result ?? {}))
    },
  )
}

export function cloudRemoveItems(keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve()
  return callCloud<void>('удалить данные из облака Telegram', (api, done) => {
    api.removeItems(keys, (error) => done(error))
  })
}

// Все ключи, которые приложение уже положило в облако: по ним видно части прежней
// копии, которые надо убрать после сохранения новой.
export function cloudGetKeys(): Promise<string[]> {
  return callCloud<string[]>('прочитать список ключей в облаке Telegram', (api, done) => {
    api.getKeys((error, result) => done(error, result ?? []))
  })
}
