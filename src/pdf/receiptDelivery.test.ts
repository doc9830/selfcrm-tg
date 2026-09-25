import { afterEach, describe, expect, it, vi } from 'vitest'

// Android-сборка включается флагом из @capacitor/core, а в тестах путь доставки
// выбирается явно — модуль подменяется, чтобы импорт webapp.ts не тянул платформу.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}))

import { canShareFiles, copyReceiptLink, planReceiptDelivery, shareReceiptFile, shareReceiptLink } from './receiptDelivery'
import type { TelegramWebApp } from '../telegram/webapp'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Заглушка окна: запоминает вызовы window.open (вне Telegram сюда попадают только
// ссылки, которые клиент открыть не смог). `extra` добавляет признаки клиента — например,
// прокси, по которому telegram-web-app.js отправляет события во встроенном браузере.
function stubWindow(webApp?: Partial<TelegramWebApp>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; target?: string }> = []
  vi.stubGlobal('window', {
    Telegram: webApp ? { WebApp: webApp } : undefined,
    open: (url: string, target?: string) => {
      calls.push({ url, target })
      return {}
    },
    ...extra,
  })
  return calls
}

function stubNavigator(value: unknown) {
  vi.stubGlobal('navigator', value)
}

describe('выбор способа доставки', () => {
  it('в Android-сборке файл пишется на устройство', () => {
    expect(planReceiptDelivery({ native: true, canShareFiles: false, telegram: false })).toBe('native')
  })

  it('там, где клиент умеет делиться файлом, уходит файл', () => {
    expect(planReceiptDelivery({ native: false, canShareFiles: true, telegram: false })).toBe(
      'file-share',
    )
  })

  it('в Telegram ссылка важнее файла, даже если WebView обещает canShare', () => {
    // WebView клиента (так ведёт себя, например, Android) объявляет и `navigator.share`, и
    // `canShare` для PDF, но системного меню у него нет: нажатие «Чек (PDF)» не делало
    // ничего. Клиент Telegram умеет открыть выбор чата по ссылке — этот путь и выбирается.
    expect(planReceiptDelivery({ native: false, canShareFiles: true, telegram: true })).toBe(
      'link-share',
    )
    // Нативная сборка важнее всего: там файл пишется на устройство.
    expect(planReceiptDelivery({ native: true, canShareFiles: true, telegram: true })).toBe('native')
  })

  it('в Telegram Mini App без файлов уходит ссылка', () => {
    // Клиент Telegram не сохраняет blob и не показывает blob-ссылки, поэтому
    // единственный рабочий путь — адрес страницы чека. Путь один для iPhone и Android.
    expect(planReceiptDelivery({ native: false, canShareFiles: false, telegram: true })).toBe(
      'link-share',
    )
  })

  it('в обычном браузере файл просто скачивается', () => {
    expect(planReceiptDelivery({ native: false, canShareFiles: false, telegram: false })).toBe(
      'file-download',
    )
  })
})

describe('canShareFiles', () => {
  it('без navigator или File файлы недоступны', () => {
    stubNavigator(undefined)
    expect(canShareFiles()).toBe(false)

    stubNavigator({ share: () => Promise.resolve(), canShare: () => true })
    vi.stubGlobal('File', undefined)
    expect(canShareFiles()).toBe(false)
  })

  it('без Web Share API файлы недоступны', () => {
    stubNavigator({})
    vi.stubGlobal('File', class {})
    expect(canShareFiles()).toBe(false)
  })

  it('спрашивает у клиента про PDF, а не про платформу', () => {
    const probe: unknown[] = []
    stubNavigator({
      share: () => Promise.resolve(),
      canShare: (data: { files?: unknown[] }) => {
        probe.push(...(data.files ?? []))
        return true
      },
    })
    vi.stubGlobal(
      'File',
      class {
        constructor(
          public parts: unknown[],
          public name: string,
          public options: { type?: string },
        ) {}
      },
    )

    expect(canShareFiles()).toBe(true)
    expect(probe).toHaveLength(1)
    expect(probe[0]).toMatchObject({ name: 'check.pdf', options: { type: 'application/pdf' } })
  })

  it('ошибка проверки считается отказом, а не поломкой', () => {
    stubNavigator({
      share: () => Promise.resolve(),
      canShare: () => {
        throw new Error('не поддерживается')
      },
    })
    vi.stubGlobal('File', class {})

    expect(canShareFiles()).toBe(false)
  })
})

