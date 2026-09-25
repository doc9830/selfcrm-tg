import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client, Contractor, Order } from '../types'
import {
  packReceipt,
  RECEIPT_DOWNLOAD_PARAM,
  receiptData,
  receiptDownloadUrl,
  receiptFileName,
  receiptHeading,
  receiptLinkTooLong,
  receiptMessage,
  receiptPayloadFromQuery,
  receiptPath,
  receiptTotal,
  receiptUrl,
  receiptWantsDownload,
  telegramShareUrl,
  unpackReceipt,
  type ReceiptData,
} from './receipt'

const contractor: Contractor = {
  name: 'ИП Иванов И. И.',
  inn: '770123456789',
  ogrn: '320123456789012',
  kpp: '',
  phone: '+7 900 111-22-33',
  email: 'ivanov@example.com',
  address: 'Москва, ул. Тестовая, 1',
}

function makeClient(partial: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Пётр Сидоров',
    phone: '+7 900 555-44-33',
    email: '',
    comment: '',
    address: 'Москва, Ленина, 5',
    createdAt: new Date(2026, 8, 1).toISOString(),
    ...partial,
  }
}

function makeOrder(partial: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    number: 42,
    clientId: 'c1',
    date: new Date(2026, 8, 19, 12).toISOString(),
    status: 'done',
    items: [{ productId: null, name: 'Шкаф', price: 1000, qty: 2 }],
    payments: [],
    comment: '',
    ...partial,
  }
}

