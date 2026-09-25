// Формат файла резервной копии (версионируемый конверт).
//
//   {
//     "format": "selfcrm-backup",   // признак формата
//     "version": 1,                 // версия ФОРМАТА файла (не версия схемы данных)
//     "createdAt": "2026-09-25T12:00:00.000Z",
//     "appVersion": "1.5.0",        // версия приложения, которым сделана копия
//     "app": { "name": "SelfCRM", "version": "1.5.0", "platform": "telegram",
//              "telegramUser": { "id": 123, "label": "Имя" } },
//     "data": { ...снимок базы... },
//     "clients": [...], "products": [...], "orders": [...],   // дубли ключей снимка
//     "stockMoves": [...], "settings": { ... }
//   }
//
// Ключи снимка продублированы в корне намеренно: так файл читается и старой
// версией SelfCRM (Android-сборка ожидает в корне clients/orders), а данные CRM
// всегда лежат в data. Именно на data смотрит новая версия, поэтому расширение
// конверта в будущем не сломает импорт (см. разбор версии ниже).
//
// В data попадает только то, что нужно для полного восстановления CRM: клиенты,
// товары, заказы (внутри — позиции, оплаты и напоминания), история склада,
// реквизиты исполнителя и загруженная пользователем база адресов. Ни `initData`
// Telegram, ни токен бота, ни служебные ключи хранилища сюда не попадают.
//
// Модуль чистый: не трогает DOM, файлы и сеть — его удобно тестировать.

import { Capacitor } from '@capacitor/core'
import { APP_VERSION } from '../version'
import { getTelegramUserId, getTelegramUserLabel, isTelegramEnvironment } from '../telegram/webapp'
import { uid } from '../utils/id'
import { readUserAddresses, type AddressEntry } from './addresses'
import type { Database } from './database'

export const BACKUP_FORMAT = 'selfcrm-backup'
export const BACKUP_FORMAT_VERSION = 1

// Форматы, которые SelfCRM писал раньше (версия 1.5.0) или пишет Android-сборка:
// такие файлы читаются как свои, чтобы уже сохранённые копии не пропали.
const LEGACY_FORMATS = new Set(['selfcrm'])
const SUPPORTED_FORMATS = new Set([BACKUP_FORMAT, ...LEGACY_FORMATS])

export type BackupPlatform = 'telegram' | 'android' | 'web'

// Автор копии: Telegram ID нужен только для подписи файла. Данные CRM никогда
// не индексируются по нему — у клиентов, заказов и товаров свои id.
export interface BackupAuthor {
  id: number
  label?: string
}

export interface BackupAppInfo {
  name: string
  version: string
  platform: BackupPlatform
  telegramUser?: BackupAuthor
}

export interface ParsedBackup {
  // Версия формата из файла (null — файл старого образца, без конверта).
  formatVersion: number | null
  // Когда копия сделана (null — в файле нет отметки времени).
  createdAt: string | null
  // Чем и кем сделана копия (null — файл старого образца).
  app: BackupAppInfo | null
  // Версия приложения из файла: отдельным полем (как в конверте) и внутри app.
  appVersion: string | null
  // Файл старого образца: снимок базы лежит в корне, а не в data.
  legacy: boolean
  // Загруженная пользователем база адресов, если она была в копии.
  addresses: AddressEntry[] | null
  // Снимок базы в виде JSON-строки — то, что принимает Database.importData().
  snapshotJson: string
}

// Что показать пользователю перед восстановлением: сколько данных в файле.
export interface BackupCounts {
  clients: number
  products: number
  orders: number
  reminders: number
  stockMoves: number
  addresses: number
}

export interface BackupSummary {
  // Человекочитаемое описание копии (см. describeBackup).
  label: string
  createdAt: string | null
  appVersion: string | null
  legacy: boolean
  counts: BackupCounts
}

