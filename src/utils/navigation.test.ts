import { afterEach, describe, expect, it, vi } from 'vitest'

// Android-сборка (Capacitor) включается флагом из @capacitor/core: в тестах он подменяется,
// чтобы проверить путь с `_system` — в WebView обычный переход по ссылке игнорируется.
const capacitor = vi.hoisted(() => ({ native: false }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}))

import type { TelegramWebApp } from '../telegram/webapp'
import {
  buildAddressSearchUri,
  buildRouteUri,
  buildTelUri,
  buildTelegramAppUri,
  buildTelegramUri,
  buildWebRouteUri,
  buildWhatsAppAppUri,
  buildWhatsAppUri,
  hasRouteCoords,
  openRoute,
  openTelegram,
  openWhatsApp,
  phoneDigits,
  routeBridgeUrl,
} from './navigation'

afterEach(() => {
  capacitor.native = false
  vi.unstubAllGlobals()
})

// Заглушка окна: запоминает вызовы window.open, отдаёт объект Telegram WebApp, адрес
// приложения (от него собираются страницы-мосты) и флаг нативной сборки — так проверяются
// все три окружения открытия ссылок.
function stubWindow(
  options: {
    webApp?: Partial<TelegramWebApp>
    native?: boolean
    location?: { href: string }
  } = {},
) {
  const calls: Array<{ url: string; target?: string }> = []
  vi.stubGlobal('window', {
    Telegram: options.webApp ? { WebApp: options.webApp } : undefined,
    Capacitor: options.native
      ? { isNativePlatform: () => true, getPlatform: () => 'android' }
      : undefined,
    location: options.location ?? { href: 'https://doc9830.github.io/selfcrm-tg/#/clients/1' },
    open: (url: string, target?: string) => {
      calls.push({ url, target })
      return {}
    },
  })
  return calls
}

describe('hasRouteCoords', () => {
  it('считает точку заданной, если координаты не нулевые', () => {
    expect(hasRouteCoords({ lat: 55.76, lng: 37.61 })).toBe(true)
    expect(hasRouteCoords({ lat: 0, lng: 37.61 })).toBe(true)
  })

  it('нулевые координаты считает отсутствующими', () => {
    expect(hasRouteCoords({ lat: 0, lng: 0 })).toBe(false)
    expect(hasRouteCoords({ lat: Number.NaN, lng: 37.61 })).toBe(false)
  })
})

describe('buildRouteUri', () => {
  it('задаёт точку полным текстовым адресом, а не координатами', () => {
    const address = 'г. Москва, ул. Тверская, д. 1'
    // Координаты из подсказок могут быть приблизительными (центр населённого пункта),
    // поэтому навигатору отдаём адрес целиком — он найдёт дом по своей базе.
    expect(buildRouteUri({ lat: 55.76, lng: 37.61, address })).toBe(
      `geo:0,0?q=${encodeURIComponent(address)}`,
    )
  })

  it('строит маршрут по адресу, когда координат нет', () => {
    const address = 'г. Казань, ул. Баумана, д. 20'
    expect(buildRouteUri({ lat: 0, lng: 0, address })).toBe(
      `geo:0,0?q=${encodeURIComponent(address)}`,
    )
  })

  it('без адреса задаёт точку координатами и подписывает её именем клиента', () => {
    expect(buildRouteUri({ lat: 55.76, lng: 37.61, label: 'Home' })).toBe(
      'geo:0,0?q=55.76,37.61(Home)',
    )
  })

  it('оставляет точку без подписи, если ни адреса, ни имени нет', () => {
    expect(buildRouteUri({ lat: 55.76, lng: 37.61 })).toBe('geo:0,0?q=55.76,37.61')
  })

  it('игнорирует пустой адрес и берёт координаты', () => {
    expect(buildRouteUri({ lat: 55.76, lng: 37.61, address: '   ' })).toBe(
      'geo:0,0?q=55.76,37.61',
    )
  })
})

