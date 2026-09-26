// Куда отдать готовый отчёт.
//
// Способ выбирается по возможностям клиента, а не по названию системы:
//   1. 'native' — сборка Capacitor: файл пишется на устройство и уходит системным
//      меню «Поделиться» (Filesystem + Share работают и на Android, и на iOS);
//   2. 'bridge' — мини-приложение Telegram: файл со страницы отдать нечем (клиент
//      игнорирует blob-ссылки и `<a download>`), поэтому он уходит через мост
//      платформы — временной HTTPS-ссылкой (мост ставит слой Telegram);
//   3. 'file-share' — браузер умеет отдавать файлы через системное меню;
//   4. 'file-download' — обычное скачивание файла браузером.
//
// Про Telegram общий код не знает: мост регистрирует платформа
// (`registerReportFileBridge`), а решение принимает чистая функция
// `planReportDelivery`, поэтому оно одинаково во всех версиях приложения и
// проверяется тестами.
//
// В мини-приложении Telegram у выгрузки есть второй путь — «Поделиться»: файл уходит
// документом в чат, который выберет пользователь (родное меню клиента). Он не заменяет
// выгрузку, а живёт рядом с ней: `shareReportFile` пользуется тем же мостом и возвращает
// свой исход, потому что вопросы у пользователя разные — «сохранить себе» и «отправить
// клиенту» (см. `shareReportAvailable`).
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

// Тип файла отчёта: по нему система и Telegram понимают, что скачивают таблицу.
export const REPORT_XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type ReportDeliveryPlan = 'native' | 'bridge' | 'file-share' | 'file-download'

export interface ReportDeliveryEnv {
  native: boolean
  // Мост платформы зарегистрирован: отдать файл можно только ссылкой.
  bridge: boolean
  canShareFiles: boolean
}

export function planReportDelivery(env: ReportDeliveryEnv): ReportDeliveryPlan {
  if (env.native) return 'native'
  if (env.bridge) return 'bridge'
  if (env.canShareFiles) return 'file-share'
  return 'file-download'
}

// Куда попала ссылка на файл в мини-приложении Telegram: клиент открыл её сам или
// она легла в буфер обмена, либо отдать файл не удалось вовсе.
export type ReportBridgeResult = { kind: 'opened' | 'copied' | 'failed'; url: string | null }

// Куда попало «Поделиться» файлом: 'sent' — файл ушёл документом в выбранный чат, 'link' —
// файл отдать не вышло и ушла ссылка на него, 'cancelled' — меню закрыли, 'expired' —
// подготовленное сообщение устарело, 'unavailable' — клиент делиться не умеет, 'failed' —
// отправка не удалась. Экран объясняет исход текстом, поэтому значения не смешиваются.
export type ReportShareResult = {
  kind: 'sent' | 'cancelled' | 'link' | 'expired' | 'unavailable' | 'failed'
}

// Мост платформы: превращает готовый файл в то, что умеет клиент. В мини-приложении
// Telegram это загрузка во временное хранилище и выдача ссылки (src/telegram/files.ts).
export interface ReportFileBridge {
  send(file: { blob: Blob; fileName: string; message: string }): Promise<ReportBridgeResult>
  // Поделиться файлом отдельным действием. Есть только там, где выгрузка отдаёт файл не
  // сразу в чат: в мини-приложении Telegram это родное меню выбора чата
  // (`WebApp.shareMessage`, см. src/telegram/files.ts). В браузере и Android-сборке такого
  // пути нет — там системное меню открывается уже при выгрузке, и второй кнопки не нужно.
  share?(file: ReportFileInput): Promise<ReportShareResult>
}

let platformBridge: ReportFileBridge | null = null

// Регистрация моста: вызывается один раз при запуске приложения на платформе, у
// которой он есть. В браузере и в Android-сборке мост не нужен — там файл
// сохраняется сам, поэтому общий код выгрузки остаётся одинаковым.
export function registerReportFileBridge(next: ReportFileBridge | null): void {
  platformBridge = next
}

export function reportFileBridge(): ReportFileBridge | null {
  return platformBridge
}

