// Страница чека по ссылке.
//
// Чек, отправленный ссылкой, открывается у получателя — обычно в браузере Telegram
// или Safari. Данные лежат в самом адресе (`#/receipt?d=…`), поэтому страница
// собирает документ сама: ни сервера, ни базы получателя для этого не нужно.
//
// Вид повторяет PDF-чек (`pdf/documents.ts`): те же строки в том же порядке, чтобы
// ссылка и файл читались одинаково.
//
// Кнопки — те же действия, что и в карточке заказа, но их набор зависит от того, что умеет
// клиент (см. `pdf/receiptDelivery.ts`):
//   • Android и настольные браузеры — «Скачать PDF», «Печать», «Поделиться»: загрузка файла
//     из страницы там работает;
//   • iPhone и iPad — одна кнопка «Поделиться»: файл оттуда уходит в системное меню, где
//     есть «Сохранить в файлы» и «Печать». Кнопки «Скачать PDF» там нет намеренно: файл она
//     не сохраняла, а открывала тот же чек заново (blob-ссылка с `<a download>` открывается
//     в просмотрщике PDF, а во встроенных браузерах остаётся без ответа) — признак
//     `isIosClient()`.
//
// Внутри WebView клиента Telegram страница файл отдать не может: клиент игнорирует и
// blob-ссылки, и `<a download>`, а `WebApp.downloadFile` принимает только адреса
// `https:`. Поэтому там кнопка «Скачать PDF» не сохраняет файл, а открывает эту же
// страницу в браузере (`WebApp.openLink` открывает внешний браузер) — с признаком
// `dl=1`, по которому страница скачивает PDF сразу, без лишнего нажатия. На iPhone этой
// кнопки нет, поэтому автоскачивание там пропускается (см. эффект `autoDownload`).
//
// Если браузер клиента загрузку отклоняет (так бывает во встроенном браузере), файл
// отдаёт кнопка «Поделиться»: `shareReceiptPdfFile()` кладёт PDF в системное меню, где
// есть «Сохранить в файлы».
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
import { canShareFiles, isIosClient, shareReceiptLink } from '../pdf/receiptDelivery'
import { go } from '../router'
import { insideTelegramWebView, openExternalLink } from '../telegram/webapp'
import { money } from '../utils/format'

// Что делать, когда браузер по кнопке не открылся (клиент отказал): подсказка называет
// путь, который есть в самом Telegram — команду встроенного браузера.
const TELEGRAM_SAVE_HINT =
  'В Telegram файл напрямую не сохраняется. Если браузер не открылся, скачайте чек из встроенного браузера: меню «…» → «Открыть в браузере».'
const TELEGRAM_OPEN_NOTE = 'Чек открывается в браузере — там PDF сохранится как обычный файл.'
// Подсказка для браузера, где загрузку видно, но файл может не дойти до «Файлов»
// (например, встроенный браузер клиента на Android): выручает системное меню, а печать —
// второй путь к тем же «Файлам».
const SAVE_HINT =
  'Если файл не сохранился, нажмите «Поделиться» — в системном меню есть «Сохранить в файлы». Второй путь: «Печать» → «Сохранить в файлы».'
// Подсказка для iPhone и iPad: там файл отдаёт только системное меню «Поделиться», и в нём
// же есть «Печать». Второе предложение — для тех, кто открыл чек внутри Telegram: системное
// меню там может не появиться, и тогда страницу открывают во встроенном браузере.
const IOS_HINT =
  'На iPhone и iPad файл сохраняется через «Поделиться» → «Сохранить в файлы» (в меню есть и «Печать»). Если меню не появляется, откройте чек в браузере: «…» → «Открыть в браузере».'

