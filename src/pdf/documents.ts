// Генерация документов. Реализован чек (квитанция) по завершённому заказу.
// В основе — pdfmake: работает офлайн, встроенный шрифт Roboto поддерживает кириллицу.
//
// Чек отдаётся файлом или ссылкой — что доступно в этом клиенте, решает
// `planReceiptDelivery` (pdf/receiptDelivery.ts). Сам документ собирается по данным
// чека (pdf/receipt.ts), поэтому PDF по ссылке не отличается от файла. Точки входа:
// `shareOrderReceipt()` — кнопка «Чек (PDF)» в карточке заказа, `saveReceiptPdf()` —
// кнопка «Скачать PDF» на странице чека, `shareReceiptPdfFile()` — её же кнопка
// «Поделиться» (файлом, а не ссылкой, когда клиент умеет отдавать файлы).
// Пути одинаковы для iPhone и Android: они зависят от возможностей клиента, а не от
// названия системы.

import pdfMake from 'pdfmake/build/pdfmake'
import vfs from 'pdfmake/build/vfs_fonts'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { insideTelegramWebView } from '../telegram/webapp'
import {
  packReceipt,
  receiptData,
  receiptFileName,
  receiptHeading,
  receiptLinkTooLong,
  receiptMessage,
  receiptTotal,
  receiptUrl,
  telegramShareUrl,
  type ReceiptData,
  type ReceiptInput,
} from './receipt'
import { canShareFiles, planReceiptDelivery, shareReceiptFile, type ReceiptFileTarget } from './receiptDelivery'

// В pdfmake 0.3.x шрифт Roboto (с кириллицей) подключается через виртуальную ФС.
pdfMake.addVirtualFileSystem(vfs)

// Готовый data-URL документа: нужен, чтобы записать PDF в файл на устройстве.
async function getPdfDataUrl(docDefinition: unknown): Promise<string> {
  return pdfMake.createPdf(docDefinition).getDataUrl()
}

// Сумма без знака валюты (символ «₽» может отсутствовать во встроенном шрифте),
// используем «руб.».
function pdfMoney(value: number): string {
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)
  return `${formatted} руб.`
}

