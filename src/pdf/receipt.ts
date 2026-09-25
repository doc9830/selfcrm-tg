// Чек по заказу: данные, из которых собираются и PDF-файл, и страница по ссылке.
//
// Чек отдаётся двумя путями. Файлом — там, где клиент умеет его сохранять (браузер,
// Android-сборка). Ссылкой — там, где файл не отдать: Telegram Mini App игнорирует
// blob-ссылки и `<a download>`, а `WebApp.downloadFile` принимает только адреса
// `https:`. Данные чека при этом лежат в самом адресе (`#/receipt?d=…`), а страница
// `screens/ReceiptView.tsx` строит по ним тот же документ. Серверной части у SelfCRM
// нет, поэтому ссылку никто не обслуживает: её получатель открывает адрес и видит чек.
//
// Модуль почти чистый: он не ходит в сеть и не трогает DOM (кроме `window.location`
// в `receiptUrl`), поэтому упаковку и разбор проверяют тесты.
import type { Client, Contractor, Order } from '../types'
import { formatDate, money } from '../utils/format'
import { orderTitle } from '../utils/orders'
import { orderPaymentState } from '../utils/payments'

// Позиция чека: снимок названия, цены и количества на момент оформления заказа.
export interface ReceiptItem {
  name: string
  qty: number
  price: number
}

// Всё, что печатается в чеке. Данные отделены от документа: один и тот же набор
// используется и для PDF, и для страницы по ссылке, и в тексте сообщения.
export interface ReceiptData {
  // «42» — идёт в имя файла и в подписи. У старых заказов без номера — начало id.
  number: string
  // «Заказ №42» — заголовок страницы и шапки чека.
  title: string
  // «19.09.2026» — дата заказа готовой строкой: подпись не зависит от локали клиента.
  date: string
  contractor: Contractor
  clientName: string
  clientPhone: string
  clientAddress: string
  items: ReceiptItem[]
  // Уже внесённые платежи и остаток к оплате. Ноль в `paid` — строк об оплате нет.
  paid: number
  remaining: number
}

export interface ReceiptInput {
  order: Order
  client?: Client
  contractor: Contractor
}

// Собирает данные чека по заказу. Пустые реквизиты и контакты остаются пустыми
// строками: их пропускает уже сборка документа, а не подготовка данных.
export function receiptData(input: ReceiptInput): ReceiptData {
  const { order, client, contractor } = input
  const payment = orderPaymentState(order)
  return {
    number: order.number ? String(order.number) : order.id.slice(0, 8).toUpperCase(),
    title: orderTitle(order),
    date: formatDate(order.date),
    contractor: { ...contractor },
    clientName: (client?.name ?? '').trim(),
    clientPhone: (client?.phone ?? '').trim(),
    clientAddress: (client?.address ?? '').trim(),
    items: order.items.map((item) => ({ name: item.name, qty: item.qty, price: item.price })),
    paid: payment.paid,
    remaining: payment.remaining,
  }
}

// «Заказ №42 от 19.09.2026» — шапка чека и заголовок сообщения.
export function receiptHeading(data: ReceiptData): string {
  return `${data.title} от ${data.date}`
}

// Сумма чека. Считается по позициям, а не берётся из заказа: данные ссылки могли
// прийти от другого пользователя, и документ должен сходиться сам с собой.
export function receiptTotal(data: ReceiptData): number {
  return data.items.reduce((sum, item) => sum + item.price * item.qty, 0)
}

// Имя файла: «check-42.pdf».
export function receiptFileName(data: ReceiptData): string {
  return `check-${data.number}.pdf`
}

// Подпись к чеку — она уходит в текст сообщения вместе со ссылкой.
export function receiptMessage(data: ReceiptData): string {
  return `Чек по заказу №${data.number} от ${data.date} — ${money(receiptTotal(data))}`
}

// ----- Данные в адресе -----
//
// Адрес страницы чека: `#/receipt?d=<полезная нагрузка>`. Параметр читает
// screens/ReceiptView.tsx, а разбирает `receiptPayloadFromQuery`.

