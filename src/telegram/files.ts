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
//
// Кнопка «Поделиться» идёт дальше выгрузки: файл уходит документом в чат, который выберет
// пользователь. Сообщение с файлом собирает Worker (`savePreparedInlineMessage`), а меню
// выбора чата открывает сам клиент (`WebApp.shareMessage`, Bot API 8.0+) — подробности в
// worker/src/share.ts. Если клиент отправлять сообщения не умеет, остаётся прежний путь
// чека: выбор чата открывается ссылкой `t.me/share/url`, только уходит ссылка, а не файл.
import {
  registerReportFileBridge,
  REPORT_XLSX_TYPE,
  type ReportBridgeResult,
  type ReportFileBridge,
  type ReportFileInput,
  type ReportShareResult,
} from '../reports/delivery'
import { copyTextToClipboard } from '../pdf/receiptDelivery'
import { telegramShareUrl } from '../pdf/receipt'
import {
  downloadTelegramFile,
  getTelegramWebApp,
  insideTelegramWebView,
  openExternalLink,
  shareTelegramMessage,
} from './webapp'

// Адрес Worker'а: он же обслуживает бота. Значение берётся из сборки, если задано
// (`VITE_WORKER_URL`), иначе — адрес проекта: это не секрет, адрес виден и в кнопке
// бота. Так выгрузка работает без дополнительных настроек сборки.
const DEFAULT_WORKER_URL = 'https://selfcrm-bot.mik2639.workers.dev'

const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_WORKER_URL

// Предел размера на стороне Worker'а: проверяем заранее, чтобы не гнать мегабайты
// впустую и сказать понятную причину.
const MAX_REPORT_BYTES = 8 * 1024 * 1024

const FILE_NAME_HEADER = 'X-File-Name'

// Путь слоя файлов на Worker'е: приём и выдача отчёта. «Поделиться» — тот же путь плюс
// идентификатор файла и `/share` (см. worker/src/share.ts).
const FILES_PATH = '/files'

export function reportFilesUrl(): string {
  return `${WORKER_URL}${FILES_PATH}`
}

// Что отдаёт временное хранилище: ссылку на файл и его идентификатор. Идентификатор нужен
// «Поделиться»: по нему Worker готовит сообщение с этим же файлом.
export interface UploadedReport {
  id: string
  url: string
}

// Загрузка файла в временное хранилище. Возвращает ссылку, по которой файл скачают, и
// идентификатор — по нему готовится сообщение для «Поделиться».
// Ошибки — с понятным текстом: экран статистики показывает его как есть.
export async function uploadReportFile(blob: Blob, fileName: string): Promise<UploadedReport> {
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

  const payload = (await response.json().catch(() => null)) as { id?: unknown; url?: unknown } | null
  if (
    !payload ||
    typeof payload.url !== 'string' ||
    !payload.url ||
    typeof payload.id !== 'string' ||
    !payload.id
  ) {
    throw new Error('Сервер не вернул ссылку на файл — попробуйте ещё раз')
  }
  return { id: payload.id, url: payload.url }
}

// Подпись сессии мини-приложения: по ней Worker понимает, что запрос пришёл из Telegram, и
// узнаёт пользователя (см. worker/src/webappAuth.ts). Пустая строка — приложение открыто вне
// мини-приложения: тогда Worker откажет, а мы уйдём на запасной путь.
function telegramInitData(): string {
  return getTelegramWebApp()?.initData ?? ''
}

