import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cloudGetItem,
  cloudGetItems,
  cloudGetKeys,
  cloudRemoveItems,
  cloudSetItem,
  cloudStorageAvailability,
  cloudStorageSupported,
} from './cloudStorage'
import { createCloudStorageMock } from './cloudStorageMock'
import type { TelegramCloudStorage } from './webapp'

// window.Telegram.WebApp в тестах: облако есть только внутри мини-приложения Telegram.
function useTelegramPage(options: { storage?: TelegramCloudStorage; version?: string } = {}) {
  vi.stubGlobal('window', {
    Telegram: {
      WebApp: {
        initData: 'query_id=1',
        platform: 'android',
        version: options.version ?? '7.0',
        ...(options.storage ? { CloudStorage: options.storage } : {}),
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cloudStorageSupported', () => {
  it('в мини-приложении с облаком — true', () => {
    useTelegramPage({ storage: createCloudStorageMock().api })
    expect(cloudStorageSupported()).toBe(true)
  })

  it('вне Telegram — false: облако есть только у аккаунта в мини-приложении', () => {
    vi.stubGlobal('window', {})
    expect(cloudStorageSupported()).toBe(false)
  })

  it('в старом клиенте без CloudStorage — false', () => {
    useTelegramPage({ version: '6.5' })
    expect(cloudStorageSupported()).toBe(false)
  })
})

describe('cloudStorageAvailability: почему облака нет', () => {
  it('в мини-приложении с облаком — ready', () => {
    useTelegramPage({ storage: createCloudStorageMock().api })
    expect(cloudStorageAvailability()).toBe('ready')
  })

  it('в Telegram без CloudStorage — old-client: причину видно, и это совет обновить клиент', () => {
    useTelegramPage({ version: '6.5' })
    expect(cloudStorageAvailability()).toBe('old-client')
  })

  it('снаружи Telegram — outside-telegram', () => {
    vi.stubGlobal('window', {})
    expect(cloudStorageAvailability()).toBe('outside-telegram')
  })

  it('заглушка telegram-web-app.js в браузере не считается Telegram', () => {
    // Официальный скрипт создаёт WebApp и вне Telegram: initData пуст, platform = 'unknown'.
    // Без этой проверки браузер выглядел бы как устаревший клиент Telegram.
    vi.stubGlobal('window', {
      Telegram: { WebApp: { initData: '', platform: 'unknown', version: '6.0' } },
    })
    expect(cloudStorageAvailability()).toBe('outside-telegram')
  })
})

describe('чтение и запись в облако', () => {
  it('сохраняет и читает значение', async () => {
    const mock = createCloudStorageMock()
    useTelegramPage({ storage: mock.api })

    await cloudSetItem('selfcrm:test', 'привет')

    expect(mock.values.get('selfcrm:test')).toBe('привет')
    expect(await cloudGetItem('selfcrm:test')).toBe('привет')
  })

  it('отсутствующий ключ — null, а не ошибка', async () => {
    const mock = createCloudStorageMock()
    useTelegramPage({ storage: mock.api })

    await expect(cloudGetItem('selfcrm:нет-такого')).resolves.toBeNull()
  })

  it('getItems читает пачку ключей одним обращением к клиенту', async () => {
    const mock = createCloudStorageMock()
    useTelegramPage({ storage: mock.api })
    await cloudSetItem('a', '1')
    await cloudSetItem('b', '2')

    const values = await cloudGetItems(['a', 'b', 'c'])

    expect(values).toEqual({ a: '1', b: '2' })
    expect(mock.calls.read).toBe(1)
  })

  it('пустой список ключей не беспокоит клиент', async () => {
    const mock = createCloudStorageMock()
    useTelegramPage({ storage: mock.api })

    expect(await cloudGetItems([])).toEqual({})
    await expect(cloudRemoveItems([])).resolves.toBeUndefined()
    expect(mock.calls.read).toBe(0)
    expect(mock.calls.removed).toBe(0)
  })

  it('getKeys перечисляет ключи, removeItems удаляет', async () => {
    const mock = createCloudStorageMock()
    useTelegramPage({ storage: mock.api })
    await cloudSetItem('selfcrm:backup:part:0', 'часть')
    await cloudSetItem('selfcrm:backup:manifest', '{}')

    await expect(cloudGetKeys()).resolves.toEqual([
      'selfcrm:backup:part:0',
      'selfcrm:backup:manifest',
    ])

    await cloudRemoveItems(['selfcrm:backup:part:0'])
    await expect(cloudGetKeys()).resolves.toEqual(['selfcrm:backup:manifest'])
  })
})

describe('ошибки облака: пользователю понятен текст, а не код', () => {
  it('вне Telegram подсказывает открыть мини-приложение', async () => {
    vi.stubGlobal('window', {})

    await expect(cloudSetItem('k', 'v')).rejects.toThrow('только в мини-приложении')
    await expect(cloudGetItem('k')).rejects.toThrow('только в мини-приложении')
  })

  it('старый клиент: предлагает обновить Telegram', async () => {
    const mock = createCloudStorageMock({ version: '6.0' })
    useTelegramPage({ storage: mock.api, version: '6.0' })

    await expect(cloudSetItem('k', 'v')).rejects.toThrow('Обновите Telegram')
  })

  it('слишком большое значение: объясняет, что делать', async () => {
    const mock = createCloudStorageMock({ valueLimit: 4 })
    useTelegramPage({ storage: mock.api })

    await expect(cloudSetItem('k', 'слишком длинное значение')).rejects.toThrow(
      'Сохраните копию заново',
    )
  })

  it('незнакомая ошибка клиента приводится целиком', async () => {
    const mock = createCloudStorageMock()
    mock.api.setItem = (_key, _value, callback) => {
      Promise.resolve().then(() => callback?.('SOMETHING_BROKE'))
      return mock.api
    }
    useTelegramPage({ storage: mock.api })

    await expect(cloudSetItem('k', 'v')).rejects.toThrow('Telegram вернул ошибку: SOMETHING_BROKE')
  })
})
