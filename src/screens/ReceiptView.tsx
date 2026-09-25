// Страница чека по ссылке.
//
// Чек, отправленный ссылкой, открывается у получателя — обычно в браузере Telegram
// или Safari. Данные лежат в самом адресе (`#/receipt?d=…`), поэтому страница
// собирает документ сама: ни сервера, ни базы получателя для этого не нужно.
//
// Вид повторяет PDF-чек (`pdf/documents.ts`): те же строки в том же порядке, чтобы
// ссылка и файл читались одинаково. Кнопки — те же действия, что и в карточке заказа:
// получить файл, напечатать (на iPhone печать сохраняет PDF в «Файлы») и поделиться.
//
// Внутри Telegram страница файл отдать не может: клиент игнорирует и blob-ссылки, и
// `<a download>`, а `WebApp.downloadFile` принимает только адреса `https:`. Поэтому там
// кнопка «Скачать PDF» не сохраняет файл, а открывает эту же страницу в браузере
// (`WebApp.openLink` открывает внешний браузер) — с признаком `dl=1`, по которому
// страница скачивает PDF сразу, без лишнего нажатия.
//
// pdfmake вместе с PDF-модулем подгружается по нажатию (`import()`): он весит больше
// мегабайта, а получатель ссылки открывает страницу ради самого чека.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icons'
import { Button, EmptyState } from '../components/ui'
import {
  packReceipt,
  receiptDownloadUrl,
  receiptHeading,
  receiptMessage,
  receiptTotal,
  receiptUrl,
  unpackReceipt,
  type ReceiptData,
} from '../pdf/receipt'
import { shareReceiptLink } from '../pdf/receiptDelivery'
import { go } from '../router'
import { insideTelegramWebView, openExternalLink } from '../telegram/webapp'
import { money } from '../utils/format'

// Что делать, когда браузер по кнопке не открылся (клиент отказал): подсказка называет
// путь, который есть в самом Telegram — команду встроенного браузера.
const TELEGRAM_SAVE_HINT =
  'В Telegram файл напрямую не сохраняется. Если браузер не открылся, скачайте чек из встроенного браузера: меню «…» → «Открыть в браузере».'
const TELEGRAM_OPEN_NOTE = 'Чек открывается в браузере — там PDF сохранится как обычный файл.'
const BROWSER_SAVE_HINT =
  'Если файл не сохраняется, нажмите «Печать» и выберите «Сохранить в файлы».'