// Подготовка сообщения с файлом: Worker проверяет подпись initData и собирает сообщение
// (`savePreparedInlineMessage`). В ответ приходят идентификатор сообщения для клиента и
// ссылка на копию файла — её срок отсчитывается заново, поэтому её же использует запасной
// путь (ссылка из выгрузки могла прожить уже полчаса).
async function prepareReportShare(
  fileId: string,
  caption: string,
): Promise<{ preparedMessageId: string; url: string }> {
  let response: Response
  try {
    response = await fetch(`${WORKER_URL}${FILES_PATH}/${fileId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: telegramInitData(), caption }),
    })
  } catch {
    throw new Error('Нет связи с сервером выгрузки — проверьте интернет и повторите')
  }

  const payload = (await response.json().catch(() => null)) as {
    preparedMessageId?: unknown
    url?: unknown
  } | null
  const preparedMessageId =
    payload && typeof payload.preparedMessageId === 'string' ? payload.preparedMessageId : ''
  if (!response.ok || !preparedMessageId) {
    throw new Error('Сервер не подготовил отправку — попробуйте ещё раз')
  }

  return {
    preparedMessageId,
    url: typeof payload?.url === 'string' ? payload.url : '',
  }
}

// «Поделиться» отчётом: файл уходит документом в чат, который выберет пользователь.
//
// Порядок: файл в временное хранилище → Worker готовит сообщение с ним → клиент открывает
// родное меню выбора чата. Если клиент отправлять сообщения не умеет или меню отказало,
// остаётся прежний путь чека: выбор чата открывается ссылкой `t.me/share/url`, только уходит
// ссылка, а не файл.
//
// Ошибки загрузки бросаются наверх — экран показывает их текстом, как и у выгрузки. Отказ
// отправки — это исход, а не ошибка: его объясняет подпись под кнопкой.
async function shareReportWithTelegram(input: ReportFileInput): Promise<ReportShareResult> {
  const uploaded = await uploadReportFile(input.blob, input.fileName)

  // Отказ подготовки (например, Telegram не принял сообщение) — не сбой: уходим на ссылку.
  const prepared = await prepareReportShare(uploaded.id, input.message).catch(() => null)

  if (prepared) {
    const outcome = await shareTelegramMessage(prepared.preparedMessageId)
    if (outcome === 'sent') return { kind: 'sent' }
    if (outcome === 'cancelled') return { kind: 'cancelled' }
    if (outcome === 'expired') return { kind: 'expired' }
    // 'unsupported' и 'failed' — повод для запасного пути ниже.
  }

  // Запасной путь: выбор чата клиент открывает по ссылке. Уходит ссылка (живёт час), а не
  // файл — получатель откроет её и скачает отчёт.
  const url = prepared?.url || uploaded.url
  if (openExternalLink(telegramShareUrl(url, input.message)) !== 'failed') return { kind: 'link' }
  // Ссылку открыть тоже не вышло: если сообщение подготовить не удалось, значит клиент не
  // умеет ни того, ни другого, и делиться в нём нечем.
  return { kind: prepared ? 'failed' : 'unavailable' }
}

// Мост отчёта: файл → ссылка → скачивание средствами клиента. Совпадает по
// интерфейсу с `ReportFileBridge`, поэтому общий код выгрузки про Telegram не знает.
export const reportFileBridge: ReportFileBridge = {
  async send({ blob, fileName, message }): Promise<ReportBridgeResult> {
    const { url } = await uploadReportFile(blob, fileName)

    // 1. Клиент скачивает файл сам (Bot API 8.0+): файл появляется в «Загрузках».
    if (downloadTelegramFile(url, fileName)) return { kind: 'opened', url }

    // 2. Клиент открывает ссылку в своём браузере: файл скачает браузер.
    if (openExternalLink(url) !== 'failed') return { kind: 'opened', url }

    // 3. Ничего не вышло: ссылка в буфер обмена — её можно открыть вручную.
    const copied = await copyTextToClipboard(`${message}\n${url}`)
    return { kind: copied ? 'copied' : 'failed', url }
  },
  // «Поделиться» есть только в этом мосте: в браузере и Android-сборке системное меню
  // открывается уже при выгрузке, поэтому там второй кнопки не нужно.
  share: shareReportWithTelegram,
}

// Регистрация моста при запуске приложения. Только внутри клиента Telegram: в
// браузере (даже если открыт адрес Pages) файл скачивается обычным путём, как в
// веб-версии, и через сервер ничего не идёт.
export function registerTelegramReportFiles(): void {
  if (!insideTelegramWebView()) return
  registerReportFileBridge(reportFileBridge)
}
