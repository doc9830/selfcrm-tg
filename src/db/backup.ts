import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { saveAddresses } from './addresses'
import { normalizeBackupText } from './backupText'
import type { Database } from './database'
import { backupFileName, buildBackupJson, parseBackup, type ParsedBackup } from './backupFormat'

/**
 * Сохраняет произвольный JSON-текст как файл (резервная копия, копия до импорта и т.п.).
 *
 * В браузере это обычное скачивание, а на Android — запись файла во временный каталог
 * приложения и системное меню «Поделиться»: Android-WebView игнорирует скачивание по
 * ссылке `<a download>`, поэтому раньше нажатие «Скачать» ничего не делало.
 * Так же формируется PDF-чек (см. src/pdf/documents.ts).
 *
 * В Telegram Mini App этот путь не работает: клиент игнорирует и `<a download>`, и blob-ссылки
 * (`WebApp.downloadFile` принимает только адреса `https:`). Поэтому копия в мини-приложении
 * хранится в облаке Telegram — см. `src/db/cloudBackup.ts`, кнопки в настройках.
 *
 * Дальше файл хранит сам пользователь: в браузере он попадает в «Загрузки», на Android —
 * в системное меню «Поделиться», откуда копию можно отправить себе в чат с ботом
 * (см. `openBotChat` в `src/telegram/webapp.ts`). Никакой автоматики здесь нет и быть не
 * может: Mini App не имеет доступа к истории сообщений.
 */
export async function downloadJson(json: string, fileName: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: fileName,
      data: json,
      directory: Directory.Cache,
      recursive: true,
      // Без явной кодировки плагин считает данные base64 и декодирует их: JSON-текст
      // превращался в мусор, и восстановление падало с «Unexpected token … is not valid
      // JSON». Encoding.UTF8 пишет строку как есть — это и есть формат резервной копии.
      // (В мини-приложении путь нативный не используется, но код общий с Android-сборкой.)
      encoding: Encoding.UTF8,
    })
    await Share.share({
      title: fileName,
      text: fileName,
      files: [file.uri],
    })
    return
  }

  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Скачивает резервную копию в виде JSON-файла: конверт с метаданными и снимок базы.
export function downloadBackup(db: Database): Promise<void> {
  return downloadJson(buildBackupJson(db), backupFileName())
}

// Читает выбранный пользователем файл резервной копии. BOM и пробелы по краям убираются
// сразу (см. db/backupText.ts): файл мог пройти через чат, почту или редактор.
export function readBackupFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(normalizeBackupText(String(reader.result)))
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.readAsText(file)
  })
}

// Восстанавливает базу из файла копии. Понимает и новый формат (конверт с ключом data),
// и файлы старого образца — например копии, сделанные Android-сборкой SelfCRM.
export function restoreBackup(db: Database, json: string): ParsedBackup {
  return applyBackup(db, parseBackup(json))
}

// Применяет уже разобранную копию. Разбор и замена разделены намеренно: экран настроек
// сначала показывает, что лежит в файле, и ждёт подтверждения — разбирать файл дважды
// для этого не нужно.
//
// Импорт полностью заменяет базу. Копию прежнего состояния сохраняет сам Database
// (`selfcrm:data:pre-import-*`), поэтому откатиться можно даже после неудачного импорта.
export function applyBackup(db: Database, parsed: ParsedBackup): ParsedBackup {
  db.importData(parsed.snapshotJson)
  // Загруженная пользователем база адресов — тоже его данные: восстанавливаем и её.
  // Если в копии базы не было, текущая остаётся на месте.
  if (parsed.addresses) saveAddresses(parsed.addresses)
  return parsed
}

// Есть ли в базе данные, которые заменит восстановление: по этому признаку интерфейс
// показывает предупреждение и предлагает сначала сделать копию текущих данных.
export function hasLocalData(db: Database): boolean {
  return (
    db.getClients(true).length > 0 || db.getProducts().length > 0 || db.getOrders().length > 0
  )
}