function makeData(partial: Partial<ReceiptData> = {}): ReceiptData {
  return {
    number: '42',
    title: 'Заказ №42',
    date: '19.09.2026',
    contractor,
    clientName: 'Пётр Сидоров',
    clientPhone: '+7 900 555-44-33',
    clientAddress: 'Москва, Ленина, 5',
    items: [{ name: 'Шкаф', qty: 2, price: 1000 }],
    paid: 0,
    remaining: 0,
    ...partial,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('данные чека', () => {
  it('берёт номер заказа и его подписи', () => {
    const data = receiptData({ order: makeOrder(), client: makeClient(), contractor })

    expect(data.number).toBe('42')
    expect(data.title).toBe('Заказ №42')
    expect(data.date).toBe('19.09.2026')
    expect(receiptHeading(data)).toBe('Заказ №42 от 19.09.2026')
    expect(receiptFileName(data)).toBe('check-42.pdf')
  })

  it('старому заказу без номера даёт подпись по идентификатору', () => {
    const data = receiptData({
      order: makeOrder({ number: undefined, id: 'abcdef1234567890' }),
      contractor,
    })

    expect(data.number).toBe('ABCDEF12')
    expect(receiptFileName(data)).toBe('check-ABCDEF12.pdf')
  })

  it('переносит позиции, заказчика и оплату', () => {
    const order = makeOrder({
      items: [
        { productId: null, name: 'Шкаф', price: 1000, qty: 2 },
        { productId: 'p2', name: 'Услуга сборки', price: 500, qty: 1 },
      ],
      payments: [{ id: 'pay1', amount: 1000, date: new Date(2026, 8, 19).toISOString(), comment: '' }],
    })
    const data = receiptData({ order, client: makeClient(), contractor })

    expect(data.items).toEqual([
      { name: 'Шкаф', qty: 2, price: 1000 },
      { name: 'Услуга сборки', qty: 1, price: 500 },
    ])
    expect(data.clientName).toBe('Пётр Сидоров')
    expect(data.paid).toBe(1000)
    expect(data.remaining).toBe(1500)
    expect(receiptTotal(data)).toBe(2500)
  })

  it('без клиента и без позиций собирается без ошибок', () => {
    const data = receiptData({ order: makeOrder({ items: [] }), contractor })

    expect(data.clientName).toBe('')
    expect(data.items).toEqual([])
    expect(receiptTotal(data)).toBe(0)
  })

  it('подпись к чеку содержит номер, дату и сумму', () => {
    const message = receiptMessage(makeData())

    expect(message).toContain('Чек по заказу №42 от 19.09.2026')
    expect(message).toContain('₽')
  })
})

// Нагрузка без сжатия: так её собирает и приложение в старом WebView, а в тестах —
// удобный способ проверить разбор «чужих» данных (Buffer есть только в Node).
function plainPayload(value: unknown): string {
  return `0.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`
}

describe('данные чека в адресе', () => {
  it('переживают упаковку и разбор целиком', async () => {
    const data = makeData({
      items: [
        { name: 'Шкаф «Комфорт»', qty: 2, price: 12990.5 },
        { name: 'Услуга сборки', qty: 1, price: 1500 },
      ],
      paid: 5000,
      remaining: 17481,
    })

    const payload = await packReceipt(data)
    expect(payload.startsWith('1.')).toBe(true)
    expect(await unpackReceipt(payload)).toEqual(data)
  })

  it('без сжатия в клиенте упаковывают данные обычным JSON', async () => {
    // Старые WebView не умеют CompressionStream: ссылка длиннее, но рабочая.
    vi.stubGlobal('CompressionStream', undefined)
    vi.stubGlobal('DecompressionStream', undefined)

    const data = makeData()
    const payload = await packReceipt(data)
    expect(payload.startsWith('0.')).toBe(true)
    expect(await unpackReceipt(payload)).toEqual(data)
  })

  it('отказ самого сжатия тоже приводит к обычному JSON', async () => {
    // WebView может объявить CompressionStream и не поддержать «deflate-raw»: тогда
    // ошибка сжатия не должна ломать отправку чека.
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new Error('deflate-raw не поддерживается')
        }
      },
    )

    const data = makeData()
    const payload = await packReceipt(data)
    expect(payload.startsWith('0.')).toBe(true)
    expect(await unpackReceipt(payload)).toEqual(data)
  })

  it('нечитаемую нагрузку не разбирают, а отклоняют', async () => {
    expect(await unpackReceipt('')).toBeNull()
    expect(await unpackReceipt('мусор')).toBeNull()
    expect(await unpackReceipt('2.abcdef')).toBeNull()
    expect(await unpackReceipt('1.')).toBeNull()
    // Данные без сжатия с признаком сжатия: распаковка обязана провалиться молча.
    expect(await unpackReceipt(plainPayload(makeData()).replace('0.', '1.'))).toBeNull()
  })

  it('проверяют каждое поле чужой ссылки', async () => {
    expect(await unpackReceipt(plainPayload('строка'))).toBeNull()
    expect(await unpackReceipt(plainPayload({ n: '42' }))).toBeNull()
    expect(
      await unpackReceipt(plainPayload({ n: '42', t: 'Заказ №42', d: '19.09.2026', c: 'нет' })),
    ).toBeNull()
    // Количество строкой: данные ссылки приходят извне, поэтому такие позиции отсекаются.
    expect(
      await unpackReceipt(
        plainPayload({
          n: '42',
          t: 'Заказ №42',
          d: '19.09.2026',
          c: ['', '', '', '', '', '', ''],
          i: [['Шкаф', 'два', 1000]],
        }),
      ),
    ).toBeNull()
    // Позиций нет — это допустимый, хотя и пустой чек.
    const empty = await unpackReceipt(
      plainPayload({ n: '42', t: 'Заказ №42', d: '19.09.2026', c: [], i: [] }),
    )
    expect(empty).toEqual({
      number: '42',
      title: 'Заказ №42',
      date: '19.09.2026',
      contractor: { name: '', inn: '', ogrn: '', kpp: '', phone: '', email: '', address: '' },
      clientName: '',
      clientPhone: '',
      clientAddress: '',
      items: [],
      paid: 0,
      remaining: 0,
    })
  })

  it('признак «сжато» без поддержки распаковки даёт «ссылка не читается»', async () => {
    const payload = await packReceipt(makeData())
    vi.stubGlobal('DecompressionStream', undefined)

    expect(await unpackReceipt(payload)).toBeNull()
  })
})