export type ReportDeliveryResult =
  | { kind: 'native' }
  | { kind: 'shared' }
  | { kind: 'downloaded' }
  | { kind: 'cancelled' }
  // Отдать файл нечем: мини-приложение Telegram без зарегистрированного моста.
  | { kind: 'unsupported' }
  | { kind: 'bridge'; result: ReportBridgeResult }

export interface ReportFileInput {
  blob: Blob
  fileName: string
  // Подпись файла: её показывает системное меню и сообщение в чате.
  message: string
}

// Отдаёт готовый отчёт пользователю. Выбор пути — здесь, поэтому экран статистики
// не знает ни про WebView клиента Telegram, ни про системные меню.
export async function deliverReportFile(input: ReportFileInput): Promise<ReportDeliveryResult> {
  const plan = planReportDelivery({
    native: Capacitor.isNativePlatform(),
    bridge: platformBridge !== null,
    canShareFiles: canShareFiles(),
  })

  if (plan === 'bridge') {
    const bridge = platformBridge
    if (!bridge) return { kind: 'unsupported' }
    return { kind: 'bridge', result: await bridge.send(input) }
  }

  if (plan === 'native') {
    await writeReportToDevice(input)
    return { kind: 'native' }
  }

  const file = new File([input.blob], input.fileName, { type: REPORT_XLSX_TYPE })

  if (plan === 'file-share') {
    const target = await shareFile(file, input.message)
    if (target === 'shared') return { kind: 'shared' }
    if (target === 'cancelled') return { kind: 'cancelled' }
    // Клиент обещал поддержку файлов, но отдать не смог (например, системное меню
    // требует нажатия в том же такте, а таблица собиралась асинхронно). Запасной
    // путь — скачивание: ему нажатие не нужно.
  }

  downloadReportFile(input.blob, input.fileName)
  return { kind: 'downloaded' }
}

// Можно ли поделиться файлом отдельным действием. Кнопка «Поделиться» показывается только
// тогда, когда такой путь есть у платформы: в мини-приложении Telegram — есть, в браузере и
// Android-сборке — нет (там файл уходит системным меню уже при выгрузке).
export function shareReportAvailable(): boolean {
  return typeof platformBridge?.share === 'function'
}

// Отдаёт готовый отчёт в выбор чата. Выбор пути — здесь, поэтому экран статистики не знает
// ни про WebView клиента Telegram, ни про его методы; 'unavailable' означает, что делиться
// нечем (нет моста или платформа такого пути не имеет).
export async function shareReportFile(input: ReportFileInput): Promise<ReportShareResult> {
  const bridge = platformBridge
  if (!bridge || typeof bridge.share !== 'function') return { kind: 'unavailable' }
  return bridge.share(input)
}

// Поддержка «Поделиться с файлом» проверяется пробным файлом: `canShare` отвечает
// не по названию платформы, а по факту — умеет ли клиент отдать именно таблицу.
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') return false
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
  try {
    const probe = new File(['xlsx'], 'report.xlsx', { type: REPORT_XLSX_TYPE })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

async function shareFile(
  file: File,
  message: string,
): Promise<'shared' | 'cancelled' | 'unavailable'> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return 'unavailable'
  try {
    await navigator.share({ files: [file], title: message, text: message })
    return 'shared'
  } catch (error) {
    // Отмена системного меню — не ошибка: пользователь закрыл окно и может повторить.
    if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled'
    return 'unavailable'
  }
}

// Скачивание файла браузером. Работает в веб-версии и на Android; в WebView клиента
// Telegram этот путь не выбирается — там файл отдаёт мост.
export function downloadReportFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// Запись файла в сборке Capacitor: временный каталог устройства плюс системное меню
// «Поделиться», откуда отчёт сохраняют в «Файлы» или отправляют в мессенджер.
export async function writeReportToDevice({
  blob,
  fileName,
  message,
}: ReportFileInput): Promise<void> {
  const file = await Filesystem.writeFile({
    path: fileName,
    // Blob принимает только веб-реализация Filesystem, поэтому содержимое
    // передаётся строкой base64 — так файл доходит до устройства без искажений.
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  })
  await Share.share({ title: message, text: message, files: [file.uri] })
}

// Содержимое Blob'а в base64 — без префикса data-URL.
async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл отчёта'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(blob)
  })
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