describe('shareReceiptFile', () => {
  const file = { name: 'check.pdf', type: 'application/pdf' } as unknown as File
  const text = 'Чек по заказу №42 от 19.09.2026'

  it('без Web Share API файл отдать нечем', async () => {
    stubNavigator(undefined)
    expect(await shareReceiptFile(file, text)).toBe('unavailable')

    stubNavigator({})
    expect(await shareReceiptFile(file, text)).toBe('unavailable')
  })

  it('отдаёт PDF системному меню — один путь и на iPhone, и на Android', async () => {
    const share = vi.fn(() => Promise.resolve())
    stubNavigator({ share })

    expect(await shareReceiptFile(file, text)).toBe('shared')
    // В меню уходит сам файл, а не blob и не ссылка: меню «Поделиться» принимает файлы.
    expect(share).toHaveBeenCalledWith({ files: [file], title: text, text })
  })

  it('отмена системного меню — не ошибка', async () => {
    const abort = Object.assign(new Error('отмена'), { name: 'AbortError' })
    stubNavigator({ share: () => Promise.reject(abort) })

    expect(await shareReceiptFile(file, text)).toBe('cancelled')
  })

  it('отказ клиента — повод перейти к ссылке', async () => {
    // Так ведёт себя WebView, который объявил Web Share API, но файлов не принимает.
    stubNavigator({ share: () => Promise.reject(new Error('файлы не поддерживаются')) })

    expect(await shareReceiptFile(file, text)).toBe('unavailable')
  })
})

describe('shareReceiptLink', () => {
  const url = 'https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.abc'
  const text = 'Чек по заказу №42 от 19.09.2026'

  it('в Mini App открывает выбор чата средствами клиента Telegram', async () => {
    const openTelegramLink = vi.fn()
    const openLink = vi.fn()
    const calls = stubWindow({ initData: 'query_id=1', platform: 'ios', openTelegramLink, openLink })

    expect(await shareReceiptLink(url, text)).toBe('opened')
    expect(openTelegramLink).toHaveBeenCalledWith(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    )
    // window.open в мини-приложении игнорируется — им пользоваться нельзя.
    expect(calls).toEqual([])
  })

  it('использует openLink, если клиент не умеет openTelegramLink', async () => {
    const openLink = vi.fn()
    stubWindow({ initData: 'query_id=1', platform: 'android', openLink })

    expect(await shareReceiptLink(url, text)).toBe('opened')
    expect(openLink).toHaveBeenCalledTimes(1)
  })

  it('во встроенном браузере Telegram выбор чата тоже открывает клиент', async () => {
    // Встроенный браузер клиента данных мини-приложения не получает (initData пуст,
    // платформа 'unknown'), но события до клиента доходят через его прокси.
    const openLink = vi.fn()
    const calls = stubWindow(
      { initData: '', platform: 'unknown', openLink },
      { TelegramWebviewProxy: {} },
    )

    expect(await shareReceiptLink(url, text)).toBe('opened')
    expect(openLink).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('в обычном браузере ссылку отдаёт системное меню, хотя скрипт Telegram загружен', async () => {
    // Скрипт telegram-web-app.js подключается страницей: объекта WebApp самого по себе
    // недостаточно, чтобы считать браузер телеграмным — иначе запрос уходил в пустоту.
    const share = vi.fn(() => Promise.resolve())
    stubNavigator({ share })
    const calls = stubWindow({ initData: '', platform: 'unknown' })

    expect(await shareReceiptLink(url, text)).toBe('opened')
    expect(share).toHaveBeenCalledWith({ title: text, text, url })
    expect(calls).toEqual([])
  })

  it('вне Telegram отдаёт ссылку системному меню «Поделиться»', async () => {
    const share = vi.fn(() => Promise.resolve())
    stubNavigator({ share })

    expect(await shareReceiptLink(url, text)).toBe('opened')
    expect(share).toHaveBeenCalledWith({ title: text, text, url })
  })

  it('отмена системного меню — это не ошибка', async () => {
    const abort = Object.assign(new Error('отмена'), { name: 'AbortError' })
    stubNavigator({ share: () => Promise.reject(abort) })

    expect(await shareReceiptLink(url, text)).toBe('opened')
  })

  it('отказ системного меню лечится копией ссылки', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubNavigator({
      share: () => Promise.reject(new Error('не разрешено')),
      clipboard: { writeText },
    })

    expect(await shareReceiptLink(url, text)).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(`${text}\n${url}`)
  })

  it('когда ничего не получилось — сообщает о неудаче', async () => {
    stubNavigator({ clipboard: { writeText: () => Promise.reject(new Error('нет доступа')) } })
    expect(await shareReceiptLink(url, text)).toBe('failed')

    stubNavigator({})
    expect(await shareReceiptLink(url, text)).toBe('failed')
  })
})

describe('copyReceiptLink', () => {
  const url = 'https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.abc'
  const text = 'Чек по заказу №42 от 19.09.2026'

  it('кладёт в буфер обмена подпись и адрес чека', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubNavigator({ clipboard: { writeText } })

    expect(await copyReceiptLink(url, text)).toBe(true)
    // Ссылка идёт следом за подписью: скопированное можно вставить в чат как есть.
    expect(writeText).toHaveBeenCalledWith(`${text}\n${url}`)
  })

  it('без буфера обмена честно сообщает о неудаче', async () => {
    stubNavigator({ clipboard: { writeText: () => Promise.reject(new Error('нет доступа')) } })
    expect(await copyReceiptLink(url, text)).toBe(false)

    stubNavigator({})
    expect(await copyReceiptLink(url, text)).toBe(false)
  })
})