export const RECEIPT_PATH = '/receipt'

// Формат нагрузки: «<признак>.<данные>». Признак «1» — JSON, сжатый deflate-raw,
// «0» — обычный JSON: сжатие есть не во всех клиентах, и без него ссылка просто
// длиннее, но остаётся рабочей.
const PACK_PLAIN = '0'
const PACK_DEFLATED = '1'

// Поля названы коротко, а позиции пишутся массивами: адрес уходит в чат, и каждый
// лишний байт в нём — лишний символ в сообщении.
interface PackedReceipt {
  n: string
  t: string
  d: string
  // Реквизиты исполнителя: название, ИНН, ОГРН, КПП, телефон, почта, адрес.
  c: string[]
  cn: string
  cp: string
  ca: string
  // Позиции: [название, количество, цена].
  i: Array<[string, number, number]>
  p: number
  r: number
}

function packReceiptData(data: ReceiptData): PackedReceipt {
  const c = data.contractor
  return {
    n: data.number,
    t: data.title,
    d: data.date,
    c: [c.name, c.inn, c.ogrn, c.kpp, c.phone, c.email, c.address],
    cn: data.clientName,
    cp: data.clientPhone,
    ca: data.clientAddress,
    i: data.items.map((item) => [item.name, item.qty, item.price] as [string, number, number]),
    p: data.paid,
    r: data.remaining,
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return isNumber(value) ? value : 0
}

// Разбор пришедших данных. Ссылку может открыть кто угодно и с любым содержимым,
// поэтому проверяется каждое поле: непонятная нагрузка — это null, а не исключение
// и не полусобранный чек.
function unpackReceiptData(value: unknown): ReceiptData | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PackedReceipt>
  if (!isText(raw.n) || !isText(raw.t) || !isText(raw.d)) return null
  if (!Array.isArray(raw.c) || !raw.c.every(isText)) return null
  if (!Array.isArray(raw.i)) return null

  const items: ReceiptItem[] = []
  for (const entry of raw.i) {
    if (!Array.isArray(entry) || entry.length < 3) return null
    const [name, qty, price] = entry as unknown[]
    if (!isText(name) || !isNumber(qty) || !isNumber(price)) return null
    items.push({ name, qty, price })
  }

  const c = raw.c as string[]
  return {
    number: raw.n,
    title: raw.t,
    date: raw.d,
    contractor: {
      name: text(c[0]),
      inn: text(c[1]),
      ogrn: text(c[2]),
      kpp: text(c[3]),
      phone: text(c[4]),
      email: text(c[5]),
      address: text(c[6]),
    },
    clientName: text(raw.cn),
    clientPhone: text(raw.cp),
    clientAddress: text(raw.ca),
    items,
    paid: number(raw.p),
    remaining: number(raw.r),
  }
}

// Base64url: в адресе нельзя «+», «/» и «=» — они ломают разбор параметра.
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64Url(bytes: Uint8Array): string {
  let base64 = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    base64 += BASE64_ALPHABET[b0 >> 2]
    base64 += BASE64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    base64 += BASE64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    base64 += BASE64_ALPHABET[b2 & 63]
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_')
}

function base64UrlToBytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of base64) {
    const index = BASE64_ALPHABET.indexOf(char)
    if (index < 0) continue
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  // Возвращаем именно ArrayBuffer: его принимает и Blob (для распаковки), и TextDecoder.
  const result = new ArrayBuffer(bytes.length)
  new Uint8Array(result).set(bytes)
  return result
}

// Сжатие есть не во всех клиентах (например, в старых WebView): тогда данные
// уходят без него — ссылка просто длиннее, но открывается как обычно.
function canCompress(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}

async function deflate(value: string): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

