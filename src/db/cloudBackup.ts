// Резервная копия в облаке Telegram (WebApp.CloudStorage) и восстановление из настроек.
//
// Зачем это нужно: данные CRM лежат в localStorage WebView, а он пропадает при очистке
// данных Telegram, переустановке клиента или смене телефона. Файл-копию внутри
// мини-приложения сохранить нельзя (WebApp.downloadFile принимает только https-ссылки,
// а данные CRM наружу не отдаются), поэтому копия отправляется в облако Telegram: оно
// привязано к аккаунту, и данные можно вернуть на любом устройстве прямо из настроек.
//
// Что хранится: ровно тот же конверт, что и в файле копии (buildBackupJson), — копия из
// облака полностью совместима с файловой. CloudStorage принимает не больше 4096 символов
// в значении, поэтому текст режется на части по границам символов и по байтам
// (кириллица занимает до двух байт на символ — считаем байты, а не символы).
//
// Ключи в облаке (с префиксом selfcrm:, чтобы не мешать другим мини-аппам):
//   selfcrm:backup:manifest  — дата, имя файла, число частей и состав копии;
//   selfcrm:backup:part:0…N  — части JSON.
//
// Секретов здесь нет: initData и токен бота в копию не попадают (см. backupFormat.ts).

import { backupFileName, buildBackupJson, parseBackup, summarizeBackup } from './backupFormat'
import type { BackupCounts, ParsedBackup } from './backupFormat'
import type { Database } from './database'
import {
  cloudGetItem,
  cloudGetItems,
  cloudGetKeys,
  cloudRemoveItems,
  cloudSetItem,
  cloudStorageAvailability,
  type CloudStorageAvailability,
} from '../telegram/cloudStorage'

export const CLOUD_MANIFEST_KEY = 'selfcrm:backup:manifest'
export const CLOUD_PART_PREFIX = 'selfcrm:backup:part:'

// Признак нашего манифеста: по нему видно, что в облаке лежит копия SelfCRM, а не
// что-то чужое (в аккаунте Telegram есть и другие мини-аппы).
export const CLOUD_BACKUP_FORMAT = 'selfcrm-cloud-backup'
export const CLOUD_BACKUP_VERSION = 1

// Лимит CloudStorage — 4096 символов в значении, но Telegram проверяет и длину в байтах,
// а в копии много кириллицы. 3500 байт — безопасный размер части: и в символах, и в
// байтах он укладывается в лимит.
export const CLOUD_PART_BYTES = 3500

// Ключей в облаке не больше 1024 (манифест занимает один). Копия крупнее 3,5 МБ в облако
// Telegram не поместится — об этом честно скажем пользователю, предложив файл.
export const CLOUD_MAX_PARTS = 1000

// Манифест: то, что нужно интерфейсу для надписи «Копия от 25.09.2026, 12:30 · Клиентов: 12»
// без чтения самих данных.
export interface CloudBackupManifest {
  format: string
  version: number
  createdAt: string
  fileName: string
  parts: number
  bytes: number
  counts: BackupCounts
}

export interface CloudBackupInfo {
  createdAt: string
  fileName: string
  parts: number
  bytes: number
  counts: BackupCounts
}

export interface LoadedCloudBackup {
  info: CloudBackupInfo
  parsed: ParsedBackup
}

// Облако доступно только в мини-приложении Telegram и только в клиентах Bot API 6.9+.
// Экран настроек по этому признаку показывает облачные кнопки либо способ с файлом, а если
// облака нет — объясняет причину ('old-client' — обновить Telegram, 'outside-telegram' —
// открыть SelfCRM из бота).
export function cloudBackupAvailability(): CloudStorageAvailability {
  return cloudStorageAvailability()
}

// Сохраняет копию базы в облако Telegram и возвращает её метаданные.
//
// Порядок записи выбран осознанно: сначала части, потом манифест. Если запись прервётся
// (пользователь закрыл приложение, пропала сеть), манифест останется от прежней копии, а
// значит прежняя копия продолжит читаться целиком — повреждённой она выглядеть не будет.
export async function saveCloudBackup(
  db: Database,
  date: Date = new Date(),
): Promise<CloudBackupInfo> {
  const json = buildBackupJson(db, date)
  // Копию сразу разбираем тем же разборщиком, что и при восстановлении: если данные в
  // базе повреждены и копия получилась нечитаемой, пользователь узнает об этом сейчас,
  // а не в момент, когда копия понадобится.
  const counts = summarizeBackup(parseBackup(json)).counts
  const parts = splitByBytes(json, CLOUD_PART_BYTES)
  if (parts.length > CLOUD_MAX_PARTS) {
    throw new Error(
      'Данных слишком много для облака Telegram. Сохраните копию файлом или уменьшите базу',
    )
  }

  const manifest: CloudBackupManifest = {
    format: CLOUD_BACKUP_FORMAT,
    version: CLOUD_BACKUP_VERSION,
    createdAt: date.toISOString(),
    fileName: backupFileName(date),
    parts: parts.length,
    bytes: utf8Bytes(json),
    counts,
  }

  const previous = (await cloudGetKeys()).filter(isPartKey)
  for (let index = 0; index < parts.length; index += 1) {
    await cloudSetItem(partKey(index), parts[index])
  }
  await cloudSetItem(CLOUD_MANIFEST_KEY, JSON.stringify(manifest))

  // Части прежней копии больше не нужны: облако не резиновое (всего 1024 ключа).
  const fresh = new Set(parts.map((_, index) => partKey(index)))
  const stale = previous.filter((key) => !fresh.has(key))
  if (stale.length > 0) await cloudRemoveItems(stale)

  return toInfo(manifest)
}