describe('buildAddressSearchUri', () => {
  it('передаёт полный адрес и подсказку по координатам', () => {
    const address = 'Московская обл, Одинцовский г.о., д. Ракитня, ул. Дачная, д. 7'
    expect(buildAddressSearchUri({ lat: 55.6, lng: 36.9, address })).toBe(
      `https://yandex.ru/maps/?text=${encodeURIComponent(address)}&ll=36.9,55.6`,
    )
  })

  it('без координат оставляет только адрес', () => {
    const address = 'г. Казань, ул. Баумана, д. 20'
    expect(buildAddressSearchUri({ lat: 0, lng: 0, address })).toBe(
      `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`,
    )
  })
})

describe('buildWebRouteUri', () => {
  it('строит маршрут по координатам', () => {
    expect(buildWebRouteUri({ lat: 55.76, lng: 37.61 })).toBe(
      'https://yandex.ru/maps/?rtext=~55.76,37.61&rtt=auto',
    )
  })
})

describe('routeBridgeUrl', () => {
  it('кладёт в параметры полный адрес, координаты подсказкой и имя клиента', () => {
    stubWindow()
    const address = 'Московская обл, Одинцовский г.о., д. Ракитня, ул. Дачная, д. 7'

    const url = new URL(String(routeBridgeUrl({ lat: 55.6, lng: 36.9, address, label: 'Иванов' })))

    expect(`${url.origin}${url.pathname}`).toBe('https://doc9830.github.io/selfcrm-tg/route.html')
    expect(url.searchParams.get('address')).toBe(address)
    expect(url.searchParams.get('lat')).toBe('55.6')
    expect(url.searchParams.get('lng')).toBe('36.9')
    expect(url.searchParams.get('label')).toBe('Иванов')
  })

  it('без адреса передаёт только координаты', () => {
    stubWindow()

    const url = new URL(String(routeBridgeUrl({ lat: 55.76, lng: 37.61 })))

    expect(url.searchParams.get('address')).toBeNull()
    expect(url.searchParams.get('lat')).toBe('55.76')
    expect(url.searchParams.get('label')).toBeNull()
  })

  it('без адреса и координат страницу-мост не собирает', () => {
    stubWindow()

    expect(routeBridgeUrl({ lat: 0, lng: 0, address: '   ' })).toBeNull()
  })

  it('без окна (проверки, серверный рендер) ссылку собрать нечем', () => {
    vi.stubGlobal('window', undefined)

    expect(routeBridgeUrl({ lat: 55.76, lng: 37.61 })).toBeNull()
  })
})

