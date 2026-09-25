import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../types'
import { createCloudStorageMock, type CloudStorageMock } from '../telegram/cloudStorageMock'
import { applyBackup } from './backup'
import { buildBackupJson, describeCounts, parseBackup } from './backupFormat'
import {
  CLOUD_MANIFEST_KEY,
  CLOUD_PART_BYTES,
  CLOUD_PART_PREFIX,
  cloudBackupAvailability,
  readCloudBackup,
  readCloudBackupInfo,
  removeCloudBackup,
  saveCloudBackup,
  splitByBytes,
  utf8Bytes,
} from './cloudBackup'
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

// Окружение мини-приложения: Telegram с облаком (облачные функции доступны) и localStorage
// (в копию попадает загруженная пользователем база адресов, см. buildBackupJson).
function useCloud(mock: CloudStorageMock): Map<string, string> {
  const local = new Map<string, string>()
  vi.stubGlobal('window', {
    Telegram: {
      WebApp: {
        initData: 'query_id=1',
        platform: 'android',
        version: '7.5',
        CloudStorage: mock.api,
      },
    },
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => {
        local.set(key, value)
      },
      removeItem: (key: string) => {
        local.delete(key)
      },
    },
  })
  return local
}

// Копия, которая точно не помещается в одно значение CloudStorage: комментарий клиента
// весит больше, чем лимит части.
function bulkyClient(): Client {
  return makeClient({ comment: 'ы'.repeat(5000) })
}

function partKeysInCloud(mock: CloudStorageMock): string[] {
  return [...mock.values.keys()].filter((key) => key.startsWith(CLOUD_PART_PREFIX))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cloudBackup: сохранение копии в облако Telegram', () => {
  it('складывает копию частями и описывает её для интерфейса', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const db = new Database(new MemoryStore())
    db.saveClient(bulkyClient())

    const date = new Date('2026-09-25T12:30:00.000Z')
    const info = await saveCloudBackup(db, date)

    expect(info.fileName).toBe('SelfCRM_backup_2026-09-25_12-30.json')
    expect(info.createdAt).toBe('2026-09-25T12:30:00.000Z')
    expect(info.bytes).toBe(utf8Bytes(buildBackupJson(db, date)))
    expect(describeCounts(info.counts)).toContain('Клиентов: 1')

    // Копия разбита на части: каждая укладывается в лимит клиента 4096 символов.
    expect(info.parts).toBeGreaterThan(1)
    const chunks = Array.from({ length: info.parts }, (_, index) =>
      mock.values.get(`${CLOUD_PART_PREFIX}${index}`),
    )
    expect(chunks.every((chunk) => typeof chunk === 'string')).toBe(true)
    for (const chunk of chunks) {
      expect(chunk!.length).toBeLessThanOrEqual(4096)
      expect(utf8Bytes(chunk!)).toBeLessThanOrEqual(CLOUD_PART_BYTES)
    }

    // Склейка частей — ровно тот же файл копии, который скачивает кнопка «Создать».
    const json = chunks.join('')
    expect(json).toBe(buildBackupJson(db, date))
    expect(parseBackup(json).snapshotJson).toContain('Иван Петров')
    expect(mock.values.has(CLOUD_MANIFEST_KEY)).toBe(true)
  })

  it('вне Telegram облака нет: сохранение отвергается с подсказкой', async () => {
    vi.stubGlobal('window', {})

    expect(cloudBackupAvailability()).toBe('outside-telegram')
    await expect(saveCloudBackup(new Database(new MemoryStore()))).rejects.toThrow(
      'только в мини-приложении',
    )
  })
})

