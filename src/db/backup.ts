import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
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
 * В Telegram Mini App работает тот же путь, что и в браузере: клиент Telegram сохраняет
 * файл из blob-ссылки. Метод WebApp.downloadFile здесь не подходит намеренно — он
 * принимает только адреса `https:` (проверка `a.protocol != 'https:'` в
 * telegram-web-app.js), а данные CRM лежат на устройстве и наружу не отдаются.
 */
export async function downloadJson(json: string, fileName: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: fileName,
      data: json,
      directory: Directory.Cache,
      recursive: true,
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

// Читает выбранный пользователем файл резервной копии.
export function readBackupFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.readAsText(file)
  })
}

// Восстанавливает базу из файла копии. Понимает и новый формат (конверт с ключом data),
// и файлы старого образца — например копии, сделанные Android-сборкой SelfCRM.
export function restoreBackup(db: Database, json: string): ParsedBackup {
  const parsed = parseBackup(json)
  db.importData(parsed.snapshotJson)
  return parsed
}