// Описание PDF-чека для pdfmake: одно и то же для файла и для страницы по ссылке.
export function receiptDocDefinition(data: ReceiptData): unknown {
  const contractor = data.contractor
  const total = receiptTotal(data)

  const header: Array<Record<string, unknown>> = []
  if (contractor.name.trim()) {
    header.push({ text: contractor.name.trim(), style: 'company' })
  }
  const props: string[] = []
  if (contractor.inn.trim()) props.push(`ИНН ${contractor.inn.trim()}`)
  if (contractor.ogrn.trim()) props.push(`ОГРН ${contractor.ogrn.trim()}`)
  if (contractor.kpp.trim()) props.push(`КПП ${contractor.kpp.trim()}`)
  if (contractor.address.trim()) props.push(contractor.address.trim())
  if (contractor.phone.trim()) props.push(`Тел. ${contractor.phone.trim()}`)
  if (contractor.email.trim()) props.push(contractor.email.trim())
  if (props.length) {
    header.push({ text: props.join(' · '), style: 'companyProps' })
  }

  const clientLines: Array<Record<string, unknown>> = [
    { text: `Заказчик: ${data.clientName || '—'}` },
  ]
  if (data.clientPhone) clientLines.push({ text: `Телефон: ${data.clientPhone}` })
  if (data.clientAddress) clientLines.push({ text: `Адрес: ${data.clientAddress}` })

  const tableHeader = ['№', 'Наименование', 'Кол-во', 'Цена', 'Сумма'].map((t) => ({
    text: t,
    bold: true,
  }))

  const tableBody: unknown[][] = [
    tableHeader,
    ...data.items.map((item, i) => [
      String(i + 1),
      item.name,
      String(item.qty),
      pdfMoney(item.price),
      pdfMoney(item.price * item.qty),
    ]),
  ]

  const content: unknown[] = [
    ...header,
    // Номер и дата заказа — в шапке чека: по ним заказ находят в переписке.
    { text: receiptHeading(data), alignment: 'center', style: 'title', margin: [0, 10, 0, 2] },
    { text: 'ЧЕК', alignment: 'center', style: 'subtitle', margin: [0, 0, 0, 4] },
    ...clientLines.map((line) => ({ ...line, margin: [0, 4, 0, 0], style: 'meta' })),
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 270, y2: 0, lineWidth: 1, lineColor: '#cccccc' }],
      margin: [0, 10, 0, 10],
    },
    {
      table: {
        headerRows: 1,
        widths: ['auto', '*', 'auto', 'auto', 'auto'],
        body: tableBody,
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0,
        hLineColor: () => '#e5e5e5',
        paddingLeft: () => 2,
        paddingRight: () => 2,
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
    },
    {
      text: `Итого: ${pdfMoney(total)}`,
      style: 'total',
      alignment: 'right',
      margin: [0, 10, 0, 0],
    },
    // Оплата показывается только по заказам, где что-то уже внесено.
    ...(data.paid > 0
      ? [
          {
            text: `Оплачено: ${pdfMoney(data.paid)}`,
            alignment: 'right',
            style: 'meta',
            margin: [0, 2, 0, 0],
          },
          ...(data.remaining > 0
            ? [
                {
                  text: `К оплате: ${pdfMoney(data.remaining)}`,
                  alignment: 'right',
                  style: 'meta',
                  margin: [0, 1, 0, 0],
                },
              ]
            : []),
        ]
      : []),
    { text: 'Спасибо за покупку!', alignment: 'center', style: 'thanks', margin: [0, 14, 0, 0] },
  ]

  const docDefinition = {
    pageSize: 'A6' as const,
    pageMargins: [16, 16, 16, 16] as [number, number, number, number],
    content,
    defaultStyle: { font: 'Roboto', fontSize: 8, color: '#111827' },
    styles: {
      company: { fontSize: 10, bold: true },
      companyProps: { fontSize: 7.5, color: '#555555', margin: [0, 2, 0, 0] },
      title: { fontSize: 13, bold: true },
      subtitle: { fontSize: 9, color: '#666666' },
      meta: { fontSize: 8, color: '#333333' },
      total: { fontSize: 11, bold: true },
      thanks: { fontSize: 8, color: '#666666' },
    },
  }

  return docDefinition
}

// PDF-чек в виде файла: им делятся через системное меню «Поделиться», и его же
// скачивает браузер. Файл, а не blob: меню «Поделиться» принимает только файлы.
export async function receiptPdfFile(data: ReceiptData): Promise<File> {
  const blob = await pdfMake.createPdf(receiptDocDefinition(data)).getBlob()
  return new File([blob], receiptFileName(data), { type: 'application/pdf' })
}

// Отдаёт PDF чека системному меню «Поделиться». Один и тот же вызов для карточки заказа
// и для страницы чека — поэтому поведение не зависит от того, iPhone у пользователя или
// Android. Файл собирается только когда клиент умеет его принять (`canShareFiles`):
// иначе ответ 'unavailable', а вызывающий переходит к ссылке или к скачиванию.
export async function shareReceiptPdfFile(data: ReceiptData): Promise<ReceiptFileTarget> {
  if (!canShareFiles()) return 'unavailable'
  return shareReceiptFile(await receiptPdfFile(data), receiptMessage(data))
}