describe('openRoute', () => {
  it('в Android-сборке отдаёт системе geo:-ссылку с полным адресом', () => {
    capacitor.native = true
    const calls = stubWindow({ native: true })
    const address = 'г. Москва, ул. Тверская, д. 1'

    openRoute({ lat: 55.76, lng: 37.61, address })

    expect(calls).toEqual([{ url: `geo:0,0?q=${encodeURIComponent(address)}`, target: '_system' }])
  })

  it('в Android-сборке без координат тоже передаёт адрес', () => {
    capacitor.native = true
    const calls = stubWindow({ native: true })
    const address = 'г. Казань, ул. Баумана, д. 20'

    openRoute({ lat: 0, lng: 0, address })

    expect(calls).toEqual([{ url: `geo:0,0?q=${encodeURIComponent(address)}`, target: '_system' }])
  })

  it('в Android-сборке без адреса берёт координаты с именем клиента', () => {
    capacitor.native = true
    const calls = stubWindow({ native: true })

    openRoute({ lat: 55.76, lng: 37.61, label: 'Home' })

    expect(calls).toEqual([{ url: 'geo:0,0?q=55.76,37.61(Home)', target: '_system' }])
  })

  it('в Telegram Mini App отдаёт клиенту страницу-мост: её браузер показывает выбор навигатора', () => {
    const openLink = vi.fn()
    const calls = stubWindow({ webApp: { initData: 'query_id=1', platform: 'android', openLink } })
    const address = 'Московская обл, Одинцовский г.о., д. Ракитня, ул. Дачная, д. 7'

    openRoute({ lat: 55.6, lng: 36.9, address })

    // Сам клиент geo:-ссылки не принимает (openLink разрешает только http/https), поэтому
    // в его браузер уходит страница-мост: там geo: передаётся системе, как в Android-сборке.
    expect(openLink).toHaveBeenCalledTimes(1)
    const url = new URL(String(openLink.mock.calls[0][0]))
    expect(`${url.origin}${url.pathname}`).toBe('https://doc9830.github.io/selfcrm-tg/route.html')
    expect(url.searchParams.get('address')).toBe(address)
    expect(url.searchParams.get('lat')).toBe('55.6')
    expect(url.searchParams.get('lng')).toBe('36.9')
    // window.open в WebView мини-приложения игнорируется — использовать его нельзя.
    expect(calls).toEqual([])
  })

  it('в Telegram Mini App без адреса тоже отдаёт мост — с координатами и именем клиента', () => {
    const openLink = vi.fn()
    stubWindow({ webApp: { initData: 'query_id=1', platform: 'android', openLink } })

    openRoute({ lat: 55.76, lng: 37.61, label: 'Иванов' })

    const url = new URL(String(openLink.mock.calls[0][0]))
    expect(url.searchParams.get('address')).toBeNull()
    expect(url.searchParams.get('lat')).toBe('55.76')
    expect(url.searchParams.get('lng')).toBe('37.61')
    expect(url.searchParams.get('label')).toBe('Иванов')
  })

  it('в Telegram Mini App без адреса страницы приложения остаётся маршрут по координатам', () => {
    const openLink = vi.fn()
    // Адрес приложения клиенту не сообщается (например, страница открыта из локального файла):
    // страницу-мост собрать нечем, поэтому отдаём обычную ссылку на карты.
    stubWindow({
      webApp: { initData: 'query_id=1', platform: 'android', openLink },
      location: { href: 'about:blank' },
    })

    openRoute({ lat: 55.76, lng: 37.61 })

    expect(openLink).toHaveBeenCalledWith('https://yandex.ru/maps/?rtext=~55.76,37.61&rtt=auto')
  })

  it('в браузере открывает адрес в новой вкладке', () => {
    const calls = stubWindow()
    const address = 'г. Казань, ул. Баумана, д. 20'

    openRoute({ lat: 0, lng: 0, address })

    expect(calls).toEqual([
      {
        url: `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`,
        target: '_blank',
      },
    ])
  })

  it('без координат и адреса ничего не открывает', () => {
    const calls = stubWindow()

    openRoute({ lat: 0, lng: 0 })

    expect(calls).toEqual([])
  })
})

describe('buildTelUri', () => {
  it('убирает пробелы, скобки и дефисы, сохраняя ведущий плюс', () => {
    expect(buildTelUri('+7 (900) 000-00-00')).toBe('tel:+79000000000')
  })

  it('сохраняет локальный номер без плюса', () => {
    expect(buildTelUri('8 900 000-00-00')).toBe('tel:89000000000')
  })

  it('для пустой строки возвращает только схему', () => {
    expect(buildTelUri('')).toBe('tel:')
  })
})

describe('мессенджеры', () => {
  it('приводит российский номер к международному виду', () => {
    expect(phoneDigits('8 900 111-22-33')).toBe('79001112233')
    expect(phoneDigits('+7 (900) 111-22-33')).toBe('79001112233')
    expect(phoneDigits('900 111-22-33')).toBe('79001112233')
    expect(phoneDigits('')).toBe('')
  })

  it('строит веб-ссылку Telegram', () => {
    expect(buildTelegramUri('+7 900 111-22-33')).toBe('https://t.me/+79001112233')
  })

  it('строит ссылку приложения Telegram', () => {
    expect(buildTelegramAppUri('8 900 111-22-33')).toBe('tg://resolve?phone=79001112233')
  })

  it('строит веб-ссылку WhatsApp', () => {
    expect(buildWhatsAppUri('8 900 111-22-33')).toBe('https://wa.me/79001112233')
  })

  it('строит ссылку приложения WhatsApp', () => {
    expect(buildWhatsAppAppUri('+7 900 111-22-33')).toBe('whatsapp://send?phone=79001112233')
  })

  it('без номера ничего не открывает', () => {
    expect(() => openTelegram('')).not.toThrow()
    expect(() => openWhatsApp('   ')).not.toThrow()
  })
})
