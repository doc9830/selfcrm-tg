import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramCloudStorage } from '../telegram/webapp'
import { createCloudStorageMock } from '../telegram/cloudStorageMock'
import { EMPTY_SUPPORT_STATE } from '../utils/support'
import { MemoryStore } from './kvstore'
import {
  CLOUD_SUPPORT_KEY,
  LOCAL_SUPPORT_KEY,
  loadSupportState,
  registerSupportOpen,
  saveSupportState,
} from './supportState'

// Состояние плашки: в Telegram — облако (значит, доступно с другого устройства), вне
// Telegram — хранилище приложения. Здесь проверяются оба пути и поведение при отказе облака.
function useTelegramPage(storage: TelegramCloudStorage) {
  vi.stubGlobal('window', {
    Telegram: {
      WebApp: {
        initData: 'query_id=1',
        platform: 'android',
        version: '7.0',
        CloudStorage: storage,
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('supportState', () => {
  it('вне Telegram живёт в хранилище приложения', async () => {
    vi.stubGlobal('window', {})
    const store = new MemoryStore()

    expect(await loadSupportState(store)).toEqual(EMPTY_SUPPORT_STATE)

    await saveSupportState({ ...EMPTY_SUPPORT_STATE, opens: 2 }, store)

    expect(JSON.parse(store.getItem(LOCAL_SUPPORT_KEY) ?? '{}').opens).toBe(2)
    expect((await loadSupportState(store)).opens).toBe(2)
  })

  it('в мини-приложении состояние уходит в облако Telegram', async () => {
    const cloud = createCloudStorageMock()
    useTelegramPage(cloud.api)
    const store = new MemoryStore()

    expect((await registerSupportOpen(store)).opens).toBe(1)
    expect(cloud.values.get(CLOUD_SUPPORT_KEY)).toBeTruthy()

    // Другое устройство: хранилище приложения пустое, а облако то же самое.
    expect((await loadSupportState(new MemoryStore())).opens).toBe(1)
  })

  it('отказ облака не мешает: состояние остаётся в хранилище приложения', async () => {
    const cloud = createCloudStorageMock()
    cloud.api.setItem = (key, value, callback) => {
      void key
      void value
      callback?.('UNKNOWN_ERROR')
      return cloud.api
    }
    useTelegramPage(cloud.api)
    const store = new MemoryStore()

    expect((await registerSupportOpen(store)).opens).toBe(1)
    expect(store.getItem(LOCAL_SUPPORT_KEY)).toBeTruthy()
  })

  it('счётчик открытий растёт с каждым открытием приложения', async () => {
    vi.stubGlobal('window', {})
    const store = new MemoryStore()

    await registerSupportOpen(store)
    await registerSupportOpen(store)

    expect((await registerSupportOpen(store)).opens).toBe(3)
  })
})
