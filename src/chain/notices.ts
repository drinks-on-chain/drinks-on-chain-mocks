import { ownerEmailOf, sendMail } from '../backoffice/handlers/support'
import { MAIL_PATHS, type MailDraft } from '../backoffice/mail'
import type { MailTemplate } from '../backoffice/schemas/mail'
import { getErpDb } from '../erp/handlers/db'
import type { ChainNotice } from './state'
import { explorerContractUrl } from './views'

// Correos de la Ola 3 (contrato §11) en el buzón simulado. Los servicios puros dejan avisos en
// `ChainState.notices` (lo que el backend publica en su outbox); aquí se convierten en correos: al
// dueño de la bodega (solicitud recibida, cambios pedidos, aprobada, rechazada, NFT emitidos,
// colección publicada, pausada o reanudada, faltante) y a operaciones (solicitud nueva o reenviada
// y alertas `CRITICAL`).

const PLATFORM_RECIPIENT_ROLES = ['ADMIN', 'OPERATIONS']

/** Operaciones y administración (los mismos destinatarios que las solicitudes de alta de la Ola 1). */
function operationsEmails(): string[] {
  return getErpDb()
    .users.filter((u) => u.isActive && PLATFORM_RECIPIENT_ROLES.includes(u._mock.platformRole ?? ''))
    .map((u) => u.email)
}

type Draft = Omit<MailDraft, 'to' | 'token'>

const erp = (template: MailTemplate, subject: string, lines: string[], path: string, cta: string): Draft => ({ template, subject, lines, app: 'ERP', path, cta })
const backoffice = (template: MailTemplate, subject: string, lines: string[], path: string, cta: string): Draft => ({ template, subject, lines, app: 'BACKOFFICE', path, cta })

