import { afterEach, describe, expect, it, vi } from 'vitest'

// Android-сборка (Capacitor) включается флагом из @capacitor/core: в тестах он подменяется,
// чтобы проверить путь с `_system` — в WebView обычный переход по ссылке игнорируется.
const capacitor = vi.hoisted(() => ({ native: false }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}))

import {
  insideTelegramWebView,
  isTelegramEnvironment,
  openBotChat,
  openExternalLink,
  openInvoice,
  TELEGRAM_BOT_URL,
  type TelegramWebApp,
} from './webapp'

afterEach(() => {
  capacitor.native = false
  vi.unstubAllGlobals()
})

// Заглушка окна: запоминает вызовы window.open и, если нужно, отдаёт результат (null —
// браузер заблокировал переход). `extra` добавляет признаки клиента Telegram — например,
// прокси, через который события доходят до клиента во встроенном браузере.
function stubWindow(
  webApp?: Partial<TelegramWebApp>,
  openResult: unknown = {},
  extra: Record<string, unknown> = {},
) {
  const calls: Array<{ url: string; target?: string }> = []
  vi.stubGlobal('window', {
    Telegram: webApp ? { WebApp: webApp } : undefined,
    open: (url: string, target?: string) => {
      calls.push({ url, target })
      return openResult
    },
    ...extra,
  })
  return calls
}

describe('определение окружения', () => {
  it('мини-приложение узнаётся по данным клиента', () => {
    stubWindow({ initData: 'query_id=1', platform: 'android' })
    expect(isTelegramEnvironment()).toBe(true)
  })

  it('клиент без initData узнаётся по названной платформе', () => {
    stubWindow({ initData: '', platform: 'weba' })
    expect(isTelegramEnvironment()).toBe(true)
  })

  it('в обычном браузере окружение не телеграмное', () => {
    // telegram-web-app.js подключается самой страницей, а платформу вне Telegram
    // оставляет равной 'unknown'. Из-за этой строки приложение раньше считало себя
    // мини-приложением в любом браузере: ссылки «открывались в пустоту», а PDF не
    // сохранялся, потому что клиент файл не принимает.
    stubWindow({ initData: '', platform: 'unknown' })
    expect(isTelegramEnvironment()).toBe(false)
  })

  it('объект WebApp без данных Telegram окружением не считается', () => {
    stubWindow({ initData: '', platform: '' })
    expect(isTelegramEnvironment()).toBe(false)

    stubWindow()
    expect(isTelegramEnvironment()).toBe(false)

    vi.stubGlobal('window', undefined)
    expect(isTelegramEnvironment()).toBe(false)
  })

  it('встроенный браузер Telegram узнаётся по прокси клиента', () => {
    // Данных мини-приложения там нет, но события уходят клиенту через прокси.
    stubWindow({ initData: '', platform: 'unknown' }, {}, { TelegramWebviewProxy: {} })
    expect(insideTelegramWebView()).toBe(true)
  })

  it('обычный браузер не считается WebView клиента', () => {
    stubWindow({ initData: '', platform: 'unknown' })
    expect(insideTelegramWebView()).toBe(false)

    vi.stubGlobal('window', undefined)
    expect(insideTelegramWebView()).toBe(false)
  })
})

describe('TELEGRAM_BOT_URL', () => {
  it('ведёт в чат с ботом @fastcrm_bot', () => {
    expect(TELEGRAM_BOT_URL).toBe('https://t.me/fastcrm_bot')
  })
})

