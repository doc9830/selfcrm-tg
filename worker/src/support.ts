// Поддержка проекта звёздами Telegram.
//
// Приём платежей устроен по документации Telegram: бот продаёт цифровые товары, а значит
// оплата идёт только звёздами (currency XTR). Порядок такой:
//   1. ссылку на счёт создаёт `createInvoiceLink`; из неё платёжный лист открывает клиент
//      (в мини-приложении это WebApp.openInvoice, см. src/utils/support.ts);
//   2. перед оплатой приходит `pre_checkout_query` — ответить нужно за 10 секунд
//      (`answerPreCheckoutQuery`), иначе платёж не пройдёт;
//   3. после оплаты приходит `successful_payment` — за него благодарим и пишем в лог
//      `telegram_payment_charge_id`: только с ним можно вернуть звёзды.
//
// Ссылки на счета создаются на каждый вызов /support: Worker не хранит состояние между
// запросами, а ссылки постоянные — открывать их можно многократно, каждый платёж приходит
// отдельным `successful_payment`.
import { SUPPORT_AMOUNTS, SUPPORT_PAYLOAD, SUPPORT_TITLE } from './config'
import { supportInvoiceDescription } from './messages'
import type { Deps, Env } from './telegram'
import { telegram } from './telegram'

// Ссылки на счета по суммам: 50, 100, 250 и 500 ⭐.
export async function starLinks(env: Env, deps: Deps): Promise<Record<number, string>> {
  const links = await Promise.all(
    SUPPORT_AMOUNTS.map((amount) =>
      telegram(
        'createInvoiceLink',
        {
          title: SUPPORT_TITLE,
          description: supportInvoiceDescription(amount),
          // payload у каждого счёта свой — по нему видно, что платёж принят, и какая сумма.
          payload: `${SUPPORT_PAYLOAD}-${amount}`,
          currency: 'XTR',
          prices: [{ label: SUPPORT_TITLE, amount }],
        },
        env,
        deps,
      ),
    ),
  )

  const byAmount: Record<number, string> = {}
  SUPPORT_AMOUNTS.forEach((amount, index) => {
    byAmount[amount] = links[index]
  })
  return byAmount
}