export function ReceiptView({ payload, autoDownload = false }: { payload: string | null; autoDownload?: boolean }) {
  const [data, setData] = useState<ReceiptData | null>(null)
  const [broken, setBroken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Внутри Telegram (мини-приложение или встроенный браузер) файл сохранить нечем, а
  // ссылки открывает клиент — от этого зависят и кнопки, и подсказка под ними.
  const telegram = insideTelegramWebView()
  // iPhone и iPad: файл из страницы не скачивается, поэтому там одно действие — «Поделиться».
  const ios = isIosClient()
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
        setNote(
          'Файл отправлен на сохранение. Если загрузка не началась, нажмите «Поделиться» и выберите «Сохранить в файлы».',
        )
      }
    })()
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось сохранить файл'))
      .finally(() => setBusy(false))
  }

  // Страницу открыли в браузере по кнопке «Скачать PDF» (`dl=1`): файл скачивается сразу.
  // На iPhone и iPad автоскачивания нет: файл забирает системное меню, а blob-ссылка открыла
  // бы тот же чек в просмотрщике — то есть ровно то, от чего страница ушла (см.
  // `isIosClient()`). Внутри WebView клиента ожидания тоже нет: там автоскачивание не
  // работает и не нужно.
  useEffect(() => {
    if (!autoDownload || telegram || ios || autoDone.current || !data) return
    autoDone.current = true
    savePdf()
  }, [autoDownload, telegram, ios, data])

  // «Скачать PDF» внутри Telegram: своей записи файла у страницы нет, поэтому открываем
  // эту же страницу в браузере — там PDF скачивается (о чём просит признак `dl=1`). Кнопка
  // есть только вне iPhone и iPad (`ios`): на iOS её место занимает «Поделиться».
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
      // Сначала файл: системное меню умеет «Сохранить в файлы» и на iPhone, и на Android —
      // это запасной путь, когда браузер загрузку отклоняет. PDF собирается только если
      // клиент действительно принимает файлы (`canShareFiles`), иначе pdfmake не грузим.
      if (canShareFiles()) {
        const { shareReceiptPdfFile } = await import('../pdf/documents')
        const file = await shareReceiptPdfFile(data)
        if (file === 'shared') {
          setNote('PDF готов — выберите, куда его сохранить или отправить.')
          return
        }
        if (file === 'cancelled') return
      }
      // Клиент файл не принимает: делимся ссылкой на этот же экран — адрес страницы и
      // есть ссылка на чек.
      const url = receiptUrl(await packReceipt(data))
      const target = await shareReceiptLink(url, receiptMessage(data))
      if (target === 'copied') setNote('Ссылка скопирована — вставьте её в сообщение.')
      else if (target === 'failed') setError('Не удалось поделиться — скопируйте адрес из строки браузера')
    })()
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось поделиться'))
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
          {/* «Скачать PDF» есть только там, где загрузка файла из страницы работает:
              Android и настольные браузеры. На iPhone и iPad её заменяет «Поделиться». */}
          {!ios &&
            (telegram ? (
              // Внутри WebView клиента файл записать нечем — кнопка открывает чек в браузере,
              // где PDF скачивается обычным образом (см. `downloadInBrowser`). Подпись та же,
              // что и в браузере: действие для пользователя одно, а шаг с браузером объясняет
              // подсказка под кнопкой.
              <Button variant="primary" icon="download" full disabled={busy} onClick={downloadInBrowser}>
                Скачать PDF
              </Button>
            ) : (
              <Button variant="primary" icon="download" full disabled={busy} onClick={savePdf}>
                {busy ? 'Подготовка…' : 'Скачать PDF'}
              </Button>
            ))}
          {!ios && (
            <Button variant="secondary" icon="print" full onClick={() => window.print()}>
              Печать
            </Button>
          )}
          {/* На iPhone и iPad это единственное действие, поэтому оно главное: в системном меню
              есть и «Сохранить в файлы», и «Печать». */}
          <Button variant={ios ? 'primary' : 'outline'} icon="share" full disabled={busy} onClick={share}>
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
        <div className="field-hint receipt-hint">{ios ? IOS_HINT : telegram ? TELEGRAM_SAVE_HINT : SAVE_HINT}</div>
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
