// Отчёт в Excel в мини-приложении: файл уходит временной ссылкой.
//
// В WebView клиента Telegram файл со страницы отдать нечем: клиент игнорирует и
// blob-ссылки, и `<a download>`, а `WebApp.downloadFile` принимает только адреса
// `https:`. Поэтому отчёт идёт по тому же пути, что и чек (ссылка вместо файла), но
// в отличие от чека данные в адрес не помещаются — в отчёте все заказы, позиции,
// клиенты и товары. Значит, файл должен где-то полежать:
//
//   SelfCRM (мини-приложение) → POST /files на Worker бота → временное хранилище (KV)
//      ↓ ссылка https://<worker>/files/<случайный id>
//   WebApp.downloadFile(url) — клиент сохраняет файл; если метод недоступен —
//   openLink(url) — файл скачает встроенный браузер; иначе ссылка в буфер обмена
//
// Тот же Worker, что принимает webhook бота: отдельного сервера и второй
// инфраструктуры нет. Данные CRM на сервере не живут — KV хранит только переданный
// файл, час, под случайным именем (см. worker/src/files.ts).
import {
  registerReportFileBridge,
  REPORT_XLSX_TYPE,
  type ReportBridgeResult,
  type ReportFileBridge,
} from '../reports/delivery'
import { copyTextToClipboard } from '../pdf/receiptDelivery'
import { downloadTelegramFile, insideTelegramWebView, openExternalLink } from './webapp'

// Адрес Worker'а: он же обслуживает бота. Значение берётся из сборки, если задано
// (`VITE_WORKER_URL`), иначе — адрес проекта: это не секрет, адрес виден и в кнопке
// бота. Так выгрузка работает без дополнительных настроек сборки.
const DEFAULT_WORKER_URL = 'https://selfcrm-bot.mik2639.workers.dev'

const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_WORKER_URL

// Предел размера на стороне Worker'а: проверяем заранее, чтобы не гнать мегабайты
// впустую и сказать понятную причину.
const MAX_REPORT_BYTES = 8 * 1024 * 1024

const FILE_NAME_HEADER = 'X-File-Name'

export function reportFilesUrl(): string {
  return `${WORKER_URL}/files`
}

// Загрузка файла в временное хранилище. Возвращает ссылку, по которой файл скачают.
// Ошибки — с понятным текстом: экран статистики показывает его как есть.
export async function uploadReportFile(blob: Blob, fileName: string): Promise<string> {
  if (blob.size > MAX_REPORT_BYTES) {
    throw new Error('Отчёт слишком большой для отправки — выберите период покороче')
  }

  let response: Response
  try {
    response = await fetch(reportFilesUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': REPORT_XLSX_TYPE,
        // Заголовки передаются только латиницей, поэтому имя в percent-encoding —
        // Worker возвращает его в имени файла как есть.
        [FILE_NAME_HEADER]: encodeURIComponent(fileName),
      },
      body: blob,
    })
  } catch {
    throw new Error('Нет связи с сервером выгрузки — проверьте интернет и повторите')
  }

  if (!response.ok) {
    // 503 — Worker развёрнут без привязки хранилища: это настройка, а не сбой сети.
    throw new Error(
      response.status === 503
        ? 'Выгрузка файлов не настроена на сервере — скачайте отчёт в браузере'
        : 'Сервер не принял файл — попробуйте ещё раз',
    )
  }

  const payload = (await response.json().catch(() => null)) as { url?: unknown } | null
  if (!payload || typeof payload.url !== 'string' || !payload.url) {
    throw new Error('Сервер не вернул ссылку на файл — попробуйте ещё раз')
  }
  return payload.url
}

// Мост отчёта: файл → ссылка → скачивание средствами клиента. Совпадает по
// интерфейсу с `ReportFileBridge`, поэтому общий код выгрузки про Telegram не знает.
export const reportFileBridge: ReportFileBridge = {
  async send({ blob, fileName, message }): Promise<ReportBridgeResult> {
    const url = await uploadReportFile(blob, fileName)

    // 1. Клиент скачивает файл сам (Bot API 8.0+): файл появляется в «Загрузках».
    if (downloadTelegramFile(url, fileName)) return { kind: 'opened', url }

    // 2. Клиент открывает ссылку в своём браузере: файл скачает браузер.
    if (openExternalLink(url) !== 'failed') return { kind: 'opened', url }

    // 3. Ничего не вышло: ссылка в буфер обмена — её можно открыть вручную.
    const copied = await copyTextToClipboard(`${message}\n${url}`)
    return { kind: copied ? 'copied' : 'failed', url }
  },
}

// Регистрация моста при запуске приложения. Только внутри клиента Telegram: в
// браузере (даже если открыт адрес Pages) файл скачивается обычным путём, как в
// веб-версии, и через сервер ничего не идёт.
export function registerTelegramReportFiles(): void {
  if (!insideTelegramWebView()) return
  registerReportFileBridge(reportFileBridge)
}
