# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones [SemVer](https://semver.org/lang/es/).

## [0.3.0] · 2026-09-27

Contrato de la Ola 1 (`plan/contratos/o1-backoffice-y-bodegas.md`): back office, alta de bodegas, invitaciones, equipos, configuración en dos niveles, bitácora encadenada, tablero y segundo factor del personal interno; alineación con el OpenAPI del backend de la Ola 0 (O0-BE-2). Se publica primero como pre-release `0.3.0-rc.1` desde `dev`. Detalle de las decisiones en [docs/CONTRATO.md §6](docs/CONTRATO.md).

### Añadido

- **Esquemas zod y tipos** (entrada raíz) de todo el contrato de la Ola 1: `Invitation`/`InvitationPreview`, `WineryApplication` (+ `APPLICATION_STATUSES`, `APPLICATION_TRANSITIONS`), `WinerySummary`/`WineryDetail`/`PublicWineryProfile`, `Member`/`PlatformUser`/`UserAccountStatus`, `SettingDefinition`/`SettingOverride`/`SettingHistoryEntry`/`EffectiveSetting`, `AuditEvent` (+ `AuditVerifyResult`), `Dashboard`, `PermissionMatrix`, las respuestas del segundo factor (`MfaChallenge`, `LoginResponse` = sesión o reto, `MfaEnrollResponse`, `MfaEnrollConfirmResponse`, `isMfaChallenge`) y los cuerpos de todas las rutas (con `reason` de 3 a 500 caracteres donde el contrato lo exige).
- **64 operaciones nuevas** en los handlers (cuenta y TOTP, invitaciones, solicitudes, bodegas, equipo, usuarios internos, permisos, configuración, bitácora con exportación CSV y verificación, tablero), con el estado en memoria y, en el navegador, en `localStorage` (`doc-mocks:state`) para que los flujos sobrevivan a una recarga. Todas admiten los escenarios `normal/empty/error/slow/offline`.
- **Segundo factor (TOTP)** del personal de plataforma: el login responde `{ mfa: { required, enrolled, mfaToken } }`; `mfa/verify` (TOTP con la hora real ± 30 s, código de recuperación de un solo uso o el atajo de los mocks `000000`), `mfa/enroll` + `enroll/confirm` (secreto de demo y 10 códigos de recuperación), 5 fallos → 429 con `Retry-After` y aviso por correo; `switch-organization` a la plataforma sin TOTP → 403 `AUTH_MFA_REQUIRED`. `DEMO_TOTP_SECRET`, `MOCK_TOTP_BYPASS_CODE`, `generateTotp`, `verifyTotp`, `otpauthUrl` en `/fixtures`, `/handlers`, `/node` y `/browser`.
- **Buzón simulado** (como Mailpit): `mockMailbox.list({ to, template, since })`, `.latest()`, `.clear()`; correos de invitación, verificación de solicitud y de correo, recuperación, avisos a operaciones y al dueño, cambios de estado y 2FA, con `link` y `token`. `setMockAppUrls()` / opción `appUrls` para las URL de las apps en los enlaces. `startMockWorker` publica `window.__docMocks` (buzón, `reset`, `advanceClock`, escenario) para el panel `/__mocks` y las e2e.
- **Fixtures de la Ola 1** (`fixtures/backoffice/*.json`, `pnpm seed`, exportados en `@drinks-on-chain/mocks/fixtures/backoffice/<archivo>.json` y como `backofficeFixtures`): 9 solicitudes en todos los estados (notas, reuniones, aprobadas y rechazada), 8 invitaciones en los cuatro estados, perfiles de bodega (slug, prefijo de lote, historia pública, historial de estado), miembros bloqueados por el dueño y por la plataforma, TOTP del personal, los 27 parámetros de `docs-back/05` §4 con sus valores por defecto, 6 ajustes por bodega (una excepción legal), historial de configuración, alertas del tablero, 163 eventos de bitácora encadenados por SHA-256 y 13 correos.
- **Personas y bodegas nuevas en los fixtures del ERP** (`generate.py` y `generate.ts`, sin tocar la secuencia aleatoria): Jorge Salinas (`ADMIN`), Valeria Méndez y Camila Torrez (`OPERATIONS`, Camila sin TOTP inscrito), Lic. Verónica Quiroga (contadora de Cinti Viejo bloqueada por la plataforma), Hugo Ortega (dueño de Bodega Valle Escondido, `REVOKED`) y Bodega Sol de Padcaya (`INVITED`, invitación de dueño pendiente). `demoUsers` gana `platformRole` y `mfa`; nuevos `demoStaff` y `DEMO_NEW_PASSWORD` (contraseña de ejemplo que cumple la política nueva).
- `Idempotency-Key` en los 9 POST de alta del ERP, como el backend O0-BE-2: repetición con el mismo cuerpo → la respuesta guardada con `Idempotent-Replayed: true`; otro cuerpo → 409 `IDEMPOTENCY_KEY_REUSED`; clave que no es UUID → 422 `IDEMPOTENCY_KEY_INVALID`.
- Toda escritura de los mocks (también las del ERP) deja una entrada en la bitácora con el actor, la app de origen (cabecera `X-Client-App`), la IP (`X-Forwarded-For`), el `X-Correlation-ID`, antes y después y el motivo.
- `advanceMockClock(ms)`, `createMockHandlers` (alias de `createErpHandlers`), `MOCK_ROUTE_SPECS`, `BACKOFFICE_ROUTE_SPECS`, `CLIENT_APP_HEADER`, `IDEMPOTENCY_KEY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER`, `DEFAULT_APP_URLS`.
- Prueba de contrato: las 64 rutas nuevas están en `openapi/pendientes.json` con su referencia al contrato de la Ola 1 y se validan con el esquema zod del paquete (`{ "$zod": "…" }`, estricto); `enumCambios` para el estado de la bodega. Pruebas nuevas de fixtures, reglas (transiciones, prefijo de lote, límites y mínimos legales, bitácora, TOTP), recorridos de punta a punta y persistencia.

