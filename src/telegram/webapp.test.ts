import { afterEach, describe, expect, it, vi } from 'vitest'

// Android-сборка (Capacitor) включается флагом из @capacitor/core: в тестах он подменяется,
// чтобы проверить путь с `_system` — в WebView обычный переход по ссылке игнорируется.
const capacitor = vi.hoisted(() => ({ native: false }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}))

import { openBotChat, TELEGRAM_BOT_URL, type TelegramWebApp } from './webapp'

afterEach(() => {
  capacitor.native = false
  vi.unstubAllGlobals()
})

// Заглушка окна: запоминает вызовы window.open и, если нужно, отдаёт результат (null —
// браузер заблокировал переход).
function stubWindow(webApp?: Partial<TelegramWebApp>, openResult: unknown = {}) {
  const calls: Array<{ url: string; target?: string }> = []
  vi.stubGlobal('window', {
    Telegram: webApp ? { WebApp: webApp } : undefined,
    open: (url: string, target?: string) => {
      calls.push({ url, target })
      return openResult
    },
  })
  return calls
}

describe('TELEGRAM_BOT_URL', () => {
  it('ведёт в чат с ботом @fastcrm_bot', () => {
    expect(TELEGRAM_BOT_URL).toBe('https://t.me/fastcrm_bot')
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
