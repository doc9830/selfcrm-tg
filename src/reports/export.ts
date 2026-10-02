// Точка входа выгрузки отчёта: собрать файл и отдать его пользователю.
//
// Модуль подгружается по нажатию кнопки: сборка `.xlsx` нужна только в этот момент, а экран
// статистики открывают и без выгрузки. Поэтому здесь же собраны все три шага — данные, файл
// и доставка — чтобы экран знал об одной точке входа на одну кнопку («Экспорт в xlsx»).
// Куда именно уходит файл, решает общая выгрузка (см. src/reports/delivery.ts): в
// мини-приложении Telegram — страница «Поделиться» в браузере телефона.
import type { Client, Order } from '../types'
import type { PeriodKey } from '../utils/stats'
import { deliverReportFile, type ReportDeliveryResult } from './delivery'
import { buildReportData, reportMessage, reportPeriod, type ReportPeriod } from './report'
import { reportFileName, reportXlsxBlob } from './xlsx'

export interface ReportExportInput {
  orders: Order[]
  // Все клиенты, включая архивных: по ним отчёт подписывает строки.
  clients: Client[]
  period: PeriodKey
  custom: { from?: string; to?: string }
}

export interface ReportExportResult {
  fileName: string
  period: ReportPeriod
  delivery: ReportDeliveryResult
}

// Данные за период плюс собранный файл: общий шаг обеих кнопок. Период приходит тем же
// ключом, что выбран на экране статистики, поэтому выгружается ровно то, что видно на экране.
async function buildReportFile(input: ReportExportInput) {
  const period = reportPeriod(input.period, input.custom)
  const data = buildReportData({ orders: input.orders, clients: input.clients, period })
  const fileName = reportFileName(period)
  const blob = await reportXlsxBlob(data)
  return { period, fileName, blob, message: reportMessage(data) }
}

// «Экспорт в xlsx»: файл пользователь сохраняет или отправляет сам — куда именно его отдаёт
// приложение, решает общая выгрузка (в мини-приложении Telegram это страница «Поделиться»).
export async function exportReport(input: ReportExportInput): Promise<ReportExportResult> {
  const { period, fileName, blob, message } = await buildReportFile(input)
  const delivery = await deliverReportFile({ blob, fileName, message })
  return { fileName, period, delivery }
}