export function ReceiptView({ payload, autoDownload = false }: { payload: string | null; autoDownload?: boolean }) {
  const [data, setData] = useState<ReceiptData | null>(null)
  const [broken, setBroken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Внутри Telegram (мини-приложение или встроенный браузер) файл сохранить нечем, а
  // ссылки открывает клиент — от этого зависят и кнопки, и подсказка под ними.
  const telegram = insideTelegramWebView()
  // Автоскачивание при `dl=1` выполняется один раз: смена состояния не должна запускать
  // повторную загрузку файла.
  const autoDone = useRef(false)

  useEffect(() => {
    setData(null)
    setBroken(false)
    setError('')
    setNote('')
    if (!payload) {
      setBroken(true)
      return
    }

    // Асинхронная распаковка может завершиться уже после перехода на другой экран:
    // тогда её результат не нужен (и setState по размонтированному экрану лишний).
    let active = true
    void unpackReceipt(payload).then((parsed) => {
      if (!active) return
      if (parsed) setData(parsed)
      else setBroken(true)
    })
    return () => {
      active = false
    }
  }, [payload])

  const savePdf = () => {
    if (!data) return
    setBusy(true)
    setError('')
    setNote('')
    void (async () => {
      const { saveReceiptPdf } = await import('../pdf/documents')
      const result = await saveReceiptPdf(data)
      if (result === 'native') {
        setNote('PDF готов — выберите «Сохранить в файлы» в системном меню.')
      } else if (result === 'unsupported') {
        // Из интерфейса сюда не попасть: кнопки внутри Telegram ведут в браузер. Ответ
        // оставлен честным на случай, если окружение распознали иначе.
        setNote(TELEGRAM_SAVE_HINT)
      } else {
        setNote('Файл отправлен на сохранение. Если загрузка не началась, нажмите «Печать» и сохраните PDF.')
      }
    })()
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось сохранить файл'))
      .finally(() => setBusy(false))
  }

  // Страницу открыли в браузере по кнопке «Скачать PDF» (`dl=1`): файл скачивается сразу.
  // Кнопка «Сохранить PDF» остаётся — если браузер такую загрузку отклонил, файл просят
  // нажатием. Внутри Telegram ожидания нет: там автоскачивание не работает и не нужно.
  useEffect(() => {
    if (!autoDownload || telegram || autoDone.current || !data) return
    autoDone.current = true
    savePdf()
  }, [autoDownload, telegram, data])

  // «Скачать PDF» внутри Telegram: своей записи файла у страницы нет, поэтому открываем
  // эту же страницу в браузере — там PDF скачивается (о чём просит признак `dl=1`).
  const downloadInBrowser = () => {
    if (!payload) return
    setError('')
    setNote('')
    const target = openExternalLink(receiptDownloadUrl(receiptUrl(payload)))
    if (target === 'failed') setError(TELEGRAM_SAVE_HINT)
    else setNote(TELEGRAM_OPEN_NOTE)
  }

  const share = () => {
    if (!data) return
    setBusy(true)
    setError('')
    setNote('')
    void (async () => {
      // Ссылка на этот же экран: адрес страницы и есть ссылка на чек.
      const url = receiptUrl(await packReceipt(data))
      const target = await shareReceiptLink(url, receiptMessage(data))
      if (target === 'copied') setNote('Ссылка скопирована — вставьте её в сообщение.')
      else if (target === 'failed') setError('Не удалось поделиться — скопируйте адрес из строки браузера')
    })()
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось поделиться ссылкой'))
      .finally(() => setBusy(false))
  }

  if (broken) {
    return (
      <Shell>
        <EmptyState
          icon="receipt"
          title="Ссылка не читается"
          description="Чек передаётся прямо в ссылке, поэтому она могла обрезаться при пересылке. Попросите отправителя поделиться чеком ещё раз."
          action={<Button onClick={() => go('/')}>Открыть SelfCRM</Button>}
        />
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell>
        <div className="empty">
          <div className="empty-title">Открываем чек…</div>
        </div>
      </Shell>
    )
  }

  const contractor = data.contractor
  const props = [
    contractor.inn && `ИНН ${contractor.inn}`,
    contractor.ogrn && `ОГРН ${contractor.ogrn}`,
    contractor.kpp && `КПП ${contractor.kpp}`,
    contractor.address,
    contractor.phone && `Тел. ${contractor.phone}`,
    contractor.email,
  ].filter(Boolean) as string[]

  return (
    <Shell>
      <div className="receipt">
        <div className="receipt-paper">
          {contractor.name && <div className="receipt-company">{contractor.name}</div>}
          {props.length > 0 && <div className="receipt-company-props">{props.join(' · ')}</div>}
          <div className="receipt-title">{receiptHeading(data)}</div>
          <div className="receipt-subtitle">ЧЕК</div>
          <div className="receipt-meta">Заказчик: {data.clientName || '—'}</div>
          {data.clientPhone && <div className="receipt-meta">Телефон: {data.clientPhone}</div>}
          {data.clientAddress && <div className="receipt-meta">Адрес: {data.clientAddress}</div>}

          <table className="receipt-table">
            <thead>
              <tr>
                <th>№</th>
                <th>Наименование</th>
                <th>Кол-во</th>
                <th className="receipt-num">Цена</th>
                <th className="receipt-num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, index) => (
                <tr key={`${index}-${item.name}`}>
                  <td>{index + 1}</td>
                  <td>{item.name}</td>
                  <td>{item.qty}</td>
                  <td className="receipt-num">{money(item.price)}</td>
                  <td className="receipt-num">{money(item.price * item.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="receipt-total">Итого: {money(receiptTotal(data))}</div>
          {data.paid > 0 && <div className="receipt-meta receipt-right">Оплачено: {money(data.paid)}</div>}
          {data.paid > 0 && data.remaining > 0 && (
            <div className="receipt-meta receipt-right">К оплате: {money(data.remaining)}</div>
          )}
          <div className="receipt-thanks">Спасибо за покупку!</div>
        </div>

        <div className="receipt-actions">
          {telegram ? (
            // Внутри Telegram файл записать нечем — кнопка открывает чек в браузере, где
            // PDF скачивается обычным образом (см. `downloadInBrowser`).
            <Button variant="primary" icon="download" full disabled={busy} onClick={downloadInBrowser}>
              Скачать PDF в браузере
            </Button>
          ) : (
            <Button variant="primary" icon="download" full disabled={busy} onClick={savePdf}>
              {busy ? 'Подготовка…' : 'Сохранить PDF'}
            </Button>
          )}
          <Button variant="secondary" icon="print" full onClick={() => window.print()}>
            Печать
          </Button>
          <Button variant="outline" icon="share" full disabled={busy} onClick={share}>
            Поделиться
          </Button>
        </div>

        {error && (
          <div className="field-error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
        {note && (
          <div className="field-hint" style={{ marginTop: 8 }}>
            {note}
          </div>
        )}
        <div className="field-hint receipt-hint">{telegram ? TELEGRAM_SAVE_HINT : BROWSER_SAVE_HINT}</div>
      </div>
    </Shell>
  )
}

// Оболочка страницы чека: та же шапка, что у приложения, но без нижнего меню и
// значков разделов — чек открывают и получатели ссылки, а не только владелец CRM.
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <span className="app-logo">SelfCRM</span>
        </div>
        <div className="app-header-title">Чек</div>
        <div className="app-header-actions">
          <Icon name="doc" size={20} />
        </div>
      </header>
      <main className="app-main receipt-main">{children}</main>
    </div>
  )
}
