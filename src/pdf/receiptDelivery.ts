// Как отдать чек: файлом или ссылкой.
//
// Выбор зависит не от желания, а от возможностей клиента, и он одинаков для iPhone и
// Android: решает не название системы, а то, что клиент умеет. Порядок один:
//   1. 'native' — сборка Capacitor: файл пишется на устройство и уходит системным меню
//      «Поделиться» (плагин Share работает и на Android, и на iOS);
//   2. 'link-share' — WebView клиента Telegram: файл со страницы отдать нечем (клиент
//      игнорирует и blob-ссылки, и `<a download>`, а `WebApp.downloadFile` принимает
//      только адреса `https:`), поэтому чек уходит ссылкой — получатель открывает её и
//      сохраняет PDF;
//   3. 'file-share' — клиент умеет `navigator.share` с файлами (проверка пробным PDF):
//      в системное меню уходит сам файл;
//   4. 'file-download' — обычное скачивание файла браузером.
//
// Само правило выбора — чистая функция: её проверяют тесты, а `documents.ts` только
// выполняет выбранный план.
//
// Telegram проверяется раньше Web Share API намеренно. В WebView клиента
// `navigator.share` и `navigator.canShare` объявлены и на пробный PDF отвечают «да», но
// системного меню у WebView нет: промис не завершается, и нажатие «Чек (PDF)» выглядело
// как «ничего не произошло». Ссылку же открывает сам клиент Telegram (`t.me/share/url` →
// выбор чата) — этот путь одинаков на iPhone и Android.
import { insideTelegramWebView, openExternalLink } from '../telegram/webapp'
import { telegramShareUrl } from './receipt'

export interface ReceiptDeliveryEnv {
  // Приложение собрано под нативную платформу (Capacitor): файл можно записать на
  // устройство. Плагины Filesystem и Share работают и на Android, и на iOS.
  native: boolean
  // Клиент умеет делиться файлом (Web Share API с файлами). Спрашивать об этом имеет
  // смысл только вне WebView клиента Telegram: там ответ «да» ничего не значит — меню
  // всё равно не открывается.
  canShareFiles: boolean
  // Открыто внутри WebView клиента Telegram: мини-приложение или его встроенный браузер.
  telegram: boolean
}

export type ReceiptDeliveryPlan = 'native' | 'file-share' | 'link-share' | 'file-download'

// Порядок веток — от самой удобной доставки к самой простой; Telegram стоит раньше
// файлов, потому что в мини-приложении файл отдать нечем (см. выше).
export function planReceiptDelivery(env: ReceiptDeliveryEnv): ReceiptDeliveryPlan {
  if (env.native) return 'native'
  if (env.telegram) return 'link-share'
  if (env.canShareFiles) return 'file-share'
  return 'file-download'
}

// Поддержка «Поделиться с файлом» проверяется пробным файлом: `canShare` отвечает
// не по названию платформы, а по факту — умеет ли клиент отдать именно PDF. В
// мини-приложении Telegram эта проверка не нужна: там чек уходит ссылкой.
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') return false
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
  try {
    const probe = new File(['%PDF'], 'check.pdf', { type: 'application/pdf' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

// Клиент на iPhone или iPad: файл со страницы там не скачивается — blob-ссылка с
// `<a download>` открывается в просмотрщике PDF (то есть показывает тот же чек заново), а
// во встроенных браузерах приложений и вовсе остаётся без ответа. Файл отдаёт только
// системное меню «Поделиться», где есть «Сохранить в файлы». Это единственное место, где
// решение зависит от названия системы, и причина всё та же: не название, а то, что умеет
// браузер этой системы. На Android скачивание файла из страницы работает, поэтому там
// кнопки другие (см. `screens/ReceiptView.tsx`).
export function isIosClient(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ представляется настольным Mac: сенсорный экран выдаёт планшет.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

// Куда попало «поделиться файлом»: 'shared' — системное меню открылось, 'cancelled' —
// пользователь закрыл его сам, 'unavailable' — клиент файл отдать не может (нет Web Share
// API или вызов отказал). На 'unavailable' вызывающий переходит к своему запасному пути —
// ссылке или скачиванию, поэтому решение остаётся за ним.
export type ReceiptFileTarget = 'shared' | 'cancelled' | 'unavailable'

// Отдаёт готовый PDF системному меню «Поделиться». Общий путь для карточки заказа и
// страницы чека: и там, и там файл уходит одним и тем же вызовом — и на iPhone, и на
// Android, где системные меню устроены одинаково с точки зрения веб-страницы.
export async function shareReceiptFile(file: File, text: string): Promise<ReceiptFileTarget> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return 'unavailable'
  try {
    await navigator.share({ files: [file], title: text, text })
    return 'shared'
  } catch (error) {
    // Отмена системного меню — не ошибка: пользователь закрыл окно выбора и может
    // повторить попытку. Остальные отказы лечит вызывающий.
    if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled'
    return 'unavailable'
  }
}

// Куда попало «поделиться ссылкой»: открылся выбор чата или системное меню, ссылка
// легла в буфер обмена или не вышло ничего. Интерфейс говорит об этом текстом —
// иначе нажатие выглядит как «ничего не произошло».
export type ReceiptLinkTarget = 'opened' | 'copied' | 'failed'

// Отправляет ссылку на чек. В Telegram выбор чата открывает сам клиент
// (`t.me/share/url`), в остальных браузерах — системное меню «Поделиться», а если
// и его нет, ссылка копируется: её можно вставить в сообщение вручную.
export async function shareReceiptLink(url: string, text: string): Promise<ReceiptLinkTarget> {
  if (insideTelegramWebView()) {
    const target = openExternalLink(telegramShareUrl(url, text))
    if (target !== 'failed') return 'opened'
  }

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: text, text, url })
      return 'opened'
    } catch (error) {
      // Отмена системного меню — не ошибка: пользователь закрыл окно выбора и может
      // попробовать снова. Остальные отказы (например, нет разрешения) лечим копией.
      if ((error as { name?: string } | null)?.name === 'AbortError') return 'opened'
    }
  }

  return (await copyReceiptLink(url, text)) ? 'copied' : 'failed'
}

// Копия ссылки на чек в буфер обмена. Нужна и как запасной путь в `shareReceiptLink`,
// и как отдельное действие: если выбор чата не открылся, ссылку вставляют в сообщение
// руками — иначе нажатие «Чек (PDF)» заканчивается ничем.
export function copyReceiptLink(url: string, text: string): Promise<boolean> {
  return copyTextToClipboard(`${text}\n${url}`)
}

// Копирование текста в буфер обмена: один и тот же путь для чека и для ссылки на
// файл отчёта (см. src/telegram/files.ts). Вне защищённого контекста и без прав
// буфер обмена недоступен — тогда возвращается false, и интерфейс говорит об этом.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