// Упаковывает данные чека в строку для адреса. Сжатие есть не во всех клиентах, и само
// сжатие может отказать (например, WebView без `deflate-raw`) — тогда данные уходят без
// него: ссылка длиннее, но рабочая. Признак формата стоит в начале строки, поэтому
// получатель разберёт её в любом случае.
export async function packReceipt(data: ReceiptData): Promise<string> {
  const json = JSON.stringify(packReceiptData(data))
  const plain = (): string => `${PACK_PLAIN}.${bytesToBase64Url(new TextEncoder().encode(json))}`
  if (!canCompress()) return plain()
  try {
    return `${PACK_DEFLATED}.${bytesToBase64Url(await deflate(json))}`
  } catch {
    return plain()
  }
}

// Возвращает данные чека или null, если нагрузка повреждена или чужого формата.
export async function unpackReceipt(payload: string): Promise<ReceiptData | null> {
  const dot = payload.indexOf('.')
  if (dot < 0) return null
  const kind = payload.slice(0, dot)
  const body = payload.slice(dot + 1)
  if (!body) return null

  try {
    let json: string
    if (kind === PACK_DEFLATED) {
      if (typeof DecompressionStream !== 'function') return null
      json = await inflate(base64UrlToBytes(body))
    } else if (kind === PACK_PLAIN) {
      json = new TextDecoder().decode(base64UrlToBytes(body))
    } else {
      return null
    }
    return unpackReceiptData(JSON.parse(json))
  } catch {
    // Повреждённая нагрузка — обычное дело для ссылки из чужих рук: это не ошибка
    // приложения, а повод показать «ссылка не читается».
    return null
  }
}

// Путь страницы чека с данными: `/receipt?d=…` (для адреса после «#»).
export function receiptPath(payload: string): string {
  return `${RECEIPT_PATH}?d=${payload}`
}

// Полный адрес чека для отправки в чат. Данные стоят после «#», поэтому запрос на
// сервер не уходит: страница собирает чек сама. Адрес берётся у текущей страницы —
// так ссылка работает и на GitHub Pages (`/selfcrm-tg/`), и в локальной разработке.
export function receiptUrl(
  payload: string,
  here: { origin: string; pathname: string } | null = typeof window === 'undefined'
    ? null
    : window.location,
): string {
  const base = here && /^https?:\/\//.test(here.origin) ? `${here.origin}${here.pathname}` : ''
  return `${base}#${receiptPath(payload)}`
}

// Признак в адресе страницы чека: «страницу открыли ради файла» (`#/receipt?d=…&dl=1`).
// Внутри Telegram страница файл отдать не может, поэтому кнопка «Скачать PDF» открывает
// эту же страницу в браузере — а там по этому признаку PDF скачивается сразу.
export const RECEIPT_DOWNLOAD_PARAM = 'dl'

// Тот же адрес чека, но с просьбой скачать файл. Приписывается к готовой ссылке: в ней
// уже есть параметр `d`, поэтому разделителем служит `&`.
export function receiptDownloadUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${RECEIPT_DOWNLOAD_PARAM}=1`
}

// Скачивать ли файл сразу при открытии страницы — по параметру `dl`.
export function receiptWantsDownload(value: string | null): boolean {
  return value === '1'
}

// Ссылка «поделиться» Telegram: клиент сам открывает выбор чата и подставляет в
// сообщение адрес страницы чека с подписью. Нужна там, где файл отдать нельзя, —
// на iPhone в мини-приложении вместо PDF уходит ссылка, по которой получатель
// открывает чек и сохраняет его как PDF.
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
}

// Сколько символов допускает ссылка. Ограничение не сервера, а сообщения: Telegram
// принимает 4096 символов, и в них ещё укладывается подпись. Запас оставлен, чтобы
// слишком длинный чек показывался понятной ошибкой, а не обрезанной ссылкой.
export const RECEIPT_LINK_LIMIT = 3500

export function receiptLinkTooLong(url: string, text: string): boolean {
  return url.length + text.length > RECEIPT_LINK_LIMIT
}

// Нагрузка из параметра `d`. Пустая строка и мусор — null: экран покажет, что ссылка
// не читается, вместо пустого документа.
export function receiptPayloadFromQuery(value: string | null): string | null {
  const payload = (value ?? '').trim()
  return /^[01]\.[A-Za-z0-9_-]+$/.test(payload) ? payload : null
}
