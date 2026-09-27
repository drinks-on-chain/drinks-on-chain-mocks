# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones [SemVer](https://semver.org/lang/es/).

## [0.2.0] · 2026-09-27

Contrato de la Ola 0 (`plan/contratos/o0-sesiones-y-estandares.md`): sesiones con organización activa, listas y errores estándar, prueba de contrato. Se publica primero como pre-release `0.2.0-rc.1` desde `dev`.

### Añadido

- **Organizaciones y membresías**: `Membership`, `OrganizationType`, roles de plataforma (`SUPERADMIN`, `ADMIN`, `OPERATIONS`, `SUPPORT`), de bodega y de punto de canje, `MembershipStatus`, `Audience` y sus esquemas zod. `deriveMemberships`/`pickActiveOrganizationId` en los handlers; el `PLATFORM_ADMIN` es `SUPERADMIN` de la organización de plataforma.
- **Sesión**: `SessionResponseSchema` (`{ user, memberships, activeOrganizationId, tokens }`), `MeResponseSchema`, `AccessTokenClaimsSchema`, `SwitchOrganizationSchema`. Acceso de 15 min con forma de JWT; renovación rotativa con cookie `doc_rt` (`HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS) y detección de reutilización (`AUTH_REFRESH_REUSED`); revocación (`AUTH_SESSION_REVOKED`) al bloquear persona o membresía activa.
- Operaciones adelantadas: `POST /v1/auth/switch-organization`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`.
- Handlers: `resetSessions()`, `expireAccessTokens()` (simula 15 min), `REFRESH_COOKIE`, `ERP_ROUTE_SPECS`, `SAME_ORIGIN_API_PREFIX`. Las sesiones sobreviven a una recarga (`localStorage` `doc-mocks:sessions`).
- **Rutas independientes de la base** (P-1): cada handler responde en `${baseUrl}/v1/*` y en `/api/v1/*` de cualquier origen; el `path` del envoltorio es siempre `/v1/*`. `baseUrl` tolera barra final y `/v1` final. `X-Correlation-ID` en todas las respuestas.
- Usuarios de demo con varias membresías: `sofia@aramayo.test` (enóloga en Altos, dueña de Casa Uriondo) e `ines@salazar.test` (agrónoma en Cinti Viejo, operaria bloqueada en Altos). `demoUsers` incluye `audience`, `memberships` y `activeOrganizationId`.
- `ListPage<T>`, `listPageSchema`, `MAX_LIMIT`, `ApiErrorDetail`/`ApiErrorDetailSchema`, códigos `AUTH_REFRESH_REUSED`, `AUTH_SESSION_REVOKED`, `ORG_NOT_FOUND`.
- **Prueba de contrato** (`test/contract.test.ts`, Ajv): operaciones ⇄ `openapi/erp.json` + `openapi/pendientes.json`, fixtures y respuestas de ejemplo ⇄ esquemas del OpenAPI.
- `pnpm openapi:pull -- <url|ruta>`.
- `release.yml`: las etiquetas `vX.Y.Z-rc.N` (sobre `dev`) se publican como pre-release.

### Cambiado (rupturas y migración)

- **Listas**: `wineries/pending` y `wineries/my/members` devuelven `{ items, total, limit, offset }` (antes array). `limit` por defecto **20** (antes 50) y máximo **100**: más → 422. *Migración*: leer `data.items` (o `unwrapList`) y paginar; las apps que piden `limit` > 100 (el ERP usa 500) deben pedir páginas de 100 como máximo.
- **Errores**: la validación responde **422** `VALIDATION_ERROR` (antes 400) con `details: [{ field, message }]` (antes cadenas `"campo: mensaje"`); las reglas de negocio 422 llevan el campo que las provoca; el resto de errores lleva `details: null`. Pesaje sin Brix/pH/acidez → `VALIDATION_ERROR` (antes `UNPROCESSABLE_ENTITY`); bruto ≤ tara y archivos rechazados en `/v1/uploads` → 422 (antes 400). `ApiErrorBodySchema.details` pasa a `ApiErrorDetail[] | null`. *Migración*: marcar el campo con `details[].field`.
- **Login y signup**: `user` gana `audience` y la respuesta gana `memberships` y `activeOrganizationId` (aditivo). `tokens.expiresIn` es 900 (antes 604800) y los tokens emitidos ya no son `mock.access.<clave>`, sino de sesión. `user.wineryId`/`memberRole` reflejan la organización activa. *Migración*: renovar a los 15 min (o al 401) contra `/v1/auth/refresh` con `credentials: 'include'`.
- **Refresh**: devuelve la forma del login (antes solo `{ accessToken, refreshToken, tokenType, expiresIn }`) y rota el refresco; reutilizar uno ya rotado revoca la sesión. `RefreshTokenSchema.refreshToken` es opcional. *Migración*: leer `data.tokens` (los clientes de la plantilla y del ERP ya aceptan `data.tokens ?? data`) y guardar siempre el refresco nuevo.
- **`GET /v1/users/me`** devuelve `{ user, memberships, activeOrganizationId }` (antes el perfil suelto). *Migración*: validar con `MeResponseSchema` y leer el perfil en `data.user`. `PATCH /v1/users/me` no cambia.
- **Roles**: se evalúan con la membresía activa. Sin cambios para los usuarios de una sola bodega; `POST /v1/wineries` ya no cambia el rol global del solicitante (SE-01) y `POST /v1/wineries/my/members` reactiva una membresía bloqueada.
- `AuthResponseSchema`/`AuthResponse` son alias de `SessionResponseSchema`/`SessionResponse`; `buildAuthResponse` recibe también las bodegas.
- Fixtures: 16 usuarios y billeteras (+2), miembros nuevos en Altos, Cinti Viejo y Casa Uriondo, `auth-login.json` con la forma de sesión. El resto de fixtures no cambia.

## [0.1.0] · 2026-09-25

Primera versión: dominio ERP.

### Añadido

- Esquemas zod y tipos de los DTO del backend del ERP (respuesta y alta/edición), enumeraciones del OpenAPI, envoltorio de éxito y error, y forma de las listas aislada en `src/shared/list.ts` (`{ items, total, limit, offset }`).
- Fixtures del ERP (`fixtures/erp/*.json`) generados por `pnpm seed`, iguales objeto a objeto a los de `generate.py` (Mersenne Twister compatible con CPython y UUID v5).
- `deriveLotViews` y `deriveRestStatus`: vista derivada "Lote" utilizable con datos reales.
- Handlers MSW de las 45 operaciones del OpenAPI con sesión, roles, multi-tenant, filtros, paginación, reglas 422, mutaciones en memoria y `resetErpDb()`.
- Escenarios `normal`, `empty`, `error`, `slow` y `offline`; usuarios de demo (`demoUsers`).
- Entradas `@drinks-on-chain/mocks`, `/fixtures`, `/handlers`, `/browser` (`startMockWorker`) y `/node` (`setupMockServer`).
- CI y release por etiqueta con el tarball adjunto.
