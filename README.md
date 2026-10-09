# @drinks-on-chain/mocks

Datos de prueba compartidos del ecosistema **Drinks on Chain**: esquemas zod de los DTO del backend, fixtures JSON deterministas y handlers [MSW](https://mswjs.io) que imitan el backend del ERP con su envoltorio, sesión (organizaciones, membresías y renovación rotativa en cookie), roles, multi-tenant y reglas de negocio. Desde 0.2 siguen el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro) y desde 0.3 el **de la Ola 1** (`plan/contratos/o1-backoffice-y-bodegas.md`): back office, alta de bodegas, invitaciones, equipos, configuración, bitácora, tablero y segundo factor (TOTP), con un buzón simulado. Desde 0.4 están alineados con el **backend real de la Ola 1 completa** (OpenAPI de `drinks-on-chain-back`, sin operaciones adelantadas). Desde 0.4.1 incluyen la **lista de espera** (`plan/contratos/o1b-lista-de-espera.md`, backend `v0.1.1`). Desde 0.5 (pre-release `0.5.0-rc.2`, alineada con el backend de la Etapa 2 completa) llevan el **ERP v2 y el dominio público de la Ola 2** (`plan/contratos/o2-erp-confiable.md`): el lote como entidad del servidor, las reglas de la trazabilidad confiable, un código por botella, el expediente y los pasaportes públicos. Las apps se construyen contra estos mocks y pasan al backend real cambiando `NEXT_PUBLIC_API_URL` y apagando MSW.

Planificación: [`drinks-on-chain-docsfront`](https://github.com/drinks-on-chain/drinks-on-chain-docsfront) (docs 08 y 09). Diferencias entre el OpenAPI y los mocks: [`docs/CONTRATO.md`](docs/CONTRATO.md). Avance: [`docs/ROADMAP.md`](docs/ROADMAP.md).

Alcance actual: dominio **ERP** (`src/erp/`, con las reglas de la trazabilidad en `src/erp/trace/`), **Backoffice/identidad** de la Ola 1 (`src/backoffice/`, `fixtures/backoffice/`) y **público** de la Ola 2 (`src/public/`, `fixtures/public/`: pasaportes, directorio de bodegas y el borrador del catálogo). El resto del Marketplace y el POS se añadirán con la misma estructura.

## Instalación

No hace falta registro de paquetes: cada versión se publica como GitHub Release con el tarball. Las versiones `X.Y.Z-rc.N` son pre-releases publicadas desde `dev` para adelantar el contrato de una ola; las estables salen de `main`. Migraciones (0.1 → 0.2 → 0.3 → 0.4 → 0.4.1 → 0.5): ver [CHANGELOG](CHANGELOG.md).

```bash
# Estable (Ola 1 + lista de espera)
pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.4.1/drinks-on-chain-mocks-0.4.1.tgz
# Estable de la Ola 2 (ERP v2 y dominio público)
pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.5.0/drinks-on-chain-mocks-0.5.0.tgz
# Pre-release de la Ola 3 (tokenización y cadena)
pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.6.0-rc.1/drinks-on-chain-mocks-0.6.0-rc.1.tgz
pnpm add zod msw        # peer dependencies (msw solo si usas los handlers)
```

```json
"dependencies": {
  "@drinks-on-chain/mocks": "https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.5.0/drinks-on-chain-mocks-0.5.0.tgz"
}
```

Pasar de 0.4.1 a `0.5.0` (ERP, Marketplace y Backoffice): «Guía de migración desde 0.4.1» de la entrada 0.5.0 del [CHANGELOG](CHANGELOG.md); el detalle, en «Cambiado» de 0.5.0-rc.1. De `rc.1` a `rc.2`: la lista de lo que obliga a tocar código está en la entrada 0.5.0-rc.2. De `rc.2` a `rc.3` (cierre H2: sin rutas legadas ni `LotView`), y lo que le cambia al Backoffice al saltar de 0.4.1 a 0.5.0: «Guía de migración» de la entrada 0.5.0-rc.3.

## Puntos de entrada

| Import | Contenido | ¿Importa msw? |
|---|---|---|
| `@drinks-on-chain/mocks` | Esquemas zod (respuesta y alta/edición) y tipos de cada recurso, enumeraciones, sesión (`SessionResponseSchema`, `MeResponseSchema`, `MembershipSchema`, `OrganizationType`, roles de plataforma, bodega y punto de canje, `AccessTokenClaims`), envoltorio (`successEnvelopeSchema`, `ErrorEnvelopeSchema`, `ApiErrorDetail`), listas (`ListPage<T>`, `listPageSchema`, `DEFAULT_LIMIT`, `MAX_LIMIT`, `unwrapList`) y los esquemas de la Ola 1 (`InvitationSchema`, `WineryApplicationSchema`, `WineryDetailSchema`, `MemberSchema`, `PlatformUserSchema`, `SettingDefinitionSchema`, `AuditEventSchema`, `DashboardSchema`, `PermissionMatrixSchema`, `LoginResponseSchema`, `MfaChallengeSchema`, `isMfaChallenge`…) y los de la lista de espera (`WaitlistEntrySchema`, `WaitlistJoinRequestSchema`, `WaitlistStatsSchema`, `UpdateWaitlistEntrySchema`…). Desde 0.5, los del ERP v2 (`LotSchema`, `LotSummarySchema`, `LotRulesSchema`, `LotTimelineSchema`, `LotBalanceSchema`, `LotGraphSchema`, `BottlingPreviewSchema`, `BottleUnitSchema`, `PhytoDecisionSchema`, `MaturityAnalysisSchema`, `CorrectionSchema`, `LotDossierSchema`, `LabConformitySchema`, `TraceDashboardSchema`, `ProductionReportSchema`, `CanonicalDossierSchema`, `CorrectionMarksSchema`, `TankTransitionSchema`…), los errores `TRACE_ERROR_CODES`, los del dominio público (`PublicLotPassportSchema`, `PublicBottlePassportSchema`, `PublicCodePassportSchema`, `PublicCollectionSchema`) y las utilidades de los códigos de botella y del expediente (`normalizeBottleCode`, `isValidBottleCode`, `formatBottleCode`, `merkleLeaf`, `merkleRoot`, `merkleRootFromProof`, `verifyMerkleProof`, `sha256Hex`, `canonicalJson`) | No. Apto para producción |
| `@drinks-on-chain/mocks/fixtures` | `erpFixtures` (desde 0.5 con `lots`, `lotEvents`, `maturityAnalyses`, `phytoDecisions`, `bottleLots`, `corrections`, `lotAttachments`, `lotDossiers`), `publicFixtures` (`passports`, `bottleCodes`, `wineries`, `collections`), `SINGANI_CASE`, `PASSPORT_CASES`, `mockBottleCode()`, `backofficeFixtures` (JSON tipados; `backofficeFixtures.waitlist` desde 0.4.1), `demoUsers` (con membresías, rol de plataforma y TOTP), `demoStaff`, `DEMO_PASSWORD`, `DEMO_NEW_PASSWORD`, `DEMO_TOTP_SECRET`, `MOCK_TOTP_BYPASS_CODE`, `generateTotp()` | No |
| `@drinks-on-chain/mocks/fixtures/{erp,backoffice,public,chain,tokenization}/<archivo>.json` | JSON crudos (`chain` y `tokenization`, desde 0.6: también `chainFixtures` y `tokenizationFixtures` en `…/fixtures`) | No |
| `@drinks-on-chain/mocks/handlers` | `createErpHandlers()` (= `createMockHandlers()`, todos los dominios), `resetErpDb()`, `getErpDb()`, `advanceMockClock()`, `mockMailbox`, `setMockAppUrls()`, `resetSessions()`, `expireAccessTokens()`, `ERP_ROUTES`, `MOCK_ROUTE_SPECS`, `PUBLIC_ROUTE_SPECS`, escenarios (`setScenario`, `SCENARIOS`, `SCENARIO_DESCRIPTIONS`, `RESPONSE_SCENARIOS`, `DATA_SCENARIOS`), `SINGANI_CASE`, `PASSPORT_CASES`, `PUBLIC_LOOKUP_LIMIT`, `PUBLIC_RATE_LIMIT`, `COLLECTIONS_DRAFT_CONTRACT`, `demoUsers`, `mockAccessToken()` | Sí |
| `@drinks-on-chain/mocks/browser` | `startMockWorker(options)` (Service Worker; publica `window.__docMocks`), `mockMailbox` | Sí (import dinámico) |
| `@drinks-on-chain/mocks/node` | `setupMockServer(options)` para Vitest, Playwright y scripts, `mockMailbox`, `generateTotp()` | Sí |

```ts
import { LotSchema, pagedSchema, type Lot } from '@drinks-on-chain/mocks'

const lots: Lot[] = pagedSchema(LotSchema).parse(data).items // GET /v1/lots
```

El lote es una entidad del servidor desde la Ola 2 (`GET /v1/lots`, `LotSchema`). La vista derivada de 0.1–0.4 (`LotView`, `deriveLotViews`, `deriveRestStatus`, `lots-view.json`) se retiró con el cierre H2 (0.5.0-rc.3): el reposo de una destilación está en `production.lock` y en `GET /v1/production-batches/{id}/rest-status`.

## Conectar MSW en una app Next.js 16 (App Router)

1. Copia el Service Worker a `public/` (una vez, y de nuevo al actualizar msw):

   ```bash
   pnpm exec msw init public --save
   ```

2. Variables de entorno (`.env.development.local`):

   ```bash
   NEXT_PUBLIC_MOCKS=1
   NEXT_PUBLIC_API_URL=https://136.243.223.39.sslip.io   # o vacío si la app llama a /api/v1 (P-1)
   ```

   Con la propuesta P-1 la app llama a `/api/v1/*` de su propio origen y `next.config` lo reescribe a `${API_ORIGIN}/v1/*`, para que la cookie de renovación sea de primera parte. Los handlers responden **siempre** tanto en `${baseUrl}/v1/*` como en `/api/v1/*` de cualquier origen, así que la misma configuración de MSW sirve para los dos modos.

3. Componente cliente que espera al worker antes de pintar la app:

   ```tsx
   // src/app/mocks-provider.tsx
   'use client'

   import { useEffect, useState, type ReactNode } from 'react'

   const MOCKS = process.env.NEXT_PUBLIC_MOCKS === '1'

   export function MocksProvider({ children }: { children: ReactNode }) {
     const [ready, setReady] = useState(!MOCKS)

     useEffect(() => {
       if (!MOCKS) return
       import('@drinks-on-chain/mocks/browser')
         .then(({ startMockWorker }) => startMockWorker({ baseUrl: process.env.NEXT_PUBLIC_API_URL }))
         .then(() => setReady(true))
     }, [])

     return ready ? children : null
   }
   ```

   ```tsx
   // src/app/layout.tsx
   import { MocksProvider } from './mocks-provider'

   export default function RootLayout({ children }: { children: React.ReactNode }) {
     return (
       <html lang="es">
         <body>
           <MocksProvider>{children}</MocksProvider>
         </body>
       </html>
     )
   }
   ```

   El `import()` dinámico deja msw en un chunk aparte que solo se descarga con `NEXT_PUBLIC_MOCKS=1`. Sin `baseUrl` los handlers interceptan `*/v1/...` en cualquier origen (lo que incluye `/api/v1/...`); con `baseUrl` ese origen más `*/api/v1/...`, y además responden 404 con envoltorio a las rutas `/v1/*` y `/api/v1/*` desconocidas. El `path` del envoltorio es siempre `/v1/...`.

4. Si algún Server Component llama al backend, el Service Worker no lo ve: arranca también el servidor de Node en `instrumentation.ts`:

   ```ts
   export async function register() {
     if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PUBLIC_MOCKS === '1') {
       const { setupMockServer } = await import('@drinks-on-chain/mocks/node')
       setupMockServer({ baseUrl: process.env.NEXT_PUBLIC_API_URL }).listen({ onUnhandledRequest: 'bypass' })
     }
   }
   ```

Las URL de archivos de los fixtures y las URL firmadas de los mocks (`/mocks/uploads/...`) las sirven los propios handlers desde 0.5.0-rc.2: una imagen SVG de demostración (logotipos, etiquetas, imágenes del catálogo), un PDF de una página (informes, certificados) o el ZIP de una exportación de códigos. Con `next/image` usa `unoptimized` para esas URL (el optimizador de Next no pasa por MSW). Si la app prefiere servir sus propios archivos desde `public/mocks/uploads/`, arranca los mocks con `uploads: 'passthrough'`.

### En pruebas (Vitest / Playwright)

```ts
import { resetErpDb, setupMockServer } from '@drinks-on-chain/mocks/node'

const server = setupMockServer({ baseUrl: 'https://api.test' }) // latencia 0 por defecto
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => { server.resetHandlers(); resetErpDb() })
afterAll(() => server.close())
```

## Qué simulan los handlers

- Las **158 operaciones** del OpenAPI del backend (cierre H2 de la Ola 2, sin rutas legadas) con el envoltorio real: `{ success, statusCode, timestamp, path, data | error: { code, message, details } }`: el ERP de las olas 0 y 1, las 66 de la Ola 1, las 6 de la lista de espera y las **45 de la Ola 2** (ver abajo), más 2 del borrador del catálogo. Las cinco rutas legadas que convivieron hasta H2 responden 404. Todas devuelven `X-Correlation-ID`; los 9 POST de alta del ERP aceptan `Idempotency-Key` (repetición → `Idempotent-Replayed: true`).
- **Sesión** (contrato §4–§5): `POST /v1/auth/login` con cualquier usuario de `users.json` y `demo1234` devuelve `{ user, memberships, activeOrganizationId, tokens }` (lo de `auth-login.json` con tokens de sesión propios): acceso de 15 min con forma de JWT (claims `sub`, `aud`, `org`, `orgType`, `role`, `sid`…) y el refresco **solo** en la cookie `doc_rt` (`HttpOnly`, `SameSite=Lax`; desde H1 no va en el cuerpo). Como el backend (contrato §8): refresco `<sid>.<generación>.<secreto>`; `refresh` lee la cookie, rota siempre, tolera el anterior durante 20 s (dos pestañas) y detecta la reutilización (401 `AUTH_REFRESH_REUSED`; uno inventado → `AUTH_REFRESH_INVALID` sin revocar); `switch-organization` cambia la organización activa en la misma sesión y **exige el refresco de esa sesión** en la cookie (`refreshToken` en el cuerpo → 422); `logout`/`logout-all` revocan (204). `GET` y `PATCH /v1/users/me` → `{ user, memberships, activeOrganizationId }`. 5 logins fallidos del mismo correo → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After`. Las sesiones sobreviven a una recarga (`localStorage`); `expireAccessTokens()` simula que pasaron 15 min y `expireRefreshGrace()` que pasaron los 20 s de gracia. El token estático `mock.access.<clave>` sigue valiendo (paneles y pruebas).
- **Permisos** como los guards del backend: rol de la **membresía activa** (`OPERATOR` pesa y registra lecturas, `ACCOUNTANT` solo lee, `OWNER` dictamina; matriz en [docs/CONTRATO.md §3](docs/CONTRATO.md)) → 403 `AUTH_INSUFFICIENT_PERMISSIONS`; **multi-tenant** por la bodega activa (lo de otra bodega da 404). La plataforma lee todas las bodegas y opera sobre una con `?wineryId=` (obligatorio en escrituras → 422; `SUPPORT` solo lee). Bloquear la membresía activa revoca la sesión en la siguiente petición (401 `AUTH_SESSION_REVOKED`).
- **Filtros** de las pantallas (`status`, `destinationType`, `harvestBatchId`, `restStatus`, `processType`, `varietyName`, `isDoEligible`, `isActive`, `harvestYear`, `phytosanitaryStatus`, `productType`, `isAnchoredOnChain`, `search`…) y `limit`/`offset` (por defecto 20/0; `limit` > 100 → 422).
- **Validación** de cuerpos y parámetros con los esquemas de alta (**422** `VALIDATION_ERROR`, `details: [{ field, message }]`) y, desde 0.5, las **reglas de la trazabilidad** (409/422 `TRC_…` con `details[{ code, rule, expected, actual, meta }]`; ver «Ola 2»). JSON mal formado → 400 `BAD_REQUEST`. También 404 y 409 documentados.
- **Mutaciones** en memoria: lo que se crea aparece en las listas durante la sesión; ids UUID v5 deterministas (`mock:<recurso>:<n>`) y reloj fijo que empieza el 2026-09-25 a las 12:00 UTC y avanza un minuto por alta (una escritura rechazada no lo avanza). `advanceMockClock(ms)` lo adelanta: así se cumplen los candados de crianza y de reposo. `resetErpDb()` vuelve al estado inicial.
- `POST /v1/uploads` (multipart, solo personal; PDF ≤ 15 MB, JPEG/PNG/WEBP/GIF ≤ 5 MB, tipo reconocido por el contenido) guarda la clave privada `org/<organización>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>` y devuelve una URL firmada de 15 min (`expiresAt`); `GET /v1/uploads/url?key=` da una nueva. La respuesta lleva la huella `sha256` del contenido, que el dictamen y el laboratorio guardan junto a la `key`. `GET /v1/traceability/public/:lotCode` y `GET /v1/traceability/dag/:id` (el grafo DAG legado) se retiraron en el cierre H2: las sustituyen `GET /v1/public/passports/{code}` y `GET /v1/lots/{id}/graph`. Las rutas de 0.1 retiradas en H1 (`POST /wineries`, `wineries/pending|approve|reject`, `wineries/my/members*`) responden 404, como el backend; `signup` solo registra consumidores.
- **Bodega no activa** (Ola 1 §4): con la bodega activa `INVITED`, `SUSPENDED` o `REVOKED`, las rutas del ERP responden 403 `ORG_NOT_ACTIVE` (`details[0].message` = estado); en `SUSPENDED` se lee el perfil y la bitácora propia.
- Mensajes de validación en español; errores con los códigos del backend (`INTERNAL_ERROR`, `FERMENTATION_TANK_ALREADY_TRANSFERRED`…) y los del contrato de cada ola.

### Ola 1 (`plan/contratos/o1-backoffice-y-bodegas.md`)

- **Segundo factor**: el login del personal de plataforma devuelve `{ mfa: { required, enrolled, mfaToken } }` → `/v1/auth/mfa/verify` (TOTP, código de recuperación o el atajo de los mocks `000000`) o `/v1/auth/mfa/enroll` + `/enroll/confirm`. Usa `isMfaChallenge(data)` para distinguirlo de una sesión.
- **Cuenta**: `forgot-password`/`reset-password` (enlace en el buzón), `verify-email`, `resend-verification`, `POST /v1/users/me/password`, preferencias en `PATCH /v1/users/me`.
- **Invitaciones** (aceptar con cuenta nueva o existente, reenviar, anular), **solicitudes** (público con captcha y campo trampa → verificar → tomar → notas → reunión → aprobar/rechazar), **bodegas** (alta directa, directorio, ficha, suspender, reactivar, revocar, transferir, perfil público), **equipo** (dueño y back office, `blockedBy`, límite de colaboradores), **usuarios internos** y **matriz de permisos**, **configuración** (estándar, ajustes por bodega, masivo, volver al estándar, historial, mínimos legales con excepción), **bitácora** (filtros, CSV, verificación de la cadena, la del dueño) y **tablero**.
- Las acciones del back office sobre terceros exigen `reason` (422 con `details[{ field: 'reason' }]`); toda escritura deja un evento encadenado por hash con la app de `X-Client-App`.
- El estado vive en memoria y, en el navegador, en `localStorage` (`doc-mocks:state`), así el recorrido solicitud → aprobación → invitación → activación sobrevive a una recarga. Cada app tiene su propio estado; los enlaces de invitación que emiten los mocks funcionan también en otra app (se importan). `advanceMockClock(ms)` adelanta el reloj (caducidades). Decisiones y datos de demo: [docs/CONTRATO.md §6](docs/CONTRATO.md).

### Ola 2 · ERP v2 y dominio público (`plan/contratos/o2-erp-confiable.md`, estable en 0.5.0)

- **Lote** (`/v1/lots`): se crea solo (`POST /v1/lots`) o con el primer pesaje (`newLot`); lleva la **instantánea de reglas** de la bodega (un cambio posterior en el back office no le afecta), su etapa derivada (`ORIGIN`, `HARVEST`, `FERMENTING`, `AGING`, `DISTILLING`, `RESTING`, `BOTTLED`, `CERTIFIED`, `REJECTED`, `DISCARDED`), candados, D.O. calculada, proyección de botellas e incidencias. Vistas: `…/timeline`, `…/graph`, `…/balance`, `GET /v1/traceability/dashboard` y `…/reports/production` (JSON o `?format=csv`).
- **Reglas en el servidor**, con el motivo en `details[0]` (`code`, `rule`, `expected`, `actual`, `meta`): dictamen fitosanitario aparte del pesaje y bloqueante (`TRC_PHYTO_IN_CREATE`, `TRC_PHYTO_NOT_APPROVED`, `TRC_PHYTO_DECISION_FINAL`), D.O. calculada (`TRC_DO_TERROIR_NOT_ELIGIBLE`, `TRC_DO_NOT_ELIGIBLE`), tanques por acciones (`…/start`, `…/complete`, `…/clean`), crianza y destilación solo desde un tanque completado (`TRC_TANK_NOT_COMPLETED`), crianza mínima (`TRC_AGING_BELOW_MINIMUM`; Altos fija 6 meses), candados (`TRC_LOCK_NOT_RELEASED` con `meta.unlockDate` y `meta.daysRemaining`), balance del embotellado (`TRC_BOTTLING_EXCEEDS_VOLUME`, `TRC_ALCOHOL_BALANCE_EXCEEDED`, `TRC_BOTTLING_LOSS_ABOVE_TOLERANCE`), un embotellado por lote (`TRC_LOT_ALREADY_BOTTLED`) y fechas coherentes (`TRC_DATE_IN_FUTURE`, `TRC_DATE_BEFORE_PREVIOUS_STAGE`). `POST /v1/lots/{id}/bottling/preview` devuelve el balance y las infracciones sin escribir.
- **Códigos de botella**: uno por botella (8 caracteres con control), `GET /v1/lots/{id}/bottle-codes` (filtros `status`, `fromSerial`, `toSerial` y búsqueda `q`), CSV de los códigos activos (`…/export`: UTF-8 con BOM, CRLF) y ZIP (`…/exports`: `PENDING` → `READY` en la segunda consulta, como máximo 20.000 códigos, descargable), `POST /v1/bottle-codes/{code}/void` (con o sin sustituto). La plataforma solo los lista (administración y operaciones).
- **Laboratorio** (`POST /v1/lots/{id}/lab-analyses`): conformidad calculada con los límites de la instantánea; un reanálisis sustituye al anterior. **Correcciones** compensatorias (`…/corrections`): el recurso devuelve el valor vigente con `correctedFields`, `voided` y `correctionIds`; un registro anulado se devuelve marcado y deja de contar. **Adjuntos** (`…/attachments`) y **expediente** (`…/dossier/preview`, `…/close`, `…/canonical`): al cerrarlo el lote queda `CERTIFIED`, con su huella SHA-256 (`doc-dossier/1`, `CanonicalDossierSchema`) y la raíz Merkle de los códigos; después, laboratorio, correcciones y archivos responden 409 `TRC_DOSSIER_CLOSED` y el resto de escrituras, `TRC_LOT_TERMINAL`.
- **Plataforma**: solo lee la trazabilidad (`?wineryId=`); cualquier escritura → 403 `TRC_PLATFORM_READ_ONLY`.
- **Público** (sin sesión): `GET /v1/public/passports/{code}` (código de botella o de lote), `/public/lots/{lotCode}`, `/public/bottles/{code}`, `/public/lots/{lotCode}/dossier` (bytes canónicos: su SHA-256 es la huella), `/public/lots/{lotCode}/attachments/{id}` (302) y `GET /v1/public/wineries`. Código inexistente → 404 `PUB_CODE_NOT_FOUND`; mal formado → 422 `PUB_CODE_MALFORMED`; más de 20 inexistentes en 10 min desde una IP → 429 `PUB_TOO_MANY_LOOKUPS` con `Retry-After`; un código anulado responde con `bottle.status: 'VOIDED'`. `ETag` con `If-None-Match` → 304. La prueba de una botella se comprueba con `verifyMerkleProof(merkleLeaf({ serial, code, salt }), path, raíz)`, con la raíz de `bottleCodes.merkleRoot` de los bytes del expediente.
- **Catálogo (BORRADOR)**: `GET /v1/public/collections` (filtros `productType`, `winery`, `status`, `q`, `featured`; `sort=featured|newest|price-asc|price-desc|name`) y `/{slug}` no están en el OpenAPI del backend; responden `X-Mock-Draft` y pueden cambiar (contrato §17.1). Úsalos solo para la pantalla 2A del Marketplace.
- **Datos**: 21 lotes en todas las etapas. El caso del contrato §18 es «Singani Gran Reserva 2026» de la Destilería Cinti Viejo (`SINGANI_CASE`; código de lote `CVJ-2026-SINGANI-004`, 2.950 botellas, expediente cerrado). `PASSPORT_CASES` da un código de lote para cada caso del visor: certificado, sin laboratorio, laboratorio no conforme, D.O. por excepción, registro tardío, lote retirado y bodega suspendida. Códigos de botella de muestra en `publicFixtures.bottleCodes`. La trazabilidad vive solo en memoria: recargar la página vuelve a los fixtures.
- **Campos retirados** (cierre H2): enviar uno de `RETIRED_INPUT_FIELDS` responde 422 `VALIDATION_ERROR` en ese campo («property … should not exist»), como el backend.
- Diferencias con el contrato escrito, decisiones y datos de demo: [docs/CONTRATO.md §10, §11 y §12](docs/CONTRATO.md). Lo que cambia para el ERP de la Ola 1 y lo retirado en H2: [CHANGELOG](CHANGELOG.md).

```ts
import { advanceMockClock, setScenario, SINGANI_CASE } from '@drinks-on-chain/mocks/handlers'

setScenario('lote-en-reposo')        // el lote de demostración, a 10 días de cumplir el reposo
advanceMockClock(10 * 86_400_000)    // pasan los 10 días: ya se puede embotellar SINGANI_CASE.lotId
```

### Ola 3 · tokenización y cadena (`plan/contratos/o3-tokenizacion.md`, pre-release 0.6.0-rc.1)

Las 54 rutas de la apertura de la Ola 3, con sus reglas y una red simulada (detalle, diferencias con el contrato escrito y suposiciones en [`docs/CONTRATO.md`](docs/CONTRATO.md) §13):

- **ERP**: `GET /v1/lots/{id}/tokenization` (límite y bloqueos), solicitudes (`POST /v1/lots/{id}/tokenization-requests`, editar, reenviar, retirar; solo el dueño y con `Idempotency-Key`), colecciones, NFT y cierre de la bodega, y `GET /v1/organizations/current/chain-account`. `LotSummary.tokenization` lleva la marca del lote.
- **Back office**: bandeja (`/v1/platform/tokenization-requests`: tomar, notas, datos y precio, pedir cambios, aprobar, rechazar), colecciones (publicar, pausar, reanudar, cerrar, NFT, transacciones, métricas), cierre con faltante, y cadena (`/v1/platform/chain/*`: transacciones con reintento y abandono, cuentas, eventos, conciliaciones, alertas; identidad de cada bodega con `provision`, `pause` y `unpause`).
- **Público**: registro, `stellar.toml`, verificación del anclaje, metadatos del NFT e imágenes.

```ts
import { mockChain } from '@drinks-on-chain/mocks/node' // o /handlers; en el navegador, window.__docMocks.chain

// Una transacción recorre PENDING → BUILDING → SUBMITTED → CONFIRMED: tres pasos de mockChain.stepMs.
mockChain.advance()                       // un paso
mockChain.settle()                        // hasta que no quede nada en vuelo
mockChain.failNext({ kind: 'MINT_BATCH' }) // la siguiente emisión falla (CHN_AUTH_FAILED): se reintenta desde el back office
mockChain.failNext({ code: 'CHN_RPC_UNAVAILABLE' }) // transitorio: RETRYING y se confirma sola
mockChain.setMode('manual')               // en el navegador avanza sola ('auto'); en Node, solo con estos controles
```

En el navegador la red avanza con el tiempo real (un paso, como mucho, entre dos peticiones): con el `refetchInterval` de 5 s de las pantallas, una emisión se confirma en unas tres consultas. `advanceMockClock(ms)` también la adelanta.

Las direcciones (`G…`, `C…`) y los hashes de los fixtures tienen **forma válida** (StrKey con su CRC; `isValidStrKey`) y **no existen en testnet**. Los `explorerUrl` los construyen los mocks, como el backend: la app nunca escribe el host del explorador.

**Borrador del Marketplace** (contrato §13.1, fuera del OpenAPI, cabecera `X-Mock-Draft`): `GET /v1/me/consumer`, `POST /v1/orders`, `GET /v1/orders`, `GET /v1/orders/{id}` y `POST /v1/payments/test/{paymentId}/simulate` (`APPROVE`, `REJECT`, `DELAY`). Puede cambiar con el contrato de la Ola 4.

### Lista de espera (`plan/contratos/o1b-lista-de-espera.md`, desde 0.4.1)

- **Pública**: `POST /v1/public/waitlist` (`type: CONSUMER` con `isAdult: true`, o `WINERY` con `wineryName`) → 201 `{ type, position }` (número de orden dentro de su tipo). Un correo ya inscrito en ese tipo recibe la misma posición (no se duplica; solo completa teléfono, ciudad y región vacíos); el campo trampa `website` relleno → 201 sin guardar nada; más de 3 inscripciones por hora del mismo correo → 429 `TOO_MANY_REQUESTS` con `Retry-After`; 422 `VALIDATION_ERROR` con un detalle por campo y los mensajes del backend. `GET /v1/public/waitlist/stats` → `{ consumers, wineries }`.
- **Back office**: `GET /v1/platform/waitlist` (filtros `type`, `status`, `source`, `q`, `from`, `to`, `limit`, `offset`; más reciente primero), `GET /v1/platform/waitlist/sources` (arreglo plano `{ source, count }[]`; `null` = sin origen; `?type=`), `PATCH /v1/platform/waitlist/{id}` (`{ status?, notes? }`: `CONTACTED` guarda `contactedAt` y `contactedBy`, `NEW` los borra, `notes: null` borra las notas) y `GET /v1/platform/waitlist/export` (CSV UTF-8 con BOM, CRLF, celdas protegidas contra fórmulas y `Content-Disposition: attachment; filename="lista-de-espera-AAAAMMDD-HHMM.csv"`; columnas = `WAITLIST_CSV_COLUMNS`).
- **Permisos** (capacidad `waitlist` de la matriz): leen `SUPERADMIN`, `ADMIN`, `OPERATIONS` y `SUPPORT`; cambian el estado, las notas y exportan `SUPERADMIN`, `ADMIN` y `OPERATIONS` (soporte → 403 `AUTH_INSUFFICIENT_PERMISSIONS`).
- **Tablero**: `GET /v1/platform/dashboard` añade `waitlist: { consumers, wineries, last24h }`.
- **Datos**: 52 inscripciones en `backofficeFixtures.waitlist` (38 consumidores, 14 bodegas; orígenes `tarija-2026`, `instagram`, `boletin`, `qr-cata` y sin origen; estados `NEW`, `CONTACTED`, `DISCARDED`). Diferencias con el contrato escrito y decisiones: [docs/CONTRATO.md §9](docs/CONTRATO.md).

### Buzón simulado

Los correos que el backend enviaría (invitaciones, verificación, recuperación, avisos) se guardan en un buzón, como Mailpit:

```ts
import { mockMailbox } from '@drinks-on-chain/mocks/handlers' // o /browser, /node

const mail = mockMailbox.latest({ to: 'duena@soldepadcaya.test', template: 'INVITATION' })
mail?.link   // http://localhost:3002/invitacion/<token>
mail?.token  // el token del enlace
mockMailbox.list()  // todos, los más recientes primero
```

Las URL base de las apps se cambian con `setMockAppUrls({ ERP: 'https://…' })` o la opción `appUrls` de `startMockWorker`/`setupMockServer`. En el navegador, `startMockWorker` publica `window.__docMocks` (`mailbox`, `reset`, `advanceClock`, `getScenario`, `setScenario`) para el panel `/__mocks` y las e2e (`page.evaluate(() => window.__docMocks.mailbox.latest({ to }))`).

Todas las colecciones responden `data: { items, total, limit, offset }` (contrato §2). La forma vive solo en `src/shared/list.ts`; `unwrapList(data)` sigue aceptando un array plano por si hay que hablar con un backend anterior al contrato.

## Escenarios

| Nombre | Efecto |
|---|---|
| `normal` | Por defecto |
| `empty` | Las listas vuelven vacías |
| `error` | 500 `INTERNAL_ERROR` con envoltorio en todas las rutas salvo `/v1/auth/*` |
| `slow` | +2,5 s por respuesta |
| `offline` | Error de red |
| `lote-en-reposo` | Datos: «Singani Gran Reserva 2026» en reposo, faltan 10 días (embotellar → `TRC_LOCK_NOT_RELEASED`) |
| `lote-listo` | Datos: el mismo lote con el reposo cumplido, listo para la vista previa y el embotellado |
| `laboratorio-no-conforme` | Datos: el lote embotellado con un análisis no conforme (el expediente no se puede cerrar) |
| `lote-con-incidencia` | Datos: `CVJ-2026-SINGANI-002` con una incidencia de migración abierta |
| `pasaporte-saturado` | Las rutas del pasaporte público responden 429 `TOO_MANY_REQUESTS` con `Retry-After` (límite de 60 consultas por minuto) |
| `identidad-preparandose` | Datos (Ola 3): Bodega Altos de Calamuchita con su cuenta y su contrato aún creándose (aprobar → `TOK_WINERY_CHAIN_NOT_READY`) |
| `emision-en-curso` | Datos: «Singani Preventa 2026» recién aprobada, con la emisión de sus 100 NFT avanzando en la red |
| `emision-fallida` | Datos: la misma con la emisión `FAILED` y su alerta; reintentarla desde el back office la confirma |
| `anclaje-pendiente` | Datos: «Singani Gran Reserva 2026» `CERTIFIED` con el anclaje en la red (en `normal` ya está `ANCHORED`) |
| `faltante-botellas` | Datos: «Singani El Portillo 2025» con 20 NFT más que botellas: cierre con faltante sin decidir |
| `alerta-evento-inesperado` | Datos: alerta `CRITICAL` `UNEXPECTED_EVENT` en el contrato de Cinti Viejo |
| `cambios-pedidos` | Datos: «Singani Preventa 2026» con cambios pedidos por operaciones (editar y reenviar) |

La lista crece con las olas: para un panel usa `SCENARIOS` y `SCENARIO_DESCRIPTIONS` (o `Partial<Record<ScenarioName, …>>`), no un `Record<ScenarioName, …>` escrito a mano. `lote-en-reposo`, `lote-listo`, `laboratorio-no-conforme`, `lote-con-incidencia` y los siete de la Ola 3 (`CHAIN_SCENARIOS`) son **escenarios de datos** (`DATA_SCENARIOS`): no cambian cómo responde el backend simulado sino en qué etapa está el lote de demostración. Al elegir uno, la trazabilidad se rehace desde los fixtures (lo creado en la sesión se descarta; la identidad y el back office, no); `normal` deja el lote certificado.

Se eligen con `setScenario('empty')` (se guarda en `localStorage`), con `?mock=empty` en la URL o volviendo al valor por defecto con `resetScenario()`. La latencia normal es de 200–400 ms en el navegador y 0 en Node (`latency` en las opciones la cambia).

## Usuarios de demo

Contraseña de todos: `demo1234` (para contraseñas nuevas, `DEMO_NEW_PASSWORD` = `vendimia-2026`). Para un panel "cambiar de usuario" usa `demoUsers` (email, `role` en la organización activa, membresías, organización activa, rol de plataforma, TOTP, contraseña y token estático). Membresías: el personal interno pertenece a la organización de plataforma con su rol; el resto, a su bodega con el `memberRole` indicado.

**Personal interno (segundo factor obligatorio).** Secreto TOTP de demo: `DRINKSONCHAINDEMOTOTPKEY` (`DEMO_TOTP_SECRET`; genera el código con `generateTotp(DEMO_TOTP_SECRET)` o en una app de autenticación); atajo solo de los mocks: `000000`.

| Email | Nombre | Rol de plataforma | TOTP | Clave |
|---|---|---|---|---|
| `gestor@drinksonchain.test` | Ana Gutiérrez | `SUPERADMIN` | Inscrito | `admin` |
| `administracion@drinksonchain.test` | Jorge Salinas | `ADMIN` | Inscrito | `bo_admin` |
| `operaciones@drinksonchain.test` | Valeria Méndez | `OPERATIONS` | Inscrito | `operaciones` |
| `soporte@drinksonchain.test` | Pablo Rivera | `SUPPORT` | Inscrito | `soporte` |
| `analista@drinksonchain.test` | Camila Torrez | `OPERATIONS` | Sin inscribir | `analista` |

**Bodegas y personas**:

| Email | Nombre | Rol en la bodega | Bodega | Clave |
|---|---|---|---|---|
| `admin@altos.test` | Martín Calamuchita | `OWNER` | Bodega Altos de Calamuchita | `altos_admin` |
| `enologa@altos.test` | Lic. Carla Villarroel | `ENOLOGIST` | Bodega Altos de Calamuchita | `altos_enologa` |
| `agronomo@altos.test` | Ing. Diego Paredes | `AGRONOMIST` | Bodega Altos de Calamuchita | `altos_agronomo` |
| `operario@altos.test` | Mario Quispe | `OPERATOR` | Bodega Altos de Calamuchita | `altos_operario` |
| `admin@cintiviejo.test` | Rosa Camargo | `OWNER` | Destilería Cinti Viejo | `cvj_admin` |
| `enologa@cintiviejo.test` | Lic. Lucía Rojas | `ENOLOGIST` | Destilería Cinti Viejo | `cvj_enologa` |
| `agronomo@cintiviejo.test` | Ing. Tomás Flores | `AGRONOMIST` | Destilería Cinti Viejo | `cvj_agronomo` |
| `operario@cintiviejo.test` | Rubén Flores | `OPERATOR` | Destilería Cinti Viejo | `cvj_operario` |
| `gerencia@guadalquivir.test` | Elena Vaca | `OWNER` | Viñedos del Guadalquivir (`INVITED`) | `vgq_admin` |
| `maria@tribu.test` | María Fernández | — | — | `maria` |
| `carlos@tribu.test` | Carlos Mamani | — | — | `carlos` |
| `cajero.lacava@drinksonchain.test` | Juan Pérez | — | — (sin membresía hasta la Ola 5) | `juan_pos` |
| `sofia@aramayo.test` | Lic. Sofía Aramayo | `ENOLOGIST` · `OWNER` | Bodega Altos de Calamuchita (activa) · Casa Uriondo (suspendida) | `sofia` |
| `ines@salazar.test` | Ing. Inés Salazar | `AGRONOMIST` · `OPERATOR` bloqueada (por el dueño) | Destilería Cinti Viejo (activa) · Bodega Altos de Calamuchita | `ines` |
| `contabilidad@cintiviejo.test` | Lic. Verónica Quiroga | `ACCOUNTANT` bloqueada (por la plataforma) | Destilería Cinti Viejo | `cvj_contable` |
| `hugo@valleescondido.test` | Hugo Ortega | `OWNER` | Bodega Valle Escondido (`REVOKED`) | `valle_admin` |

## Regenerar los fixtures

```bash
pnpm seed          # escribe fixtures/erp/*.json, fixtures/backoffice/*.json y fixtures/public/*.json
pnpm seed:check    # igual, y falla si queda algún cambio sin commitear
```

Los de la Ola 1 (`src/backoffice/seed/generate.ts`) parten de los del ERP (mismas bodegas, personas y fechas) y solo existen en TypeScript: la referencia de Python cubre el ERP, y `test/backoffice-fixtures.test.ts` valida los nuevos (esquemas estrictos, coherencia y bitácora encadenada).

El generador es un puerto exacto de `generate.py` (docs/mocks/erp): Mersenne Twister compatible con `random.Random` de CPython, `round()` de Python y UUID v5. `test/seed.test.ts` exige que la salida sea igual, objeto a objeto, a la de Python guardada en `test/reference/erp/`. Si cambias el modelo:

1. Cambia `test/reference/erp/generate.py` y ejecútalo (`python test/reference/erp/generate.py`) para regenerar la referencia.
2. Aplica el mismo cambio en `src/erp/seed/generate.ts` y ejecuta `pnpm seed`.
3. `pnpm test` debe pasar (la CI repite ambos pasos y exige que no queden diferencias).

Desde 0.5 ese generador produce las **filas base** (los registros anteriores a la migración de la Ola 2, iguales a los de Python). Los lotes, la línea de tiempo, los dictámenes, los códigos de botella, las correcciones y el expediente los añade `src/erp/seed/trace.ts` (solo TypeScript) ejecutando los mismos servicios que los handlers: la migración (un lote por pesaje, con el mismo UUID v5 que la semilla del backend) y los lotes de demostración de `src/erp/trace/demo.ts`. Así los fixtures cumplen las reglas por construcción. `fixtures/public/` se deriva de ellos (`src/public/seed.ts`).

## Desarrollo

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm openapi:pull -- <url|ruta>   # copia un OpenAPI 3 a openapi/erp.json y resume las operaciones nuevas o retiradas
```

`pnpm test` incluye la **prueba de contrato** (`test/contract.test.ts`, [docs/CONTRATO.md §5](docs/CONTRATO.md)): cada `RouteSpec` existe en `openapi/erp.json` o está adelantada en `openapi/pendientes.json` con su referencia al contrato de ola (hoy, solo las dos del borrador del catálogo, marcadas `borrador`), y cada fixture y cada respuesta de ejemplo valida con Ajv, en modo estricto, contra el esquema del OpenAPI.

Estructura:

```
openapi/erp.json          OpenAPI del backend (fuente de verdad; pnpm openapi:pull)
openapi/pendientes.json   lo que adelanta un contrato de ola y el OpenAPI aún no tiene
scripts/openapi-pull.mjs  pnpm openapi:pull
src/index.ts              entrada raíz (sin msw)
src/shared/               envoltorio, forma de listas, escenarios, fechas, UUID v5, SHA-256, TOTP
src/erp/schemas/          zod por recurso (respuesta + alta/edición)
src/erp/seed/             generador determinista (pnpm seed)
src/erp/trace/            reglas de la trazabilidad (Ola 2): servicios puros, sin msw
src/erp/handlers/         MSW: base en memoria, sesión, roles, rutas y archivos de /mocks/uploads
src/backoffice/schemas/   zod de la Ola 1 (entrada raíz)
src/backoffice/seed/      fixtures de la Ola 1 (pnpm seed)
src/backoffice/handlers/  rutas de la Ola 1 y de la lista de espera, buzón y bitácora
src/public/               dominio público (Ola 2): pasaportes, directorio y borrador del catálogo
src/{marketplace,pos}/    dominios futuros
fixtures/erp/             JSON generados (se publican en el paquete)
fixtures/public/          pasaportes, códigos de muestra, bodegas y colecciones (Ola 2)
fixtures/backoffice/      JSON de la Ola 1 y de la lista de espera
test/reference/erp/       salida de Python y generate.py de referencia
```

## Publicar una versión

1. Sube `version` en `package.json` y añade la entrada en `CHANGELOG.md` (en `dev`, PR a `main`).
2. En `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. Pre-release: con `version` = `X.Y.Z` (o `X.Y.Z-rc.N`) en `dev` y la CI verde, `git tag vX.Y.Z-rc.N` sobre `dev`; `release.yml` empaqueta el tarball como `X.Y.Z-rc.N`.
3. `release.yml` prueba, construye, ejecuta `pnpm pack` y crea la GitHub Release con `drinks-on-chain-mocks-<versión>.tgz` (marcada como pre-release si la versión lleva guion).
4. En cada app, actualiza la URL del tarball y ejecuta `pnpm install` (y `pnpm exec msw init public` si cambió msw).
