import { useEffect, useState } from 'react'
import { Icon } from './Icons'
import { useRoute } from '../router'
import { useData } from '../state/DataContext'
import { registerSupportOpen, saveSupportState } from '../db/supportState'
import { TELEGRAM_BOT_URL, openBotChat, openInvoice } from '../telegram/webapp'
import {
  EMPTY_SUPPORT_STATE,
  SUPPORT_AMOUNTS,
  SUPPORT_DETAIL,
  SUPPORT_FAILED,
  SUPPORT_TEXT,
  SUPPORT_THANKS,
  SUPPORT_TITLE,
  shouldShowSupport,
  supportAmountLabel,
  supportInvoiceUrl,
  type SupportAmount,
  type SupportState,
} from '../utils/support'

// Класс на <body>: пока плашка видна, у контента появляется запас снизу — плашка висит над
// нижним меню и ничего не перекрывает (см. .support-visible в index.css).
const BODY_CLASS = 'support-visible'

// Плашка «Поддержите разработку» на главном экране.
//
// Это именно плашка, а не модальное окно: CRM остаётся полностью рабочей, плашка занимает
// небольшую полосу внизу, её можно закрыть крестиком. Правила показа живут в utils/support.ts:
// не раньше третьего открытия (или первых записей в базе), неделя тишины после «×» и
// «больше никогда» после поддержки. Состояние хранится в облаке Telegram (db/supportState.ts),
// поэтому переживает смену устройства. Оплата — звёздами Telegram: платёжный лист открывает
// клиент, а если он этого не умеет (браузер, старый клиент), те же счета присылает бот.
export function SupportBanner() {
  const { route } = useRoute()
  const { db } = useData()
  const [state, setState] = useState<SupportState>(EMPTY_SUPPORT_STATE)
  const [visible, setVisible] = useState(false)
  const [choose, setChoose] = useState(false)
  const [notice, setNotice] = useState('')

  const onMain = route.segments.length === 0

  // Открытие приложения считается один раз за запуск: счётчик и решает, пора ли показывать
  // плашку (см. SUPPORT_MIN_OPENS и SUPPORT_MIN_RECORDS).
  useEffect(() => {
    if (!onMain) return
    let cancelled = false

    const register = async () => {
      const next = await registerSupportOpen()
      if (cancelled) return
      setState(next)
      const records =
        db.getClients(true).length + db.getOrders().length + db.getProducts().length
      if (shouldShowSupport(next, records)) setVisible(true)
    }

    // Хранилище может отказать (нет облака, запрет localStorage) — плашку не показываем:
    // поддержка проекта не важнее работы с CRM.
    void register().catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [onMain, db])

  // Пока плашка на экране, внизу страницы освобождается место под неё.
  useEffect(() => {
    if (!visible) return
    document.body.classList.add(BODY_CLASS)
    return () => document.body.classList.remove(BODY_CLASS)
  }, [visible])

  // «Поддержал» — больше не показываем никогда.
  const markSupported = () => {
    const next: SupportState = { ...state, supportedAt: new Date().toISOString() }
    setState(next)
    setChoose(false)
    setNotice(SUPPORT_THANKS)
    void saveSupportState(next).catch(() => undefined)
    window.setTimeout(() => setVisible(false), 3000)
  }

  // «×» — неделя тишины: дата закрытия запоминается, отсрочку считает utils/support.ts.
  const dismiss = () => {
    const next: SupportState = { ...state, dismissedAt: new Date().toISOString() }
    setState(next)
    setVisible(false)
    setChoose(false)
    void saveSupportState(next).catch(() => undefined)
  }

  const pay = (amount: SupportAmount) => {
    const url = supportInvoiceUrl(amount)
    const opened =
      url !== null &&
      openInvoice(url, (status) => {
        if (status === 'paid') markSupported()
        else if (status === 'failed') setNotice(SUPPORT_FAILED)
        // 'cancelled' и 'pending' — лист закрыли или платёж ещё идёт: молчим.
      })

    if (!opened) {
      // Оплатить в этом окружении нельзя: те же счета присылает бот по /support.
      setNotice('')
      setChoose(false)
      setVisible(false)
      openBotChat(`${TELEGRAM_BOT_URL}?start=support`)
    }
  }

  if (!visible) return null

  return (
    <div className="support-banner" role="status">
      {notice ? (
        <div className="support-banner-row">
          <span className="support-banner-text">{notice}</span>
        </div>
      ) : choose ? (
        <>
          <div className="support-banner-row">
            <span className="support-banner-text">Сколько звёзд отправить?</span>
            <button
              type="button"
              className="support-banner-close"
              onClick={() => setChoose(false)}
              aria-label="Назад"
            >
              <Icon name="back" size={16} />
            </button>
          </div>
          <div className="support-amounts">
            {SUPPORT_AMOUNTS.map((amount) => (
              <button key={amount} type="button" className="chip" onClick={() => pay(amount)}>
                {supportAmountLabel(amount)}
              </button>
            ))}
          </div>
          <div className="support-banner-hint">{SUPPORT_DETAIL}</div>
        </>
      ) : (
        <div className="support-banner-row">
          <span className="support-banner-text">
            <b>{SUPPORT_TITLE}</b> {SUPPORT_TEXT}
          </span>
          <button type="button" className="support-banner-pay" onClick={() => setChoose(true)}>
            Поддержать
          </button>
          <button
            type="button"
            className="support-banner-close"
            onClick={dismiss}
            aria-label="Скрыть"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
