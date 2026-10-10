import { sendMail } from '../backoffice/handlers/support'
import { getErpDb } from '../erp/handlers/db'
import { noticeMails } from './notice-mails'

// Buzón de la sesión: cada petición (y `mockChain`) convierte en correos los avisos pendientes de
// la Ola 3. La redacción vive en `notice-mails.ts` (pura: también la usa la semilla).

/** Convierte en correos los avisos pendientes de la Ola 3 (lo llama cada petición al terminar y `mockChain`). */
export function flushChainNotices(): number {
  const db = getErpDb()
  const notices = db.chain.notices
  if (!notices || notices.length === 0) return 0
  db.chain.notices = []
  let sent = 0
  for (const notice of notices) {
    for (const draft of noticeMails(notice, db)) {
      sendMail(draft)
      sent += 1
    }
  }
  return sent
}
