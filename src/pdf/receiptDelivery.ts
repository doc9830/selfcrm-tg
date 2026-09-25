// Как отдать чек: файлом или ссылкой.
//
// Выбор зависит не от желания, а от возможностей окружения. Telegram Mini App не
// сохраняет файлы, созданные страницей: клиент игнорирует и blob-ссылки, и
// `<a download>`, а `WebApp.downloadFile` принимает только адреса `https:`. Поэтому
// там чек уходит ссылкой — её получатель открывает страницу чека в браузере и
// сохраняет PDF. В Android-сборке (Capacitor) работает системное меню «Поделиться»,
// в браузере — обычное скачивание файла.
//
// Само правило выбора — чистая функция: её проверяют тесты, а `documents.ts` только
// выполняет выбранный план.
//
// Telegram проверяется раньше Web Share API намеренно. В WebView на Android
// `navigator.share` и `navigator.canShare` объявлены и на пробный PDF отвечают «да»,
// но системного меню у WebView нет: промис не завершается, и нажатие «Чек (PDF)»
// выглядело как «ничего не произошло». Ссылку же открывает сам клиент Telegram
// (`t.me/share/url` → выбор чата), и этот путь работает и на Android, и на iOS.
import { insideTelegramWebView, openExternalLink } from '../telegram/webapp'
import { telegramShareUrl } from './receipt'

export interface ReceiptDeliveryEnv {
  // Приложение собрано для Android (Capacitor): файл можно записать на устройство.
  native: boolean
  // Клиент умеет делиться файлом (Web Share API с файлами). Спрашивать об этом имеет
  // смысл только вне Telegram: в мини-приложении на Android ответ «да» ничего не
  // значит — меню всё равно не открывается.
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
  return copyText(`${text}\n${url}`)
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