### Cambiado (rupturas y migración)

- **Estado de la bodega**: `certificationStatus` y `Membership.organizationStatus` son `INVITED | ACTIVE | SUSPENDED | REVOKED`; `PENDING` desaparece (Viñedos del Guadalquivir pasa a `INVITED`). *Migración*: tratar `INVITED` donde se trataba `PENDING`. `GET /v1/wineries?status=PENDING` se sigue aceptando como alias y `/v1/wineries/pending` lista las `INVITED`.
- **Bodega no activa en el ERP** (SE-05): con la organización activa en un estado distinto de `ACTIVE`, las rutas del ERP responden 403 `ORG_NOT_ACTIVE` con `details: [{ field: null, message: 'SUSPENDED' | 'REVOKED' | 'INVITED' }]`; en `SUSPENDED` siguen permitidas la lectura del perfil (`GET /v1/wineries/my`, `GET /v1/organizations/current`) y la bitácora propia. Suspender o revocar revoca las sesiones con esa organización activa (401 `AUTH_SESSION_REVOKED`). *Migración*: pantalla de bodega no activa en el ERP.
- **Login del personal de plataforma**: responde 200 **sin tokens** con `{ mfa }`. *Migración*: validar con `LoginResponseSchema`/`isMfaChallenge` y seguir con `/v1/auth/mfa/verify` o `/enroll`. Los tokens estáticos `mock.access.<clave>` siguen valiendo sin TOTP (paneles y pruebas).
- **Roles de plataforma**: `soporte@drinksonchain.test` (Pablo Rivera) pasa de `SUPERADMIN` a `SUPPORT`; `gestor@drinksonchain.test` sigue siendo el superusuario.
- **Errores**: el 500 usa `INTERNAL_ERROR` (antes `INTERNAL_SERVER_ERROR`), como el backend. Los mensajes de validación (`details[].message` y los de los parámetros de consulta) están en español con un mapa de errores de zod común ("El correo no es válido", "Debe tener al menos 10 caracteres", "Campo obligatorio"…). `ApiErrorCode` admite cualquier código (el backend puede añadir otros) y `API_ERROR_CODES` lista los de las Olas 0 y 1.
- **ERP alineado con el backend O0-BE-2**: aprobar o rechazar una bodega que no está pendiente → 409 `WINERY_NOT_PENDING`; pasar a crianza una cuba ya transferida → 409 `FERMENTATION_TANK_ALREADY_TRANSFERRED`; balance de masa de la destilación (corazón + descarte > entrada + 5 %) → 422 en `outputVolumeLiters`; embotellado sin origen → 422 con un detalle en `wineAgingBatchId` y otro en `productionBatchId`; mismos mensajes que el backend en bruto ≤ tara y en `/v1/uploads` sin archivo o con un tipo no admitido.
- **OpenAPI**: `openapi/erp.json` actualizado desde el backend (O0-BE-2: listas paginadas, `ErrorDetailDto`, 422). Las listas ya no están en `pendientes.json` → `cambios`: la prueba de contrato las valida contra el OpenAPI real.
- `PATCH /v1/users/me` acepta `notificationPrefs` (parcial) y `promotionsConsent`, que devuelve `GET /v1/users/me` en `user`; su respuesta sigue siendo el perfil (el contrato de la Ola 1 la cambia a `{ user, memberships, activeOrganizationId }`: ver docs/CONTRATO.md §6).
- En el navegador, bodegas, personas, billeteras, reloj y contadores se guardan en `localStorage` (`doc-mocks:state`) tras cada escritura (antes, una recarga los devolvía a los fixtures); los registros de trazabilidad siguen solo en memoria. `resetErpDb()` lo borra.
- Los códigos de lote de una bodega activada en los mocks usan su prefijo de lote.

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