export function currentPlatform(): BackupPlatform {
  if (isTelegramEnvironment()) return 'telegram'
  if (Capacitor.isNativePlatform()) return 'android'
  return 'web'
}

export function currentAppInfo(): BackupAppInfo {
  const id = getTelegramUserId()
  const label = getTelegramUserLabel()
  return {
    name: 'SelfCRM',
    version: APP_VERSION,
    platform: currentPlatform(),
    ...(id !== null ? { telegramUser: { id, ...(label ? { label } : {}) } } : {}),
  }
}

// Имя файла копии: SelfCRM_backup_2026-09-25_12-30.json
export function backupFileName(date: Date = new Date()): string {
  return `SelfCRM_backup_${fileStamp(date)}.json`
}

// Отметка времени для имени файла: 2026-09-25_12-30.
export function fileStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
}

// Собирает содержимое файла копии: конверт + снимок базы из Database.exportData().
export function buildBackupJson(db: Database, date: Date = new Date()): string {
  const snapshot = JSON.parse(db.exportData()) as Record<string, unknown>
  // База адресов, загруженная пользователем, — его данные: без неё копия была бы
  // неполной. Демонстрационный набор в файл не попадает (readUserAddresses
  // возвращает null, если свою базу не загружали).
  const addresses = readUserAddresses()
  const data = addresses ? { ...snapshot, addresses } : snapshot

  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: date.toISOString(),
      // Версия приложения отдельным полем: по ней видно, чем сделана копия,
      // даже если структура app когда-нибудь изменится.
      appVersion: APP_VERSION,
      app: currentAppInfo(),
      data,
      // Обратная совместимость: старые версии SelfCRM читают снимок из корня файла.
      clients: data.clients,
      products: data.products,
      orders: data.orders,
      stockMoves: data.stockMoves,
      settings: data.settings,
    },
    null,
    2,
  )
}

// Человекочитаемое описание копии для интерфейса, без технических подробностей:
// «Копия от 01.01.2026, 12:30 · сделана в Telegram (Иван)».
export function describeBackup(parsed: ParsedBackup): string {
  const parts: string[] = []
  const date = parsed.createdAt ? new Date(parsed.createdAt) : null
  if (date && !Number.isNaN(date.getTime())) {
    parts.push(
      `Копия от ${date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    )
  }
  const app = parsed.app
  if (app) {
    const author = app.telegramUser?.label
    parts.push(`сделана в ${PLATFORM_LABEL[app.platform]}${author ? ` (${author})` : ''}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'Резервная копия SelfCRM'
}

// Что показать на экране перед восстановлением: сколько данных в файле. Считаем по
// снимку — это ровно то, что попадёт в базу после подтверждения.
export function summarizeBackup(parsed: ParsedBackup): BackupSummary {
  const snapshot = JSON.parse(parsed.snapshotJson) as Record<string, unknown>
  const orders = asArray(snapshot.orders)

  return {
    label: describeBackup(parsed),
    createdAt: parsed.createdAt,
    appVersion: parsed.appVersion,
    legacy: parsed.legacy,
    counts: {
      clients: asArray(snapshot.clients).length,
      products: asArray(snapshot.products).length,
      orders: orders.length,
      // Напоминания живут внутри заказов — отдельной коллекции у них нет.
      reminders: orders.reduce((sum, order) => sum + asArray(order.reminders).length, 0),
      stockMoves: asArray(snapshot.stockMoves).length,
      addresses: parsed.addresses?.length ?? 0,
    },
  }
}

// Строка с составом копии для интерфейса: «Клиентов: 3 · Товаров: 2 · Заказов: 4».
// Пустые разделы истории и адресов не показываем, чтобы не засорять подпись.
export function describeCounts(counts: BackupCounts): string {
  const parts = [
    `Клиентов: ${counts.clients}`,
    `Товаров: ${counts.products}`,
    `Заказов: ${counts.orders}`,
    `Напоминаний: ${counts.reminders}`,
  ]
  if (counts.stockMoves > 0) parts.push(`Движений склада: ${counts.stockMoves}`)
  if (counts.addresses > 0) parts.push(`Адресов: ${counts.addresses}`)
  return parts.join(' · ')
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

const PLATFORM_LABEL: Record<BackupPlatform, string> = {
  telegram: 'Telegram',
  android: 'приложении SelfCRM для Android',
  web: 'браузере',
}

// Миграции формата файла: версия N → N+1. Пока формат один (v1), поэтому цепочка пустая;
// она нужна как место, куда добавляется шаг при изменении структуры копии. Пример будущего
// шага: `1: (data) => ({ ...data, ... })` — тогда файл v1 импортируется приложением, которое
// уже пишет v2.
const FORMAT_MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {}

// Приводит данные копии к текущей версии формата. Файл без версии (снимок старого образца)
// миграции не проходит: его дополняет миграция схемы внутри Database.
export function applyFormatMigrations(
  data: Record<string, unknown>,
  fromVersion: number | null,
): Record<string, unknown> {
  let current = data
  for (let version = fromVersion ?? BACKUP_FORMAT_VERSION; version < BACKUP_FORMAT_VERSION; version += 1) {
    const migrate = FORMAT_MIGRATIONS[version]
    if (migrate) current = migrate(current)
  }
  return current
}

// Версия формата: целое число от 1. null — поля в файле нет (копия старого образца).
function readFormatVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`В файле указана непонятная версия формата: ${JSON.stringify(value)}`)
  }
  return value
}