// Обычное скачивание файла. Работает в браузере; в WebView клиента Telegram (и в
// мини-приложении, и во встроенном браузере) клиент его игнорирует — там путь доставки
// выбирает `planReceiptDelivery`.
export async function downloadReceiptPdf(data: ReceiptData): Promise<void> {
  const blob = await pdfMake.createPdf(receiptDocDefinition(data)).getBlob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = receiptFileName(data)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// Что в итоге произошло с чеком. Интерфейс говорит об этом текстом: 'link' — ссылку
// нужно открыть (выбор чата), 'cancelled' — пользователь закрыл меню «Поделиться».
export type ReceiptDeliveryResult =
  | { kind: 'native' }
  | { kind: 'shared' }
  | { kind: 'downloaded' }
  | { kind: 'cancelled' }
  | { kind: 'link'; url: string; text: string; shareUrl: string }

// Отдаёт чек по завершённому заказу: файлом, ссылкой или системным меню — смотря что
// умеет клиент. Путь выбирается один раз здесь, поэтому экраны не знают про
// особенности WebView клиента Telegram и про системные меню.
export async function shareOrderReceipt(input: ReceiptInput): Promise<ReceiptDeliveryResult> {
  const data = receiptData(input)
  const plan = planReceiptDelivery({
    native: Capacitor.isNativePlatform(),
    canShareFiles: canShareFiles(),
    telegram: insideTelegramWebView(),
  })

  if (plan === 'native') {
    await writeAndShareReceiptFile(data)
    return { kind: 'native' }
  }

  if (plan === 'file-share') {
    const target = await shareReceiptPdfFile(data)
    if (target === 'shared') return { kind: 'shared' }
    if (target === 'cancelled') return { kind: 'cancelled' }
    // Клиент обещал поддержку файлов, но отдать не смог — например, системное меню
    // требует нажатия в том же такте, а PDF собирался асинхронно. Запасной путь —
    // скачивание: ему нажатие не нужно. В WebView клиента Telegram этот путь не
    // выполняется: `planReceiptDelivery` отправляет его сразу к ссылке.
    await downloadReceiptPdf(data)
    return { kind: 'downloaded' }
  }

  if (plan === 'link-share') return receiptLink(data)

  await downloadReceiptPdf(data)
  return { kind: 'downloaded' }
}

// Что произошло при сохранении файла на странице чека: 'native' — PDF записан и отдан
// системному меню, 'downloaded' — файл забирает браузер, 'unsupported' — клиент файлы
// не принимает (WebView Telegram игнорирует и blob-ссылки, и `<a download>`, а
// `WebApp.downloadFile` принимает только адреса `https:`).
export type ReceiptSaveResult = 'native' | 'downloaded' | 'unsupported'

// Сохраняет чек файлом там, где это возможно. Отдельная точка входа для страницы чека:
// кнопка «Скачать PDF» не делится ссылкой, а кладёт файл на устройство — и странице
// нужно знать, получилось ли. Внутри WebView клиента Telegram не получилось: страница
// чека там вместо этого открывает себя в браузере (см. `screens/ReceiptView.tsx`), а
// ответ 'unsupported' остаётся честным для любого другого вызова. Если браузер клиента
// загрузку отклоняет, ту же роль играет `shareReceiptPdfFile()`: системное меню отдаёт
// файл и на iPhone, и на Android.
export async function saveReceiptPdf(data: ReceiptData): Promise<ReceiptSaveResult> {
  if (Capacitor.isNativePlatform()) {
    await writeAndShareReceiptFile(data)
    return 'native'
  }
  if (insideTelegramWebView()) return 'unsupported'

  await downloadReceiptPdf(data)
  return 'downloaded'
}

// Запись PDF в сборке Capacitor (Android и iOS): файл во временном каталоге + системное
// меню «Поделиться», откуда его сохраняют в «Файлы» или отправляют в мессенджер.
async function writeAndShareReceiptFile(data: ReceiptData): Promise<void> {
  const file = await Filesystem.writeFile({
    path: receiptFileName(data),
    data: await getPdfDataUrl(receiptDocDefinition(data)),
    directory: Directory.Cache,
    recursive: true,
  })
  await Share.share({
    title: receiptHeading(data),
    text: receiptMessage(data),
    files: [file.uri],
  })
}

// Ссылка на чек: данные лежат в самом адресе, поэтому получатель открывает чек и
// сохраняет PDF у себя. Слишком длинный чек — понятная ошибка, а не обрезанная ссылка.
async function receiptLink(data: ReceiptData): Promise<ReceiptDeliveryResult> {
  const payload = await packReceipt(data)
  const url = receiptUrl(payload)
  const text = receiptMessage(data)
  if (receiptLinkTooLong(url, text)) {
    throw new Error('Чек слишком длинный для ссылки — удалите лишние позиции или сохраните файл')
  }
  return { kind: 'link', url, text, shareUrl: telegramShareUrl(url, text) }
}

