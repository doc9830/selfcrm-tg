import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client, Contractor, Product } from '../types'
import { APP_VERSION } from '../version'
import { demoAddresses } from './addresses'
import { applyBackup, hasLocalData, restoreBackup } from './backup'
import { BACKUP_FORMAT, buildBackupJson, parseBackup } from './backupFormat'
import { Database } from './database'
import { MemoryStore } from './kvstore'

function makeClient(partial: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Иван Петров',
    phone: '+7 900 000-00-00',
    email: 'ivan@example.com',
    comment: 'Постоянный клиент',
    address: 'г. Москва, ул. Тверская, д. 1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

function makeProduct(partial: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Товар',
    sku: 'SKU-1',
    price: 100,
    cost: 60,
    stock: 10,
    minStock: 2,
    description: '',
    ...partial,
  }
}

// Подменяет localStorage (хранилище базы адресов): так проверяется перенос
// пользовательской базы адресов между устройствами.
function useLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
      },
      removeItem: (key: string) => {
        map.delete(key)
      },
    },
  })
  return map
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backup: «создать данные → копия → восстановить»', () => {
  it('переносит клиентов, товары, заказы, напоминания, склад и реквизиты', () => {
    const source = new Database(new MemoryStore())
    source.saveClient(makeClient())
    source.saveProduct(makeProduct())

    const order = source.createOrderDraft('c1')
    order.items = [{ productId: 'p1', name: 'Товар', price: 100, qty: 2 }]
    source.saveOrder(order)
    source.addReminder(order.id, {
      kind: 'payment',
      text: 'Напомнить об оплате',
      dueAt: '2026-10-01T10:00:00.000Z',
    })
    source.applyStockMove({ productId: 'p1', kind: 'in', value: 5, comment: 'Накладная №7' })
    const contractor: Contractor = {
      name: 'ИП Иванов',
      inn: '770000000000',
      ogrn: '',
      kpp: '',
      phone: '',
      email: '',
      address: '',
    }
    source.updateSettings({ contractor })

    const json = buildBackupJson(source, new Date('2026-09-25T12:00:00.000Z'))
    // Файл остаётся читаемым JSON: конверт с метаданными и данные CRM.
    const file = JSON.parse(json) as Record<string, unknown>
    expect(file.format).toBe(BACKUP_FORMAT)
    expect(file.createdAt).toBe('2026-09-25T12:00:00.000Z')
    // Версия берётся из приложения, а не из строки в тесте: иначе подъём версии
    // в проекте требовал бы правки теста.
    expect(file.appVersion).toBe(APP_VERSION)

    // Другое устройство: та же копия в пустой базе.
    const target = new Database(new MemoryStore())
    const parsed = restoreBackup(target, json)

    expect(parsed.legacy).toBe(false)
    expect(parsed.formatVersion).toBe(1)
    expect(target.getClient('c1')?.name).toBe('Иван Петров')
    expect(target.getClient('c1')?.address).toBe('г. Москва, ул. Тверская, д. 1')
    expect(target.getProduct('p1')).toMatchObject({ price: 100, cost: 60, stock: 13 })
    expect(target.getSettings().contractor?.name).toBe('ИП Иванов')

    const [restored] = target.getOrders()
    expect(restored.number).toBe(order.number)
    expect(restored.items).toHaveLength(1)
    expect(target.getOrderReminders(restored.id)).toHaveLength(1)
    expect(target.getStockMoves('p1')).toHaveLength(2)
  })

  it('восстанавливает загруженную пользователем базу адресов', () => {
    const storage = useLocalStorage()
    storage.set(
      'selfcrm:addresses',
      JSON.stringify([
        {
          id: 'a1',
          cadastralNumber: '77:01:0001001:101',
          address: 'г. Москва, ул. Тверская, д. 1',
          lat: 55.7617,
          lng: 37.6106,
        },
      ]),
    )

    const source = new Database(new MemoryStore())
    source.saveClient(makeClient())
    const json = buildBackupJson(source)
    expect(parseBackup(json).addresses).toHaveLength(1)

    // На другом устройстве своей базы адресов нет — восстановление её создаёт.
    storage.delete('selfcrm:addresses')
    const target = new Database(new MemoryStore())
    applyBackup(target, parseBackup(json))

    const restored = JSON.parse(storage.get('selfcrm:addresses') ?? '[]') as unknown[]
    expect(restored).toHaveLength(1)
  })

  it('без своей базы адресов демо-набор в копию не попадает', () => {
    useLocalStorage()
    const db = new Database(new MemoryStore())
    db.saveClient(makeClient())

    const json = buildBackupJson(db)

    expect((JSON.parse(json) as { data: Record<string, unknown> }).data.addresses).toBeUndefined()
    // Демо-записи (у них есть кадастровые номера) в файл не попадают.
    expect(json).not.toContain(demoAddresses[0].cadastralNumber)
  })

  it('сообщает, есть ли данные, которые заменит восстановление', () => {
    const db = new Database(new MemoryStore())
    expect(hasLocalData(db)).toBe(false)

    db.saveClient(makeClient())
    expect(hasLocalData(db)).toBe(true)
  })
})

describe('backup: повреждённый файл не трогает данные', () => {
  function dbWithClient() {
    const db = new Database(new MemoryStore())
    db.saveClient(makeClient())
    return db
  }

  it('обычный текст и чужой JSON оставляют базу на месте', () => {
    const db = dbWithClient()

    expect(() => restoreBackup(db, 'это обычный текст')).toThrow('не читается')
    expect(() => restoreBackup(db, '{"hello": 1}')).toThrow('нет данных CRM')
    expect(() => restoreBackup(db, '{"format": "other-crm", "version": 1}')).toThrow(
      'не файл резервной копии SelfCRM',
    )
    expect(() =>
      restoreBackup(db, JSON.stringify({ format: BACKUP_FORMAT, version: 99, data: {} })),
    ).toThrow('более новой версией')
    expect(() =>
      restoreBackup(
        db,
        JSON.stringify({ format: BACKUP_FORMAT, version: 1, data: { orders: [] } }),
      ),
    ).toThrow('нет списка клиентов')

    expect(db.getClients()).toHaveLength(1)
    expect(db.hasPreImportBackup()).toBe(false)
  })

  it('снимок старого образца (Android-версия) восстанавливается как обычная копия', () => {
    const source = dbWithClient()
    const legacy = source.exportData()

    const target = new Database(new MemoryStore())
    const parsed = restoreBackup(target, legacy)

    expect(parsed.legacy).toBe(true)
    expect(parsed.addresses).toBeNull()
    expect(target.getClients()).toHaveLength(1)
  })

  it('BOM и пробелы по краям разбору не мешают', () => {
    // Файл копии проходит через чат, почту и редакторы: там и появляется BOM.
    const source = dbWithClient()
    const target = new Database(new MemoryStore())

    expect(restoreBackup(target, `\uFEFF\n  ${buildBackupJson(source)}\n`).legacy).toBe(false)
    expect(target.getClients()).toHaveLength(1)
  })

  it('копия Android-версии с BOM тоже принимается', () => {
    const source = dbWithClient()
    const target = new Database(new MemoryStore())

    const parsed = restoreBackup(target, `\uFEFF${source.exportData()}\r\n`)

    expect(parsed.legacy).toBe(true)
    expect(target.getClients()).toHaveLength(1)
  })
})
