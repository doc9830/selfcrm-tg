// Проверка описания PDF-чека: описание собирается из данных чека, а не из заказа,
// поэтому оно одинаково для файла и для страницы по ссылке. Здесь проверяется
// состав документа, а не картинка: рендер pdfmake в тестах не нужен.
import { describe, expect, it, vi } from 'vitest'

// Окружение Telegram подменяется, потому что от него зависит сохранение файла на
// странице чека: в мини-приложении клиент файлы не принимает, и об этом нужно знать
// заранее, а не показывать пустое скачивание.
const env = vi.hoisted(() => ({ telegram: false, webview: false }))
vi.mock('../telegram/webapp', () => ({
  isTelegramEnvironment: () => env.telegram,
  insideTelegramWebView: () => env.telegram || env.webview,
}))

import { emptyContractor, type Client, type Order } from '../types'
import { receiptDocDefinition, saveReceiptPdf } from './documents'
import { receiptData } from './receipt'

// Возвращает окружение к обычному браузеру: тесты не должны зависеть от порядка запуска.
function browserEnv(): void {
  env.telegram = false
  env.webview = false
}

const contractor = { ...emptyContractor(), name: 'ИП Иванов И. И.', inn: '770123456789' }

const client: Client = {
  id: 'c1',
  name: 'Пётр Сидоров',
  phone: '+7 900 555-44-33',
  email: '',
  comment: '',
  address: 'Москва, Ленина, 5',
  createdAt: new Date(2026, 8, 1).toISOString(),
}

function makeOrder(partial: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    number: 42,
    clientId: 'c1',
    date: new Date(2026, 8, 19, 12).toISOString(),
    status: 'done',
    items: [
      { productId: null, name: 'Шкаф', price: 1000, qty: 2 },
      { productId: 'p2', name: 'Услуга сборки', price: 500, qty: 1 },
    ],
    payments: [],
    comment: '',
    ...partial,
  }
}

// Все строки документа: текст абзацев и подписи строк таблицы. Так проверяется состав
// чека независимо от вёрстки.
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const record = node as Record<string, unknown>
  return Object.entries(record).flatMap(([key, value]) =>
    // Чертежи линий и настройки отступов — не текст чека.
    key === 'canvas' || key === 'layout' ? [] : texts(value),
  )
}

function docTexts(order: Order): string[] {
  return texts(receiptDocDefinition(receiptData({ order, client, contractor })))
}

describe('описание PDF-чека', () => {
  it('печатает реквизиты, шапку, заказчика и позиции', () => {
    const found = docTexts(makeOrder())

    expect(found).toContain('ИП Иванов И. И.')
    expect(found).toContain('ИНН 770123456789')
    expect(found).toContain('Заказ №42 от 19.09.2026')
    expect(found).toContain('ЧЕК')
    expect(found).toContain('Заказчик: Пётр Сидоров')
    expect(found).toContain('Телефон: +7 900 555-44-33')
    expect(found).toContain('Шкаф')
    expect(found).toContain('Услуга сборки')
    expect(found).toContain('Спасибо за покупку!')
    expect(found.some((line) => line.startsWith('Итого:'))).toBe(true)
  })

  it('добавляет строки оплаты только по внесённым платежам', () => {
    const unpaid = docTexts(makeOrder())
    expect(unpaid.some((line) => line.startsWith('Оплачено:'))).toBe(false)

    const partially = docTexts(
      makeOrder({
        payments: [
          { id: 'p1', amount: 500, date: new Date(2026, 8, 19).toISOString(), comment: '' },
        ],
      }),
    )
    expect(partially.some((line) => line.startsWith('Оплачено:'))).toBe(true)
    expect(partially.some((line) => line.startsWith('К оплате:'))).toBe(true)

    const paid = docTexts(
      makeOrder({
        payments: [
          { id: 'p1', amount: 2500, date: new Date(2026, 8, 19).toISOString(), comment: '' },
        ],
      }),
    )
    expect(paid.some((line) => line.startsWith('Оплачено:'))).toBe(true)
    expect(paid.some((line) => line.startsWith('К оплате:'))).toBe(false)
  })

  it('остаётся компактным чеком того же вида', () => {
    const def = receiptDocDefinition(receiptData({ order: makeOrder(), client, contractor })) as {
      pageSize: string
      defaultStyle: { font: string }
      styles: Record<string, unknown>
    }

    expect(def.pageSize).toBe('A6')
    expect(def.defaultStyle.font).toBe('Roboto')
    expect(Object.keys(def.styles)).toEqual([
      'company',
      'companyProps',
      'title',
      'subtitle',
      'meta',
      'total',
      'thanks',
    ])
  })
})

describe('сохранение чека файлом', () => {
  it('в мини-приложении Telegram сообщает, что файл отдать нечем', async () => {
    // Клиент Telegram игнорирует и blob-ссылки, и `<a download>`, поэтому страница чека
    // не делает вид, что скачала файл, а предлагает ссылку и браузер.
    env.telegram = true
    expect(await saveReceiptPdf(receiptData({ order: makeOrder(), client, contractor }))).toBe(
      'unsupported',
    )
    browserEnv()
  })

  it('во встроенном браузере Telegram файл тоже записать нечем', async () => {
    // Данных мини-приложения в нём нет, но это тот же WebView клиента: страница чека
    // открывает себя в браузере вместо пустого скачивания.
    env.webview = true
    expect(await saveReceiptPdf(receiptData({ order: makeOrder(), client, contractor }))).toBe(
      'unsupported',
    )
    browserEnv()
  })
})