// Метаданные копии для интерфейса или null, если копии в облаке нет.
export async function readCloudBackupInfo(): Promise<CloudBackupInfo | null> {
  const manifest = await readManifest()
  return manifest ? toInfo(manifest) : null
}

// Читает копию из облака и разбирает её: экран настроек показывает состав копии и ждёт
// подтверждения пользователя, поэтому разбор отделён от замены данных (как и с файлом).
export async function readCloudBackup(): Promise<LoadedCloudBackup> {
  const manifest = await readManifest()
  if (!manifest) throw new Error('В облаке Telegram нет резервной копии SelfCRM')

  const keys = partKeys(manifest.parts)
  const stored = await cloudGetItems(keys)
  const missing = keys.filter((key) => typeof stored[key] !== 'string')
  if (missing.length > 0) {
    throw new Error(
      `Копия в облаке Telegram повреждена: не хватает ${missing.length} из ${keys.length} частей. ` +
        'Сохраните копию заново с этого устройства',
    )
  }

  const json = keys.map((key) => stored[key]).join('')
  return { info: toInfo(manifest), parsed: parseBackup(json) }
}

// Удаляет копию из облака Telegram. Данные на устройстве не затрагиваются.
export async function removeCloudBackup(): Promise<void> {
  const manifest = await readManifest()
  const keys = manifest ? partKeys(manifest.parts) : (await cloudGetKeys()).filter(isPartKey)
  if (keys.length > 0) await cloudRemoveItems(keys)
  await cloudRemoveItems([CLOUD_MANIFEST_KEY])
}

// Читает манифест. null означает «копии нет» — так же выглядит чужое или испорченное
// значение: молча принять его за копию означало бы показать пустые метаданные.
async function readManifest(): Promise<CloudBackupManifest | null> {
  const raw = await cloudGetItem(CLOUD_MANIFEST_KEY)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const file = parsed as Record<string, unknown>
  if (file.format !== CLOUD_BACKUP_FORMAT) return null
  const parts = typeof file.parts === 'number' ? file.parts : 0
  if (!Number.isInteger(parts) || parts < 1) return null

  return {
    format: CLOUD_BACKUP_FORMAT,
    version: typeof file.version === 'number' ? file.version : CLOUD_BACKUP_VERSION,
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : new Date().toISOString(),
    fileName: typeof file.fileName === 'string' ? file.fileName : backupFileName(),
    parts,
    bytes: typeof file.bytes === 'number' ? file.bytes : 0,
    counts: readCounts(file.counts),
  }
}

// Режет строку на части так, чтобы каждая укладывалась в лимит CloudStorage по байтам.
// Идём по символам (code points), поэтому суррогатные пары и многобайтовая кириллица
// не рвутся, а склейка частей даёт исходный текст без изменений.
export function splitByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error('Размер части слишком мал')

  const parts: string[] = []
  let part = ''
  let size = 0
  for (const char of text) {
    const charBytes = utf8Length(char)
    if (size + charBytes > maxBytes && size > 0) {
      parts.push(part)
      part = ''
      size = 0
    }
    part += char
    size += charBytes
  }
  if (part.length > 0) parts.push(part)
  return parts
}

// Длина строки в байтах UTF-8: Telegram считает лимит значения в байтах, а не в символах.
export function utf8Bytes(text: string): number {
  let total = 0
  for (const char of text) total += utf8Length(char)
  return total
}

function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

function partKey(index: number): string {
  return `${CLOUD_PART_PREFIX}${index}`
}

function partKeys(parts: number): string[] {
  return Array.from({ length: parts }, (_, index) => partKey(index))
}

function isPartKey(key: string): boolean {
  return key.startsWith(CLOUD_PART_PREFIX)
}

function toInfo(manifest: CloudBackupManifest): CloudBackupInfo {
  return {
    createdAt: manifest.createdAt,
    fileName: manifest.fileName,
    parts: manifest.parts,
    bytes: manifest.bytes,
    counts: manifest.counts,
  }
}

function readCounts(value: unknown): BackupCounts {
  const counts = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const number = (key: string) => (typeof counts[key] === 'number' ? (counts[key] as number) : 0)
  return {
    clients: number('clients'),
    products: number('products'),
    orders: number('orders'),
    reminders: number('reminders'),
    stockMoves: number('stockMoves'),
    addresses: number('addresses'),
  }
}
