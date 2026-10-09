import { findWinery, recordAudit } from '../backoffice/handlers/support'
import { platformRolesWith } from '../backoffice/permissions'
import { platform, trace } from '../erp/handlers/auth-context'
import { getErpDb, tick } from '../erp/handlers/db'
import { ApiError, fieldError, invalid } from '../erp/handlers/errors'
import { accepted, boolParam, enumParam, listResult, ok, parseBody, strParam, type RouteContext, type RouteSpec } from '../erp/handlers/http'
import { chainAccountView } from '../tokenization/views'
import { chainCtx, userRefOf } from './runtime'
import { CHAIN_ALERT_LEVELS, CHAIN_SUBJECT_TYPES, CHAIN_TX_KINDS, CHAIN_TX_STATUSES, ChainActionSchema, RECONCILIATION_STATUSES, ResolveChainAlertSchema, StartReconciliationSchema, type ChainTransaction } from './schemas'
import { abandonTx, platformAccounts, provisionIdentity, resolveAlert, retryTx, runDetail, runReconciliation, setContractPaused, txNotFound } from './service'
import { identityView } from './views'

// Handlers del dominio `chain` (contrato de la Ola 3 §2.4, §3.4, §3.5 y §8): transacciones, cuentas
// de la plataforma, eventos del indexador, conciliación y alertas del back office; identidad de cada
// bodega (reaprovisionar, pausar y reanudar el contrato en la red) y la cuenta de la bodega en el ERP.

const READERS = platform(platformRolesWith('chain', 'FULL', 'READ'))
const OPERATORS = platform(platformRolesWith('chain', 'FULL'))
/** Abandonar una transacción y pausar o reanudar un contrato en la red: solo administración. */
const ADMINS = platform(platformRolesWith('chain.admin', 'FULL'))

const chain = () => getErpDb().chain

function findTx(id: string): ChainTransaction {
  const tx = chain().transactions.find((t) => t.id === id)
  if (!tx) throw txNotFound()
  return tx
}

/** `from`/`to`: `AAAA-MM-DD` (día completo, UTC) o instante ISO. */
function rangeParam(query: URLSearchParams, name: 'from' | 'to'): number | undefined {
  const raw = strParam(query, name)
  if (!raw) return undefined
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  const ms = Date.parse(day ? `${raw}T${name === 'from' ? '00:00:00' : '23:59:59'}Z` : raw)
  if (Number.isNaN(ms)) throw invalid([fieldError(name, `${name} debe ser una fecha AAAA-MM-DD o un instante ISO 8601`)])
  return ms
}

function audit(ctx: RouteContext, action: string, wineryId: string | null, resource: { type: string; id: string }, after: Record<string, unknown> | null, reason: string | null): void {
  recordAudit(ctx, { action, resource, organizationId: wineryId, after, reason })
}