describe('openExternalLink', () => {
  it('ссылку t.me открывает как чат Telegram', () => {
    const openTelegramLink = vi.fn()
    const openLink = vi.fn()
    stubWindow({ initData: 'query_id=1', platform: 'android', openTelegramLink, openLink })

    expect(openExternalLink('https://t.me/fastcrm_bot')).toBe('telegram')
    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/fastcrm_bot')
    expect(openLink).not.toHaveBeenCalled()
  })

  it('обычную ссылку (маршрут, мессенджер) открывает через openLink', () => {
    const openTelegramLink = vi.fn()
    const openLink = vi.fn()
    stubWindow({ initData: 'query_id=1', platform: 'android', openTelegramLink, openLink })

    expect(openExternalLink('https://yandex.ru/maps/?rtext=~55.76,37.61&rtt=auto')).toBe('telegram')
    expect(openLink).toHaveBeenCalledWith('https://yandex.ru/maps/?rtext=~55.76,37.61&rtt=auto')
    expect(openTelegramLink).not.toHaveBeenCalled()
  })

  it('вне Telegram открывает внешнюю ссылку в новой вкладке', () => {
    const calls = stubWindow()

    expect(openExternalLink('https://wa.me/79001112233')).toBe('browser')
    expect(calls).toEqual([{ url: 'https://wa.me/79001112233', target: '_blank' }])
  })

  it('в обычном браузере ссылку открывает вкладка, а не клиент Telegram', () => {
    // Скрипт telegram-web-app.js загружен страницей, платформа 'unknown': запрос
    // `openLink` ушёл бы в пустоту, поэтому вкладку открывает сам браузер.
    const openLink = vi.fn()
    const calls = stubWindow({ initData: '', platform: 'unknown', openLink })

    expect(openExternalLink('https://wa.me/79001112233')).toBe('browser')
    expect(openLink).not.toHaveBeenCalled()
    expect(calls).toEqual([{ url: 'https://wa.me/79001112233', target: '_blank' }])
  })

  it('во встроенном браузере Telegram открывает ссылку через клиент', () => {
    // Данных мини-приложения там нет, но прокси клиента есть — запрос доходит.
    const openLink = vi.fn()
    const calls = stubWindow(
      { initData: '', platform: 'unknown', openLink },
      {},
      { TelegramWebviewProxy: {} },
    )

    expect(openExternalLink('https://wa.me/79001112233')).toBe('telegram')
    expect(openLink).toHaveBeenCalledWith('https://wa.me/79001112233')
    expect(calls).toEqual([])
  })
})

describe('openBotChat', () => {
  it('в Mini App открывает чат средствами клиента Telegram', () => {
    const openTelegramLink = vi.fn()
    const calls = stubWindow({ initData: 'query_id=1', platform: 'android', openTelegramLink })

    expect(openBotChat()).toBe('telegram')
    expect(openTelegramLink).toHaveBeenCalledWith(TELEGRAM_BOT_URL)
    // window.open в WebView мини-приложения игнорируется — использовать его нельзя.
    expect(calls).toEqual([])
  })

  it('использует openLink, если клиент не умеет openTelegramLink', () => {
    const openLink = vi.fn()
    const calls = stubWindow({ initData: 'query_id=1', platform: 'ios', openLink })

    expect(openBotChat()).toBe('telegram')
    expect(openLink).toHaveBeenCalledWith(TELEGRAM_BOT_URL)
    expect(calls).toEqual([])
  })

  it('вне Telegram открывает новую вкладку браузера', () => {
    // Скрипт telegram-web-app.js загружается и в браузере: объекта WebApp без данных
    // Telegram недостаточно, чтобы считать окружение телеграмным.
    const calls = stubWindow({ initData: '', platform: '' })

    expect(openBotChat()).toBe('browser')
    expect(calls).toEqual([{ url: TELEGRAM_BOT_URL, target: '_blank' }])
  })

  it('в Android-сборке передаёт ссылку системе (_system)', () => {
    capacitor.native = true
    const calls = stubWindow()

    expect(openBotChat()).toBe('system')
    expect(calls).toEqual([{ url: TELEGRAM_BOT_URL, target: '_system' }])
  })

  it('сообщает о неудаче, если ссылку открыть не удалось', () => {
    stubWindow(undefined, null)
    expect(openBotChat()).toBe('failed')

    vi.stubGlobal('window', undefined)
    expect(openBotChat()).toBe('failed')
  })

  it('открывает ту ссылку, которую передали', () => {
    const openTelegramLink = vi.fn()
    stubWindow({ platform: 'desktop', openTelegramLink })

    expect(openBotChat('https://t.me/other_bot')).toBe('telegram')
    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/other_bot')
  })
})

// Оплата звёздами: ссылку на счёт выдаёт бот, а платёжный лист показывает клиент Telegram.
describe('openInvoice', () => {
  it('в мини-приложении открывает счёт и передаёт статус оплаты', () => {
    const urls: string[] = []
    stubWindow({
      initData: 'query_id=1',
      platform: 'android',
      openInvoice: (url, callback) => {
        urls.push(url)
        callback?.('paid')
      },
    })

    const statuses: string[] = []
    const opened = openInvoice('https://t.me/$invoice', (status) => statuses.push(status))

    expect(opened).toBe(true)
    expect(urls).toEqual(['https://t.me/$invoice'])
    expect(statuses).toEqual(['paid'])
  })

  it('в браузере оплата недоступна: открыть счёт нечем', () => {
    vi.stubGlobal('window', {})
    expect(openInvoice('https://t.me/$invoice', () => undefined)).toBe(false)
  })

  it('в старом клиенте без openInvoice оплата тоже недоступна', () => {
    stubWindow({ initData: 'query_id=1', platform: 'android' })
    expect(openInvoice('https://t.me/$invoice', () => undefined)).toBe(false)
  })
})