// Обязательные коллекции должны существовать и быть массивами: если их нет, база
// восстановится пустой, а пользователь решит, что копия «сработала».
function requireSnapshot(snapshot: Record<string, unknown>): void {
  const clients = requireCollection(snapshot, 'clients', 'клиентов')
  const orders = requireCollection(snapshot, 'orders', 'заказов')

  clients.forEach((raw, i) => requireRecord(raw, `Клиент №${i + 1}`))
  orders.forEach((raw, i) => {
    const order = requireRecord(raw, `Заказ №${i + 1}`)
    // Позиции заказа нужны всегда: по ним считаются суммы и печатается чек.
    if (!Array.isArray(order.items)) {
      throw new Error(`В копии повреждён заказ №${i + 1}: нет списка позиций`)
    }
  })
  // Необязательные коллекции: если они есть, записи в них тоже должны быть целыми.
  requireCollection(snapshot, 'products', 'товаров', true).forEach((raw, i) =>
    requireRecord(raw, `Товар №${i + 1}`),
  )
  requireCollection(snapshot, 'stockMoves', 'истории склада', true).forEach((raw, i) =>
    requireRecord(raw, `Движение склада №${i + 1}`),
  )
  if (snapshot.settings !== undefined && snapshot.settings !== null) {
    if (typeof snapshot.settings !== 'object' || Array.isArray(snapshot.settings)) {
      throw new Error('В копии повреждены настройки CRM')
    }
  }
}

function requireCollection(
  snapshot: Record<string, unknown>,
  key: string,
  label: string,
  optional = false,
): Array<unknown> {
  const value = snapshot[key]
  if (value === undefined || value === null) {
    if (optional) return []
    throw new Error(`В копии нет списка ${label}`)
  }
  if (!Array.isArray(value)) throw new Error(`В копии повреждён список ${label}`)
  return value
}

// Запись базы — объект с непустым id: по нему связаны заказы, товары и склад.
function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`В копии повреждена запись: ${label}`)
  }
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id) {
    throw new Error(`В копии повреждена запись: ${label} — нет идентификатора`)
  }
  return record
}