export const chainRoutes: RouteSpec[] = [
  // ----- Transacciones -----
  {
    method: 'get',
    path: '/v1/platform/chain/transactions',
    access: READERS,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', CHAIN_TX_STATUSES)
      const kind = enumParam(query, 'kind', CHAIN_TX_KINDS)
      const subjectType = enumParam(query, 'subjectType', CHAIN_SUBJECT_TYPES)
      const subjectId = strParam(query, 'subjectId')
      const wineryId = strParam(query, 'wineryId')
      const from = rangeParam(query, 'from')
      const to = rangeParam(query, 'to')
      const items = chain()
        .transactions.filter(
          (t) =>
            (!status || t.status === status) &&
            (!kind || t.kind === kind) &&
            (!subjectType || t.subject.type === subjectType) &&
            (!subjectId || t.subject.id === subjectId) &&
            (!wineryId || t.wineryId === wineryId) &&
            (from === undefined || Date.parse(t.createdAt) >= from) &&
            (to === undefined || Date.parse(t.createdAt) <= to),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/chain/transactions/:id',
    access: READERS,
    handle: ({ params }) => ok(findTx(params.id!)),
  },
  {
    method: 'post',
    path: '/v1/platform/chain/transactions/:id/retry',
    access: OPERATORS,
    idempotent: 'required',
    async handle(ctx) {
      const { request, auth, params } = ctx
      const tx = findTx(params.id!)
      const body = await parseBody(request, ChainActionSchema)
      tick()
      retryTx(getErpDb(), chainCtx(auth), tx)
      audit(ctx, 'CHAIN_TX_RETRIED', tx.wineryId, { type: 'chain_transaction', id: tx.id }, { kind: tx.kind }, body.reason)
      return ok(tx)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/chain/transactions/:id/abandon',
    access: ADMINS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const tx = findTx(params.id!)
      const body = await parseBody(request, ChainActionSchema)
      tick()
      abandonTx(getErpDb(), chainCtx(auth), tx, body.reason, userRefOf(auth))
      audit(ctx, 'CHAIN_TX_ABANDONED', tx.wineryId, { type: 'chain_transaction', id: tx.id }, { kind: tx.kind }, body.reason)
      return ok(tx)
    },
  },

  // ----- Cuentas de la plataforma y eventos -----
  {
    method: 'get',
    path: '/v1/platform/chain/accounts',
    access: READERS,
    handle: () => ok(platformAccounts(getErpDb())),
  },
  {
    method: 'get',
    path: '/v1/platform/chain/events',
    access: READERS,
    list: 'paged',
    handle({ query }) {
      const contract = strParam(query, 'contract')
      const type = strParam(query, 'type')
      const txHash = strParam(query, 'txHash')
      const unmatched = boolParam(query, 'unmatched')
      const from = rangeParam(query, 'from')
      const to = rangeParam(query, 'to')
      const items = chain()
        .events.filter(
          (e) =>
            (!contract || e.contractAddress === contract) &&
            (!type || e.type === type) &&
            (!txHash || e.txHash === txHash) &&
            (unmatched === undefined || (e.matchedTransactionId === null) === unmatched) &&
            (from === undefined || Date.parse(e.ledgerClosedAt) >= from) &&
            (to === undefined || Date.parse(e.ledgerClosedAt) <= to),
        )
        .sort((a, b) => b.rpcEventId.localeCompare(a.rpcEventId))
      return listResult(items, query)
    },
  },

  // ----- Conciliación y alertas -----
  {
    method: 'get',
    path: '/v1/platform/chain/reconciliation/runs',
    access: READERS,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', RECONCILIATION_STATUSES)
      return listResult(
        chain()
          .runs.filter((r) => !status || r.status === status)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        query,
      )
    },
  },
  {
    method: 'post',
    path: '/v1/platform/chain/reconciliation/runs',
    access: OPERATORS,
    async handle(ctx) {
      const { request, auth } = ctx
      const body = await parseBody(request, StartReconciliationSchema)
      if (body.scope !== 'ALL' && !body.subjectId) throw invalid([fieldError('subjectId', 'Indica el contrato o la colección que se concilia')])
      tick()
      const run = runReconciliation(getErpDb(), chainCtx(auth), body)
      audit(ctx, 'RECONCILIATION_RUN_STARTED', null, { type: 'reconciliation_run', id: run.id }, { scope: run.scope, depth: run.depth, subjectId: run.subjectId }, null)
      return accepted(run)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/chain/reconciliation/runs/:id',
    access: READERS,
    handle({ params }) {
      const run = chain().runs.find((r) => r.id === params.id)
      if (!run) throw new ApiError(404, 'NOT_FOUND', 'Conciliación no encontrada')
      return ok(runDetail(getErpDb(), run))
    },
  },
  {
    method: 'get',
    path: '/v1/platform/chain/alerts',
    access: READERS,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', ['open', 'resolved'] as const)
      const level = enumParam(query, 'level', CHAIN_ALERT_LEVELS)
      const code = strParam(query, 'code')
      const wineryId = strParam(query, 'wineryId')
      const items = chain()
        .alerts.filter((a) => (!status || (a.resolvedAt === null) === (status === 'open')) && (!level || a.level === level) && (!code || a.code === code) && (!wineryId || a.wineryId === wineryId))
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      return listResult(items, query)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/chain/alerts/:id/resolve',
    access: OPERATORS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const alert = chain().alerts.find((a) => a.id === params.id)
      if (!alert) throw new ApiError(404, 'NOT_FOUND', 'Alerta no encontrada')
      const body = await parseBody(request, ResolveChainAlertSchema)
      tick()
      resolveAlert(getErpDb(), chainCtx(auth), alert, body.note, userRefOf(auth))
      audit(ctx, 'CHAIN_ALERT_RESOLVED', alert.wineryId, { type: 'chain_alert', id: alert.id }, { code: alert.code }, body.note)
      return ok(alert)
    },
  },

  // ----- Identidad de la bodega (§3) -----
  {
    method: 'get',
    path: '/v1/platform/wineries/:id/chain-account',
    access: READERS,
    handle({ auth, params }) {
      const winery = findWinery(params.id!)
      return ok(chainAccountView(getErpDb(), chainCtx(auth), winery.id))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/wineries/:id/chain/provision',
    access: OPERATORS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const winery = findWinery(params.id!)
      const body = await parseBody(request, ChainActionSchema)
      tick()
      provisionIdentity(getErpDb(), chainCtx(auth), winery.id, userRefOf(auth))
      audit(ctx, 'WINERY_CHAIN_PROVISION_RETRIED', winery.id, { type: 'winery', id: winery.id }, null, body.reason)
      return accepted(identityView(chain(), winery.id))
    },
  },
  ...(['pause', 'unpause'] as const).map(
    (action): RouteSpec => ({
      method: 'post',
      path: `/v1/platform/wineries/:id/chain/${action}`,
      access: ADMINS,
      idempotent: 'required',
      async handle(ctx) {
        const { request, auth, params } = ctx
        const winery = findWinery(params.id!)
        const body = await parseBody(request, ChainActionSchema)
        const at = tick()
        setContractPaused(getErpDb(), chainCtx(auth), winery.id, action === 'pause', userRefOf(auth), at)
        audit(ctx, action === 'pause' ? 'CHAIN_CONTRACT_PAUSED' : 'CHAIN_CONTRACT_UNPAUSED', winery.id, { type: 'winery', id: winery.id }, null, body.reason)
        return accepted(identityView(chain(), winery.id))
      },
    }),
  ),

  // ----- ERP: cuenta de la bodega (ORG-12) -----
  {
    method: 'get',
    path: '/v1/organizations/current/chain-account',
    access: trace(null),
    handle({ auth }) {
      // El personal de plataforma la consulta con `?wineryId=`.
      if (!auth.tenantId) throw invalid([fieldError('wineryId', 'Indica la bodega (?wineryId=)')])
      return ok(chainAccountView(getErpDb(), chainCtx(auth), auth.tenantId))
    },
  },
]