/** Los correos de un aviso: `owner` va al dueño de la bodega; `operations`, a operaciones y administración. */
function draftsOf(notice: ChainNotice): { owner?: Draft; operations?: Draft } {
  const db = getErpDb()
  const chain = db.chain
  const winery = db.wineries.find((w) => w.id === notice.wineryId)
  const tradeName = winery?.commercialName ?? 'la bodega'
  const request = chain.requests.find((r) => r.id === notice.requestId)
  const collection = chain.collections.find((c) => c.id === (notice.collectionId ?? request?.collectionId))
  const lot = db.lots.find((l) => l.id === (request?.lotId ?? collection?.lotId))
  const lotName = lot ? `«${lot.name}» (${lot.reference})` : 'el lote'
  const collectionName = collection ? `«${collection.commercial.name}»` : 'la colección'
  const quantity = request?.quantity ?? Number(notice.data?.quantity ?? 0)
  const requestPath = request ? MAIL_PATHS.tokenizationRequest(request.id) : '/'
  const collectionPath = collection ? MAIL_PATHS.collection(collection.id) : '/'
  switch (notice.type) {
    case 'REQUEST_SUBMITTED':
      return {
        owner: erp('TOKENIZATION_REQUEST_RECEIVED', `Recibimos tu solicitud de tokenización de ${lotName}`, [`Autorizaste ${quantity} botellas de ${lotName} para su preventa.`, 'El equipo de Drinks on Chain la revisará y te avisará por correo.'], requestPath, 'Ver la solicitud'),
        operations: backoffice('TOKENIZATION_REQUEST_FOR_OPERATIONS', `Solicitud de tokenización nueva: ${tradeName}`, [`${tradeName} autorizó ${quantity} botellas de ${lotName}.`], requestPath, 'Abrir en la bandeja'),
      }
    case 'REQUEST_RESUBMITTED':
      return {
        operations: backoffice('TOKENIZATION_REQUEST_FOR_OPERATIONS', `Solicitud de tokenización reenviada: ${tradeName}`, [`${tradeName} atendió los cambios pedidos en la solicitud de ${lotName}.`, ...(notice.message ? [`Mensaje de la bodega: ${notice.message}`] : [])], requestPath, 'Abrir en la bandeja'),
      }
    case 'CHANGES_REQUESTED':
      return {
        owner: erp('TOKENIZATION_CHANGES_REQUESTED', `Tu solicitud de tokenización necesita cambios: ${lotName}`, ['El equipo de Drinks on Chain revisó tu solicitud y pide lo siguiente:', notice.message ?? '', 'Edita la solicitud y vuelve a enviarla.'], requestPath, 'Editar y reenviar'),
      }
    case 'REQUEST_APPROVED':
      return {
        owner: erp('TOKENIZATION_APPROVED', `Solicitud aprobada: ${collectionName}`, [`Aprobamos tu solicitud de ${quantity} botellas de ${lotName}.`, 'La emisión de sus NFT ya está en curso en la red Stellar; te avisaremos cuando termine.'], collectionPath, 'Ver la colección'),
      }
    case 'REQUEST_REJECTED':
      return {
        owner: erp('TOKENIZATION_REJECTED', `Solicitud de tokenización rechazada: ${lotName}`, [`No pudimos aprobar tu solicitud de ${quantity} botellas de ${lotName}.`, `Motivo: ${notice.message ?? 'sin especificar'}`], requestPath, 'Ver la solicitud'),
      }
    case 'NFT_MINTED': {
      const contract = typeof notice.data?.contract === 'string' ? notice.data.contract : null
      return {
        owner: {
          template: 'NFT_MINTED',
          subject: `NFT emitidos: ${collectionName}`,
          lines: [`Ya están emitidos los ${quantity} NFT de ${collectionName} en el contrato de ${tradeName}.`, 'Puedes comprobarlos en el explorador de la red Stellar.'],
          app: null,
          path: null,
          url: contract ? explorerContractUrl(contract) : undefined,
          cta: 'Ver el contrato en el explorador',
        },
      }
    }
    case 'COLLECTION_PUBLISHED':
    case 'COLLECTION_PAUSED':
    case 'COLLECTION_RESUMED': {
      const what = notice.type === 'COLLECTION_PUBLISHED' ? 'publicada' : notice.type === 'COLLECTION_PAUSED' ? 'pausada' : 'reanudada'
      return {
        owner: erp('COLLECTION_STATUS_CHANGED', `Colección ${what}: ${collectionName}`, [`La colección ${collectionName} de ${tradeName} quedó ${what}.`, ...(notice.message ? [`Motivo: ${notice.message}`] : [])], collectionPath, 'Ver la colección'),
      }
    }
    case 'SHORTFALL_DETECTED': {
      const d = notice.data ?? {}
      return {
        owner: erp(
          'LOT_SHORTFALL_DETECTED',
          `Faltante de botellas en ${collectionName}`,
          [`Se emitieron ${String(d.minted)} NFT de ${collectionName} y el lote tiene ${String(d.bottles)} botellas: faltan ${String(d.shortfall)}.`, 'El equipo de Drinks on Chain decidirá el cierre: se queman primero los NFT sin vender y, si no bastan, se devuelve o se sustituye a los compradores afectados.'],
          collectionPath,
          'Ver el cierre',
        ),
      }
    }
    case 'ALERT_CRITICAL':
      return {
        operations: backoffice('CHAIN_ALERT_CRITICAL', `Alerta crítica de la cadena: ${String(notice.data?.code ?? '')}`, [notice.message ?? 'Hay una alerta crítica abierta en la cadena.', ...(winery ? [`Bodega: ${tradeName}`] : [])], MAIL_PATHS.chainAlerts(), 'Abrir las alertas'),
      }
  }
}

/** Convierte en correos los avisos pendientes de la Ola 3 (lo llama cada petición al terminar y `mockChain`). */
export function flushChainNotices(): number {
  const db = getErpDb()
  const notices = db.chain.notices
  if (!notices || notices.length === 0) return 0
  db.chain.notices = []
  let sent = 0
  for (const notice of notices) {
    const { owner, operations } = draftsOf(notice)
    const winery = db.wineries.find((w) => w.id === notice.wineryId)
    const ownerEmail = winery ? ownerEmailOf(winery) : null
    if (owner && ownerEmail) {
      sendMail({ ...owner, to: ownerEmail, token: null })
      sent += 1
    }
    if (operations) {
      for (const to of operationsEmails()) {
        sendMail({ ...operations, to, token: null })
        sent += 1
      }
    }
  }
  return sent
}