describe('cloudBackup: восстановление из облака на другом устройстве', () => {
  it('переносит данные CRM из облака в пустую базу', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const source = new Database(new MemoryStore())
    source.saveClient(makeClient())
    source.saveProduct({
      id: 'p1',
      name: 'Товар',
      sku: 'SKU-1',
      price: 100,
      cost: 60,
      stock: 10,
      minStock: 2,
      description: '',
    })
    await saveCloudBackup(source)

    // Другое устройство: своя (пустая) база, тот же аккаунт Telegram — то же облако.
    const target = new Database(new MemoryStore())
    const { info, parsed } = await readCloudBackup()
    applyBackup(target, parsed)

    expect(parsed.legacy).toBe(false)
    expect(info.counts.clients).toBe(1)
    expect(target.getClient('c1')?.name).toBe('Иван Петров')
    expect(target.getProduct('p1')).toMatchObject({ price: 100, stock: 10 })
  })

  it('метаданные копии читаются без самих данных', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const db = new Database(new MemoryStore())
    db.saveClient(makeClient())
    const saved = await saveCloudBackup(db)

    await expect(readCloudBackupInfo()).resolves.toMatchObject({
      fileName: saved.fileName,
      parts: saved.parts,
      counts: { clients: 1 },
    })
  })

  it('без копии в облаке говорит об этом прямо', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)

    await expect(readCloudBackupInfo()).resolves.toBeNull()
    await expect(readCloudBackup()).rejects.toThrow('нет резервной копии')
  })

  it('нехватка части копии — понятная ошибка, а не пустая база', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const db = new Database(new MemoryStore())
    db.saveClient(bulkyClient())
    const info = await saveCloudBackup(db)
    expect(info.parts).toBeGreaterThan(1)
    mock.values.delete(`${CLOUD_PART_PREFIX}${info.parts - 1}`)

    await expect(readCloudBackup()).rejects.toThrow('повреждена')
  })

  it('повторное сохранение заменяет части прежней копии', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const source = new Database(new MemoryStore())
    source.saveClient(bulkyClient())
    const first = await saveCloudBackup(source)
    expect(first.parts).toBeGreaterThan(1)

    const second = await saveCloudBackup(new Database(new MemoryStore()))

    expect(second.parts).toBe(1)
    expect(partKeysInCloud(mock)).toEqual([`${CLOUD_PART_PREFIX}0`])
    // Читается только новая копия: данных прежней в облаке не осталось.
    const { parsed } = await readCloudBackup()
    expect((JSON.parse(parsed.snapshotJson) as { clients: unknown[] }).clients).toHaveLength(0)
  })

  it('удаление убирает только копию SelfCRM', async () => {
    const mock = createCloudStorageMock()
    useCloud(mock)
    const db = new Database(new MemoryStore())
    db.saveClient(bulkyClient())
    await saveCloudBackup(db)
    // В облаке аккаунта есть ключи других мини-приложений — их трогать нельзя.
    mock.values.set('other-app:key', 'чужие данные')

    await removeCloudBackup()

    await expect(readCloudBackupInfo()).resolves.toBeNull()
    expect([...mock.values.keys()]).toEqual(['other-app:key'])
  })
})

describe('cloudBackup: разбиение копии на части', () => {
  it('режет по байтам и склеивается обратно без потерь', () => {
    const text = 'Клиент №1 😀 ул. Тверская, д. 1'.repeat(20)

    const parts = splitByBytes(text, 50)

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(text)
    for (const part of parts) expect(utf8Bytes(part)).toBeLessThanOrEqual(50)
  })

  it('ASCII режется ровно по размеру', () => {
    expect(splitByBytes('abcdefgh', 4)).toEqual(['abcd', 'efgh'])
  })

  it('пустой текст — пустой список частей', () => {
    expect(splitByBytes('', 100)).toEqual([])
  })

  it('слишком маленький размер части — ошибка', () => {
    expect(() => splitByBytes('текст', 2)).toThrow('слишком мал')
  })

  it('utf8Bytes считает байты, а не символы', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('аб')).toBe(4)
    expect(utf8Bytes('😀')).toBe(4)
  })
})
