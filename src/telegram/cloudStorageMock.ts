// Поддельное облачное хранилище Telegram для тестов (src/telegram/cloudStorage.test.ts и
// src/db/cloudBackup.test.ts): повторяет поведение клиента — значения до 4096 символов,
// не больше 1024 ключей, CloudStorage только с Bot API 6.9, ответ приходит асинхронно
// в callback. В сборку приложения этот файл не попадает: его импортируют только тесты.

import type { TelegramCloudStorage } from './webapp'

// Лимиты клиента Telegram, из-за которых копия в облаке режется на части.
export const MOCK_VALUE_LIMIT = 4096
export const MOCK_KEY_LIMIT = 1024

export interface CloudStorageMockOptions {
  // Версия клиента: ниже 6.9 методы выбрасывают WebAppMethodUnsupported, как настоящий клиент.
  version?: string
  valueLimit?: number
  keyLimit?: number
}

export interface CloudStorageMock {
  api: TelegramCloudStorage
  // Что «лежит в облаке»: ключи и значения.
  values: Map<string, string>
  // Сколько запросов получил клиент: по счётчикам видно, что лишних обращений нет.
  calls: { saved: number; removed: number; read: number; listed: number }
}

export function createCloudStorageMock(options: CloudStorageMockOptions = {}): CloudStorageMock {
  const version = options.version ?? '7.0'
  const valueLimit = options.valueLimit ?? MOCK_VALUE_LIMIT
  const keyLimit = options.keyLimit ?? MOCK_KEY_LIMIT
  const values = new Map<string, string>()
  const calls = { saved: 0, removed: 0, read: 0, listed: 0 }

  const checkVersion = () => {
    if (!versionAtLeast(version, '6.9')) throw Error('WebAppMethodUnsupported')
  }

  // Ответ приходит отдельной задачей, как из нативного клиента: код приложения обязан
  // ждать промис, а не рассчитывать на синхронный результат.
  const respond = <T>(
    callback: ((error: string | null, result?: T) => void) | undefined,
    error: string | null,
    result?: T,
  ) => {
    if (!callback) return
    Promise.resolve().then(() => callback(error, result))
  }

  const api = {} as TelegramCloudStorage

  api.setItem = (key, value, callback) => {
    checkVersion()
    if (value.length > valueLimit) {
      respond(callback, 'VALUE_TOO_LONG')
    } else if (!values.has(key) && values.size >= keyLimit) {
      respond(callback, 'STORAGE_LIMIT_EXCEEDED')
    } else {
      values.set(key, value)
      calls.saved += 1
      respond(callback, null, true)
    }
    return api
  }

  api.getItem = (key, callback) => {
    checkVersion()
    calls.read += 1
    respond(callback, null, values.get(key))
    return api
  }

  api.getItems = (keys, callback) => {
    checkVersion()
    calls.read += 1
    const found: Record<string, string> = {}
    for (const key of keys) {
      const value = values.get(key)
      if (value !== undefined) found[key] = value
    }
    respond(callback, null, found)
    return api
  }

  api.removeItem = (key, callback) => api.removeItems([key], callback)

  api.removeItems = (keys, callback) => {
    checkVersion()
    for (const key of keys) values.delete(key)
    calls.removed += 1
    respond(callback, null, true)
    return api
  }

  api.getKeys = (callback) => {
    checkVersion()
    calls.listed += 1
    respond(callback, null, [...values.keys()])
    return api
  }

  return { api, values, calls }
}

function versionAtLeast(version: string, minimum: string): boolean {
  const current = version.split('.').map(Number)
  const required = minimum.split('.').map(Number)
  for (let index = 0; index < required.length; index += 1) {
    const a = current[index] ?? 0
    const b = required[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}