// База адресов необязательна: копия, сделанная до её появления, восстанавливается без неё.
function readAddresses(value: unknown): AddressEntry[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new Error('В копии повреждена база адресов')

  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`В копии повреждена база адресов (запись ${i + 1})`)
    }
    const entry = raw as Partial<AddressEntry>
    if (typeof entry.address !== 'string' || !entry.address.trim()) {
      throw new Error(`В копии повреждена база адресов (запись ${i + 1}: не указан адрес)`)
    }
    const lat = Number(entry.lat)
    const lng = Number(entry.lng)
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : uid(),
      cadastralNumber: typeof entry.cadastralNumber === 'string' ? entry.cadastralNumber : '',
      address: entry.address,
      lat: Number.isFinite(lat) ? lat : 0,
      lng: Number.isFinite(lng) ? lng : 0,
    }
  })
}

// Разбирает файл копии: принимает и новый конверт, и снимок старого образца
// (файлы Android-версии), и возвращает JSON для Database.importData().
//
// Проверки до замены данных: это JSON; это файл SelfCRM (а не выгрузка чужой программы);
// версия формата известна и поддерживается; обязательные коллекции на месте; записи
// не повреждены. Любая ошибка — исключение с понятным текстом: интерфейс показывает
// его пользователю, а данные остаются нетронутыми.
export function parseBackup(json: string): ParsedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Файл резервной копии не читается: это не JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Файл резервной копии не читается: ожидался объект JSON')
  }

  const file = parsed as Record<string, unknown>
  const format = typeof file.format === 'string' ? file.format : null
  // Чужой формат не разбираем: молча принять такой файл — значит показать пустую CRM.
  if (format !== null && !SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Это не файл резервной копии SelfCRM (формат «${format}»)`)
  }

  const formatVersion = readFormatVersion(file.version)
  // Файл новее, чем умеет эта версия приложения, импортировать нельзя: неизвестные
  // поля могли бы потеряться. Лучше понятная ошибка, чем тихая неполная база.
  if (formatVersion !== null && formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Копия создана более новой версией SelfCRM (формат ${formatVersion}). ` +
        'Обновите приложение и попробуйте снова.',
    )
  }

  const createdAt = typeof file.createdAt === 'string' ? file.createdAt : null
  const app = readAppInfo(file.app)
  const appVersion = typeof file.appVersion === 'string' ? file.appVersion : (app?.version ?? null)
  const data = file.data

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const snapshot = applyFormatMigrations(data as Record<string, unknown>, formatVersion)
    requireSnapshot(snapshot)
    return {
      formatVersion,
      createdAt,
      app,
      appVersion,
      legacy: false,
      addresses: readAddresses(snapshot.addresses),
      snapshotJson: JSON.stringify(snapshot),
    }
  }

  // Файл старого образца: снимок базы лежит в корне (так пишет Android-сборка SelfCRM).
  if (Array.isArray(file.clients) && Array.isArray(file.orders)) {
    requireSnapshot(file)
    return {
      formatVersion: null,
      createdAt,
      app,
      appVersion,
      legacy: true,
      addresses: readAddresses(file.addresses),
      snapshotJson: JSON.stringify(file),
    }
  }

  throw new Error(
    'В файле нет данных CRM: ожидались клиенты и заказы. ' +
      'Возможно, это резервная копия другой программы.',
  )
}

function readAppInfo(value: unknown): BackupAppInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const info = value as Record<string, unknown>
  const platform: BackupPlatform =
    info.platform === 'telegram' || info.platform === 'android' ? info.platform : 'web'
  const user =
    info.telegramUser && typeof info.telegramUser === 'object' && !Array.isArray(info.telegramUser)
      ? (info.telegramUser as Record<string, unknown>)
      : null
  const id = typeof user?.id === 'number' ? user.id : null
  const label = typeof user?.label === 'string' && user.label ? user.label : null

  return {
    name: typeof info.name === 'string' ? info.name : 'SelfCRM',
    version: typeof info.version === 'string' ? info.version : '',
    platform,
    ...(id !== null ? { telegramUser: { id, ...(label ? { label } : {}) } } : {}),
  }
}

