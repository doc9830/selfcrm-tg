import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramWebApp } from '../telegram/webapp'
import { APP_VERSION } from '../version'
import type { Client } from '../types'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  backupFileName,
  buildBackupJson,
  describeBackup,
  parseBackup,
} from './backupFormat'
import { Database } from './database'
import { MemoryStore } from './kvstore'

function makeClient(partial: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Иван Петров',
    phone: '',
    email: '',
    comment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

function setupWithClient() {
  const db = new Database(new MemoryStore())
  db.saveClient(makeClient())
  return db
}

// Telegram-окружение подменяем объектом, который создаёт сам клиент Telegram:
// initDataUnsafe появляется только внутри Telegram. Тесты идут в node-окружении,
// поэтому window подставляем через vi.stubGlobal.
function useTelegram(user: { id: number; first_name?: string; last_name?: string }) {
  vi.stubGlobal('window', {
    Telegram: {
      WebApp: {
        initData: 'user=%7B%22id%22%3A42%7D',
        initDataUnsafe: { user },
        platform: 'android',
      } as unknown as TelegramWebApp,
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backupFormat: формат файла резервной копии', () => {
  it('заворачивает снимок базы в конверт с форматом, версией и датой', () => {
    const db = setupWithClient()
    const file = JSON.parse(buildBackupJson(db, new Date('2026-02-03T04:05:06.000Z')))

    expect(file.format).toBe(BACKUP_FORMAT)
    expect(file.version).toBe(BACKUP_FORMAT_VERSION)
    expect(file.createdAt).toBe('2026-02-03T04:05:06.000Z')
    expect(file.app.version).toBe(APP_VERSION)
    expect(file.data.clients).toHaveLength(1)
    expect(file.data.clients[0].name).toBe('Иван Петров')
    // Ключи снимка продублированы в корне: такой файл читает и Android-версия SelfCRM.
    expect(file.clients).toHaveLength(1)
    expect(file.orders).toEqual([])
  })

  it('восстанавливает из конверта все данные', () => {
    const parsed = parseBackup(buildBackupJson(setupWithClient()))
    const target = new Database(new MemoryStore())
    target.importData(parsed.snapshotJson)

    expect(parsed.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(target.getClient('c1')?.name).toBe('Иван Петров')
  })

  it('понимает копию старого образца — файл Android-версии SelfCRM', () => {
    const legacy = setupWithClient().exportData()
    const parsed = parseBackup(legacy)
    const target = new Database(new MemoryStore())
    target.importData(parsed.snapshotJson)

    expect(parsed.formatVersion).toBeNull()
    expect(parsed.app).toBeNull()
    expect(target.getClients()).toHaveLength(1)
  })

  it('отказывается читать копию более новой версии формата', () => {
    const json = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION + 1,
      data: { clients: [], orders: [] },
    })
    expect(() => parseBackup(json)).toThrow(/более новой версией/)
  })

  it('сообщает понятную ошибку на постороннем файле', () => {
    expect(() => parseBackup('не json')).toThrow('Файл резервной копии не читается')
    expect(() => parseBackup('{"hello": 1}')).toThrow('Некорректный файл резервной копии')
  })

  it('подписывает копию Telegram-пользователем, не делая его ключом данных', () => {
    useTelegram({ id: 42, first_name: 'Иван', last_name: 'Петров' })
    const db = new Database(new MemoryStore())
    db.saveClient(makeClient({ id: 'client-1', name: 'Клиент' }))

    const parsed = parseBackup(buildBackupJson(db, new Date('2026-02-03T04:05:06.000Z')))
    expect(parsed.app?.platform).toBe('telegram')
    expect(parsed.app?.telegramUser).toEqual({ id: 42, label: 'Иван Петров' })

    const target = new Database(new MemoryStore())
    target.importData(parsed.snapshotJson)
    expect(target.getClient('client-1')?.name).toBe('Клиент')

    const text = describeBackup(parsed)
    expect(text).toContain('Telegram')
    expect(text).toContain('Иван Петров')
  })

  it('формирует имя файла копии с датой и временем', () => {
    expect(backupFileName(new Date('2026-02-03T04:05:06.000Z'))).toBe(
      'selfcrm-backup-2026-02-03-04-05-06.json',
    )
  })
})
