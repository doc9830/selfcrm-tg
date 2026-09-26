// Хранение состояния плашки «Поддержите разработку».
//
// В Telegram состояние лежит в облаке Telegram (WebApp.CloudStorage) — так же, как копия
// базы: оно переживает очистку данных клиента и переезд на другой телефон, и для этого не
// нужны ни cookies, ни отдельный сервер. Вне Telegram (браузер, страница на GitHub Pages)
// работает обычное хранилище приложения (localStorage), см. db/kvstore.ts.
//
// Ошибки хранилища не должны ломать интерфейс: если облако не ответило, плашка просто не
// покажется в этот раз. Данные CRM здесь ни при чём, и пугать пользователя незачем.

import { cloudGetItem, cloudSetItem, cloudStorageSupported } from '../telegram/cloudStorage'
import {
  parseSupportState,
  serializeSupportState,
  type SupportState,
} from '../utils/support'
import { localStorageStore, type KVStore } from './kvstore'

// Ключ облака Telegram: только латиница, цифры, «_» и «-» (см. telegram/cloudStorage.ts).
export const CLOUD_SUPPORT_KEY = 'selfcrm-support-state'
// Ключ localStorage — как у остальных данных приложения (см. STORAGE_KEY в database.ts).
export const LOCAL_SUPPORT_KEY = 'selfcrm:support-state'

// Читает состояние: сначала облако Telegram, при отказе или вне Telegram — хранилище
// приложения. Ничего не найдено — «ничего не было».
export async function loadSupportState(store: KVStore = localStorageStore): Promise<SupportState> {
  if (cloudStorageSupported()) {
    try {
      const fromCloud = await cloudGetItem(CLOUD_SUPPORT_KEY)
      if (fromCloud !== null) return parseSupportState(fromCloud)
    } catch {
      // Ниже — локальная копия: облако могло отказать (лимит, старый клиент, сеть).
    }
  }
  return parseSupportState(store.getItem(LOCAL_SUPPORT_KEY))
}

// Сохраняет состояние. Ошибки гасим: плашка — не то, ради чего стоит показывать ошибку.
export async function saveSupportState(
  state: SupportState,
  store: KVStore = localStorageStore,
): Promise<void> {
  const raw = serializeSupportState(state)
  // Локальная копия пишется в любом случае: она нужна и в браузере, и как запасной
  // вариант, если облако в следующий раз не ответит.
  store.setItem(LOCAL_SUPPORT_KEY, raw)

  if (cloudStorageSupported()) {
    try {
      await cloudSetItem(CLOUD_SUPPORT_KEY, raw)
    } catch {
      // Состояние осталось в локальной копии — для плашки этого достаточно.
    }
  }
}

// Отмечает открытие приложения: состояние читается, счётчик растёт, запись сохраняется.
// Возвращается новое состояние — по нему интерфейс и решает, показывать плашку или нет.
export async function registerSupportOpen(store: KVStore = localStorageStore): Promise<SupportState> {
  const state = await loadSupportState(store)
  const next: SupportState = { ...state, opens: state.opens + 1 }
  await saveSupportState(next, store)
  return next
}
