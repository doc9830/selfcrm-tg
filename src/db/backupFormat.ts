// Формат файла резервной копии (версионируемый конверт).
//
//   {
//     "format": "selfcrm",          // признак формата
//     "version": 1,                 // версия ФОРМАТА файла (не версия схемы данных)
//     "createdAt": "2026-01-01T00:00:00.000Z",
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
// конверта в будущем не сломает импорт (см. проверку версии ниже).
//
// Модуль чистый: не трогает DOM, файлы и сеть — его удобно тестировать.

import { Capacitor } from '@capacitor/core'
import { APP_VERSION } from '../version'
import { getTelegramUserId, getTelegramUserLabel, isTelegramEnvironment } from '../telegram/webapp'
import type { Database } from './database'

export const BACKUP_FORMAT = 'selfcrm'
export const BACKUP_FORMAT_VERSION = 1

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
  // Снимок базы в виде JSON-строки — то, что принимает Database.importData().
  snapshotJson: string
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

// Имя файла копии: selfcrm-backup-2026-01-01-12-30-45.json
export function backupFileName(date: Date = new Date()): string {
  return `selfcrm-backup-${fileStamp(date)}.json`
}

export function fileStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

// Собирает содержимое файла копии: конверт + снимок базы из Database.exportData().
export function buildBackupJson(db: Database, date: Date = new Date()): string {
  const snapshot = JSON.parse(db.exportData()) as Record<string, unknown>
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: date.toISOString(),
      app: currentAppInfo(),
      data: snapshot,
      // Обратная совместимость: старые версии SelfCRM читают снимок из корня файла.
      clients: snapshot.clients,
      products: snapshot.products,
      orders: snapshot.orders,
      stockMoves: snapshot.stockMoves,
      settings: snapshot.settings,
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

const PLATFORM_LABEL: Record<BackupPlatform, string> = {
  telegram: 'Telegram',
  android: 'приложении SelfCRM для Android',
  web: 'браузере',
}

// Разбирает файл копии: принимает и новый конверт, и снимок старого образца
// (файлы Android-версии), и возвращает JSON для Database.importData().
export function parseBackup(json: string): ParsedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Файл резервной копии не читается')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Некорректный файл резервной копии')
  }

  const file = parsed as Record<string, unknown>
  const formatVersion = typeof file.version === 'number' ? file.version : null
  const createdAt = typeof file.createdAt === 'string' ? file.createdAt : null
  const app = readAppInfo(file.app)
  const data = file.data

  // Файл новее, чем умеет эта версия приложения, импортировать нельзя: неизвестные
  // поля могли бы потеряться. Лучше понятная ошибка, чем тихая неполная база.
  if (file.format === BACKUP_FORMAT && formatVersion !== null && formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Копия создана более новой версией SelfCRM (формат ${formatVersion}). ` +
        'Обновите приложение и попробуйте снова.',
    )
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { formatVersion, createdAt, app, snapshotJson: JSON.stringify(data) }
  }

  if (Array.isArray(file.clients) && Array.isArray(file.orders)) {
    return { formatVersion: null, createdAt, app, snapshotJson: JSON.stringify(file) }
  }

  throw new Error('Некорректный файл резервной копии')
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