describe('ссылка на чек', () => {
  it('путь и полный адрес собираются из данных', () => {
    expect(receiptPath('1.abc')).toBe('/receipt?d=1.abc')
    expect(receiptUrl('1.abc', { origin: 'https://doc9830.github.io', pathname: '/selfcrm-tg/' })).toBe(
      'https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.abc',
    )
  })

  it('вне http адрес остаётся относительным', () => {
    // Capacitor отдаёт приложение с file://, и origin там не адрес сайта.
    expect(receiptUrl('1.abc', { origin: 'file://', pathname: '/index.html' })).toBe(
      '#/receipt?d=1.abc',
    )
  })

  it('ссылка на скачивание добавляет признак к готовому адресу чека', () => {
    expect(receiptDownloadUrl('https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.abc')).toBe(
      'https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.abc&dl=1',
    )
  })

  it('относительный адрес и адрес без параметров тоже получают признак', () => {
    expect(receiptDownloadUrl('#/receipt?d=1.abc')).toBe('#/receipt?d=1.abc&dl=1')
    expect(receiptDownloadUrl('https://example.com/receipt')).toBe(
      'https://example.com/receipt?dl=1',
    )
  })

  it('признак скачивания не мешает прочитать данные чека', () => {
    const url = receiptDownloadUrl(
      receiptUrl('1.abc', { origin: 'https://doc9830.github.io', pathname: '/selfcrm-tg/' }),
    )
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))

    expect(query.get('d')).toBe('1.abc')
    expect(query.get(RECEIPT_DOWNLOAD_PARAM)).toBe('1')
  })

  it('скачивать файл сразу — только по признаку «1»', () => {
    expect(receiptWantsDownload('1')).toBe(true)
    expect(receiptWantsDownload('true')).toBe(false)
    expect(receiptWantsDownload('0')).toBe(false)
    expect(receiptWantsDownload(null)).toBe(false)
  })

  it('ссылка «поделиться» в Telegram экранирует адрес и подпись', () => {
    const url = 'https://doc9830.github.io/selfcrm-tg/#/receipt?d=1.a-b_c'
    expect(telegramShareUrl(url, 'Чек №42 — 3 000,00 ₽')).toBe(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('Чек №42 — 3 000,00 ₽')}`,
    )
  })

  it('слишком длинная ссылка определяется до отправки', () => {
    expect(receiptLinkTooLong('https://a/'.repeat(100), 'Чек по заказу №42')).toBe(false)
    // 3400 символов адреса и подпись ещё укладываются в предел, а 3500 — уже нет.
    expect(receiptLinkTooLong('a'.repeat(3400), 'Чек по заказу №42')).toBe(false)
    expect(receiptLinkTooLong('a'.repeat(3500), 'Чек по заказу №42')).toBe(true)
  })

  it('чек на десять позиций укладывается в предел ссылки', async () => {
    const data = makeData({
      items: Array.from({ length: 10 }, (_, i) => ({
        name: `Позиция ${i + 1}: дверь межкомнатная «Комфорт» с фурнитурой`,
        qty: 2,
        price: 12990.5,
      })),
      paid: 5000,
      remaining: 254810,
    })
    const url = receiptUrl(await packReceipt(data), {
      origin: 'https://doc9830.github.io',
      pathname: '/selfcrm-tg/',
    })

    // Сжатие укорачивает адрес примерно втрое: при десяти позициях ссылка остаётся
    // короткой, и она помещается в сообщение Telegram целиком.
    expect(url.length).toBeLessThan(1500)
    expect(receiptLinkTooLong(url, receiptMessage(data))).toBe(false)
  })

  it('параметр d принимается только в своём формате', () => {
    expect(receiptPayloadFromQuery('1.abc_-DEF')).toBe('1.abc_-DEF')
    expect(receiptPayloadFromQuery('0.aGk')).toBe('0.aGk')
    expect(receiptPayloadFromQuery(' 1.aGk ')).toBe('1.aGk')
    expect(receiptPayloadFromQuery(null)).toBeNull()
    expect(receiptPayloadFromQuery('')).toBeNull()
    expect(receiptPayloadFromQuery('aGk')).toBeNull()
    expect(receiptPayloadFromQuery('1.a+b/c=')).toBeNull()
    expect(receiptPayloadFromQuery('1.')).toBeNull()
  })
})
