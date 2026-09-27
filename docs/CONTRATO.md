# Contrato OpenAPI ↔ mocks

Revisión del 25-09-2026, actualizada el 27-09-2026 con el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro, §0 de este documento), el OpenAPI del backend de la Ola 0 (O0-BE-2) y el **contrato de la Ola 1** (`plan/contratos/o1-backoffice-y-bodegas.md`, §6). Comparado contra `openapi/erp.json` (descargado de `https://136.243.223.39.sslip.io/docs-json` el 27-09-2026, igual al `openapi.json` de `drinks-on-chain-back` en `dev`: 35 rutas, 45 operaciones, 41 esquemas) y contra respuestas reales del servidor sin credenciales (401, 400, 404). Complementa el doc 09 §8 de `drinks-on-chain-docsfront`. Regla: donde el catálogo o las guías del backend discrepan del OpenAPI, manda el OpenAPI.

## 0. Contrato de la Ola 0 (mocks 0.2)

Los mocks imitan el contrato de la Ola 0 **antes** de que el backend lo publique (O0-BE-2 y O0-BE-4). Lo que el OpenAPI aún no refleja está en `openapi/pendientes.json` con su referencia al contrato; la prueba de contrato (§5) lo comprueba.

| Tema | Contrato (§) | Mocks 0.2 |
|---|---|---|
| Listas | §2 | Toda colección devuelve `{ items, total, limit, offset }`, `limit` 20 por defecto y 100 como máximo (más → 422), incluidas `wineries/pending` y `wineries/my/members` |
| Errores | §1 | Validación → **422** `VALIDATION_ERROR` con `details: [{ field, message }]` (`field` con puntos: `items.0.quantity`); reglas de negocio → 422 `UNPROCESSABLE_ENTITY` con el campo que las provoca; el resto (400 JSON mal formado, 401, 403, 404, 409, 500) con `details: null`. Códigos nuevos: `AUTH_REFRESH_REUSED`, `AUTH_SESSION_REVOKED`, `ORG_NOT_FOUND` |
| Membresías | §4 | `PLATFORM_ADMIN` → membresía de la organización de plataforma (`Drinks on Chain`) con el rol `_mock.platformRole` (desde 0.3; `SUPERADMIN` si no lo indica); cada `wineryMemberships[i]` → membresía `WINERY` (id = id de miembro; `isActive: false` → `BLOCKED`); `POS_OPERATOR` y consumidores sin membresía. La organización de una bodega es la propia bodega (enlace 1:1) y su estado es `certificationStatus` |
| Login | §5 | `{ user (+ audience, userRole/wineryId/memberRole de compatibilidad), memberships, activeOrganizationId, tokens }`; acceso de 15 min (`expiresIn: 900`) con forma de JWT (`header.payload.mock`, claims `sub`, `aud`, `org`, `orgType`, `role`, `sid`, `jti`, `iat`, `exp` + los de compatibilidad); `refreshToken` en el cuerpo y `Set-Cookie: doc_rt=…; HttpOnly; [Secure;] SameSite=Lax; Path=/; Max-Age=604800` (30 días para consumidores; `Secure` solo con `https:`) |
| Organización activa | §5 | La última usada (se recuerda por persona) si sigue siendo válida; si no, la primera membresía `ACTIVE` de organización no `REVOKED` (plataforma antes que bodega); `null` si no hay |
| Refresh | §5 | Lee la cookie `doc_rt` (petición o almacén de MSW), si no el cuerpo `{ refreshToken }`, y como último recurso el almacén propio de los mocks. Rota siempre y responde como el login. Reutilizar un refresco ya rotado → revoca la sesión y 401 `AUTH_REFRESH_REUSED`; sesión revocada, persona o membresía activa bloqueada → 401 `AUTH_SESSION_REVOKED`. El refresco estático de 0.1 (`mock.refresh.<clave>`) abre una sesión nueva |
| `switch-organization` | §5 | Misma sesión (`sid`), tokens nuevos. Sin membresía → 404 `ORG_NOT_FOUND`; membresía `BLOCKED` u organización `REVOKED` → 403 `FORBIDDEN` (el contrato no fija este caso) |
| `logout` / `logout-all` | §5 | 204 sin cuerpo y `Set-Cookie: doc_rt=; … Max-Age=0`. `logout` identifica la sesión por el acceso o, si ya caducó, por el refresco |
| `GET /users/me` | §5 | `{ user, memberships, activeOrganizationId }`; `user` es el perfil de 0.1 más `audience`. `PATCH /users/me` sigue devolviendo el perfil (el contrato no lo cambia) |
| Revocación inmediata | §5 (IAM-13) | Si la membresía activa pasa a `BLOCKED` o la persona a inactiva, la siguiente petición con ese acceso revoca la sesión (401 `AUTH_SESSION_REVOKED`) |
| Roles | §6 | Se evalúan con el `userRole` **equivalente a la membresía activa** (`OWNER → WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, `OPERATOR`/`ACCOUNTANT → ENOLOGIST`, plataforma → `PLATFORM_ADMIN`). Los usuarios de una sola bodega se comportan como en 0.1 |
| SE-01 | §4 | `POST /wineries/my/members` añade o **reactiva** una membresía y nunca toca el rol global; `POST /wineries` ya no convierte al consumidor en `WINERY_ADMIN` (su rol efectivo sale de la membresía `OWNER`) |
| Rutas | §7 (P-1) | Cada handler responde en `${baseUrl}/v1/...` y en `/api/v1/...` de cualquier origen; el `path` del envoltorio es siempre `/v1/...`. `baseUrl` tolera barra final y `/v1` final |
| Cabeceras | §3 | `X-Correlation-ID`: se devuelve el de la petición o `mock-<n>`. `Idempotency-Key` (desde 0.3, como O0-BE-2): en los 9 POST de alta del ERP, UUID; misma clave y cuerpo → respuesta guardada con `Idempotent-Replayed: true`; otro cuerpo → 409 `IDEMPOTENCY_KEY_REUSED`; no UUID → 422 `IDEMPOTENCY_KEY_INVALID`. Por persona + método y ruta, en memoria |

**Cookie en MSW.** MSW 2 guarda el `Set-Cookie` de una respuesta simulada en su propio almacén (en el navegador, en `localStorage`) y lo adjunta a las peticiones siguientes; en el navegador también intenta escribirlo en `document.cookie`, lo que el navegador ignora por ser `HttpOnly`. Como ese comportamiento depende de la versión de MSW, los handlers guardan además el último `doc_rt` en un almacén propio (`localStorage` `doc-mocks:sessions` en el navegador, memoria en Node) y lo usan si la petición no trae ni cookie ni cuerpo. Las sesiones también se guardan ahí para que recargar la página no cierre la sesión; `resetErpDb()` o `resetSessions()` las borran y `expireAccessTokens()` simula el paso de 15 minutos.

## 1. Resultado de la comparación de DTO

Los 13 fixtures con DTO en el OpenAPI (`WineryResponseDto` y sus miembros, `UserProfileResponseDto`, `WineryMembershipDto`, `WalletResponseDto`, `AuthUserDto`, `AuthTokensDto`, `TerroirResponseDto`, `HarvestBatchResponseDto`, `FermentationTankResponseDto`, `CreateFermentationLogDto`, `CreateEnologicalTreatmentDto`, `WineAgingResponseDto`, `ProductionBatchResponseDto`, `BottlingBatchResponseDto`, `BatchLabAnalysisResponseDto`) coinciden **exactamente** con el OpenAPI: mismos nombres de campo, ningún campo requerido ausente o nulo, ningún campo desconocido, todos los valores de enumeración válidos. **No hubo que cambiar `generate.py`**: la referencia de `test/reference/erp/` es la salida sin modificar del script de `docs/mocks/erp/`.

## 2. Diferencias y huecos del OpenAPI (y qué hacen los mocks)

| # | Tema | OpenAPI / backend | Mocks |
|---|---|---|---|
| 1 | Forma de las listas | **Resuelto en O0-BE-2**: todos los GET de colección declaran `{ items, total, limit, offset }` | Igual (`src/shared/list.ts`); `unwrapList()` sigue aceptando un array plano |
| 2 | Listas declaradas como array | **Resuelto en O0-BE-2**: `wineries/pending` y `wineries/my/members` también son páginas | Igual; ya no están en `openapi/pendientes.json` |
| 3 | Campos nulos | Los opcionales de las respuestas se declaran `type: object` sin `nullable` (efecto de `string \| null` en NestJS), y los opcionales con tipo no declaran `nullable` aunque Prisma devuelva `null` | Se tipan con su tipo real y `nullish()` (`T \| null \| undefined`). La prueba de contrato normaliza el OpenAPI igual (§5) |
| 4 | Respuestas sin esquema | `POST …/logs`, `POST …/treatments`, `GET …/rest-status`, `GET /traceability/dag/:id`, `GET /traceability/public/:lotCode` | Lecturas y tratamientos: DTO de alta + `id`, `fermentationTankId` (+ `recordedByMemberId`). `rest-status`: forma de la guía de pruebas + `mandatoryRestUntil`. Pasaporte: forma del ejemplo de `endpoints.md`. DAG: **propuesta de los mocks** `{ bottlingBatchId, lotCode, nodes[{ id, type, label, date, data }], edges[{ from, to }] }` (esquema `looseObject`), a confirmar |
| 5 | Detalles con relaciones | El catálogo dice que `GET /terroirs/:id` trae los lotes de vendimia, `GET /harvest-batches/:id` los tanques y `GET /fermentation-tanks/:id` lecturas y tratamientos; los DTO del OpenAPI no los declaran | Se añaden como campos **opcionales** `harvestBatches`, `fermentationTanks`, `logs`, `treatments` (`TerroirDetailSchema`, `HarvestBatchDetailSchema`, `FermentationTankDetailSchema`). Sin ellos no hay forma de leer la bitácora de un tanque: confirmar con backend |
| 6 | `GET /v1/wine-aging` | No declara `limit`/`offset` ni filtros (el resto de listas sí) | Acepta `limit`/`offset`; ningún filtro |
| 7 | Esquema de seguridad | Las operaciones usan `JWT-auth`, pero `components.securitySchemes` solo define `bearer` (que usa `POST /v1/uploads`) | Sin efecto en los mocks; avisar a backend (el botón *Authorize* de Swagger puede no aplicarse) |
| 8 | `GET /traceability/public/:lotCode` | Marcado con `JWT-auth` en el OpenAPI; en el servidor responde sin token (404 real, no 401) | Público. Acepta el código de lote (sin distinguir mayúsculas) o el UUID del embotellado |
| 9 | Códigos de error | Verificados: `VALIDATION_ERROR` (400, `details` = lista de mensajes), `BAD_REQUEST` (400, JSON mal formado), `UNAUTHORIZED` (401), `NOT_FOUND` (404, también `Cannot GET /v1/…`). `path` incluye la query | Desde 0.2, lo del contrato de la Ola 0 (§0): `VALIDATION_ERROR` es **422** con `details: [{ field, message }]`; `BAD_REQUEST` (400) queda para el JSON mal formado. Desde 0.3, como el backend O0-BE-2 (`error-codes.ts`): 500 `INTERNAL_ERROR`, 409 `WINERY_NOT_PENDING` y `FERMENTATION_TANK_ALREADY_TRANSFERRED`, 422 `IDEMPOTENCY_KEY_INVALID`, 409 `IDEMPOTENCY_KEY_REUSED`. Mensajes de validación en español (mapa común de zod) |
| 10 | Pesaje sin laboratorio | Brix, pH y acidez son `required` en `CreateHarvestBatchDto` | 422 `VALIDATION_ERROR` con un detalle por campo (`brixDegrees`, `initialPh`, `initialAcidityGl`) |
| 11 | Bruto ≤ tara | 400 "Peso bruto menor o igual a tara" | 422 `VALIDATION_ERROR` en `grossWeightKg` (contrato §1) |
| 12 | Rechazo de bodega | El enum `certificationStatus` no tiene `REJECTED` (el catálogo lo lista como filtro) | `POST …/reject` deja la bodega en `REVOKED` |
| 13 | Alta de usuarios | `SignupDto.userRole` solo admite `CONSUMER` y `WINERY_ADMIN` | Igual. Los miembros creados con `members/create` reciben `userRole` según su `memberRole` (`OWNER → WINERY_ADMIN`; `OPERATOR` y `ACCOUNTANT → ENOLOGIST`, como los operarios de los fixtures) solo como dato de compatibilidad: los permisos salen de la membresía activa |
| 14 | Fechas | Los DTO de alta declaran las fechas como `string` sin formato; las respuestas como `date-time` (el servidor devuelve milisegundos, `…:40.187Z`) | Aceptan `YYYY-MM-DD` o ISO; responden `YYYY-MM-DDTHH:MM:SSZ`. Los esquemas aceptan ambos formatos |
| 15 | `lockUntilDate` | Lo calcula el backend (`startDate` + `plannedMonths`), algoritmo no documentado | `startDate` (hoy por defecto) + meses, día acotado a 28 (como `generate.py`) |
| 16 | Candado y reposo | 422 "El vino se encuentra bloqueado por período de crianza hasta el YYYY-MM-DD"; 422 "reposo inerte < 180 días" | Mismo mensaje para la crianza; el reposo se calcula con `deriveRestStatus` desde `processEndDate` (o el inicio). Comparan con el "hoy" del reloj de los mocks (25-09-2026) |
| 17 | Destilación D.O. | "Validación de altitud D.O. (≥ 1.600 msnm)" en el catálogo | Con `isDoEligible: true`, 422 si la parcela de origen no es apta o está bajo 1.600 m. `mandatoryRestUntil` = fin (o inicio) + 180 días, `restStatus: RESTING` |
| 18 | Estados tras las altas | No documentado (doc 09 §8 puntos 3 y 4) | Crear crianza o destilación **no** cambia el tanque. Embotellar pasa la crianza o la destilación a `BOTTLED` |
| 19 | `qrBatchUrl` | El backend fija `https://drinksonchain.com/trace/batch/{lotCode}` | Fixtures y altas usan la propuesta `https://app.drinksonchain.bo/b/{lotCode}` (doc 09 §8 punto 2) |
| 20 | Código de lote | `{BODEGA}-{AÑO}-{TIPO}-{SEQ}` | La secuencia es por bodega y año (como en los fixtures: `CVJ-2026-WINE-003` sigue a dos singanis) |
| 21 | Conteo de rutas | El doc 09 habla de "35 rutas" | Son 35 rutas y 45 operaciones, incluida `GET /v1/health` (pública), más 3 adelantadas por el contrato de la Ola 0 (`switch-organization`, `logout`, `logout-all`). Hay un handler por operación (lo comprueba `test/contract.test.ts`) |

## 3. Roles aplicados por los handlers

El doc 09 §3 y el catálogo del backend no coinciden en todo; los mocks aplican esta tabla (en `src/erp/handlers/routes/*`). "Miembros" = usuario con bodega activa en el token; el `PLATFORM_ADMIN` (membresía de plataforma activa) lee todo pero solo escribe donde aparece. Los roles de la tabla son el `userRole` equivalente a la membresía **activa** (§0).

| Operación | Roles |
|---|---|
| `users/me*`, `POST /wineries`, `POST /uploads`, `switch-organization`, `logout-all` | Cualquier usuario autenticado |
| `GET /wineries`, `/wineries/pending`, `approve`, `reject` | `PLATFORM_ADMIN` |
| `GET /wineries/my`, `/my/members` | Miembros |
| `PATCH /wineries/my`, `POST /my/members`, `/my/members/create` | `WINERY_ADMIN`, `PLATFORM_ADMIN` |
| `GET /terroirs`, `/terroirs/:id` | `WINERY_ADMIN`, `AGRONOMIST`, `ENOLOGIST` (+ gestor) |
| `POST /terroirs`, `PATCH /terroirs/:id` | `WINERY_ADMIN`, `AGRONOMIST` |
| `GET` listas de vendimia, tanques, crianza, destilación y embotellado (dashboard) | Miembros |
| `GET /harvest-batches/:id`, `/fermentation-tanks/:id` | `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST` (+ gestor) |
| `POST /harvest-batches` | `WINERY_ADMIN`, `AGRONOMIST`, `ENOLOGIST` |
| `PATCH …/phyto-status` | `AGRONOMIST`, `ENOLOGIST` |
| `POST /fermentation-tanks`, `…/treatments`, `/wine-aging`, `/production-batches/distillation`, `/bottling` | `WINERY_ADMIN`, `ENOLOGIST` |
| `POST …/logs` | `WINERY_ADMIN`, `ENOLOGIST`, `POS_OPERATOR` |
| `GET /wine-aging/:id`, `/production-batches/:id` | `WINERY_ADMIN`, `ENOLOGIST` (+ gestor) |
| `GET …/rest-status`, `/bottling/:id`, `/traceability/dag/:id` | Miembros |
| `POST /lab-analyses` | `WINERY_ADMIN`, `ENOLOGIST`, `PLATFORM_ADMIN` |
| `GET /lab-analyses/batch/:id` | `WINERY_ADMIN`, `ENOLOGIST`, `AGRONOMIST`, `PLATFORM_ADMIN`, `CONSUMER` |
| `GET /traceability/public/:lotCode`, `GET /health`, `signup`, `login`, `refresh`, `logout` | Públicas |

Los roles se comprueban con el `userRole` equivalente a la membresía activa (no con `memberRole` directamente): los operarios tienen `memberRole: OPERATOR` y actúan como `ENOLOGIST`.

## 4. Pendiente de confirmar con backend

Puntos 4 (DAG), 5, 7, 8, 12, 13, 15 y 18 de la tabla anterior, además de los 12 puntos del doc 09 §8. Los puntos 1, 2 y 9 los resolvió el OpenAPI de O0-BE-2 (listas, 422 con `details`, códigos). Falta O0-BE-4 (sesión): `switch-organization`, `logout`, `logout-all`, el refresco con la forma del login y `GET /users/me` con membresías siguen adelantados (tabla del §0; en particular: 403 al cambiar a una membresía bloqueada y el refresco estático de 0.1). Todo el §6 (Ola 1) está pendiente de O1-BE-1.

## 5. Prueba de contrato (`test/contract.test.ts`)

1. **Operaciones**: cada `RouteSpec` (ERP + Ola 1, `MOCK_ROUTE_SPECS`) existe en `openapi/erp.json` o está en `openapi/pendientes.json` → `adelantadas` con su referencia a `plan/contratos/o<ola>-…`; cada operación del OpenAPI tiene su `RouteSpec`. Una adelantada que ya aparece en el OpenAPI hace fallar la prueba: hay que quitarla de `pendientes.json`.
2. **Fixtures**: cada fixture del ERP con DTO valida con Ajv contra su esquema del OpenAPI (`users.json` sin `_mock`). Los de la Ola 1 (`fixtures/backoffice/`) aún no tienen DTO en el OpenAPI: los valida `test/backoffice-fixtures.test.ts` con sus esquemas zod (estrictos) y reglas de coherencia.
3. **Respuestas**: cada operación se ejecuta con una petición de ejemplo contra los handlers y `data` valida contra el esquema de respuesta del OpenAPI o, si un contrato de ola lo cambia o lo adelanta, contra el de `pendientes.json`. Ahí, `{ "$zod": "<Esquema>" }` es el esquema zod que exporta el paquete (convertido con `z.toJSONSchema`, sin campos desconocidos), `{ "$page": "zod:<Esquema>" }` su página y `{ "$csv": true }` la exportación `text/csv` de la bitácora. Quedan sin esquema las 5 operaciones del punto 4 de la tabla.
4. **Normalización** del OpenAPI generado por NestJS antes de validar: `{ type: 'object' }` sin propiedades → tipo del `example` y `nullable`; los campos opcionales aceptan `null`; los objetos no admiten campos desconocidos salvo los `camposExtra` de `pendientes.json` (`audience`, `memberships`, `activeOrganizationId` del contrato; `notificationPrefs` y `promotionsConsent` de la Ola 1; los detalles con relaciones del punto 5; los campos de las lecturas y tratamientos guardados del punto 4); `enumCambios` sustituye los valores de una enumeración (el estado de la bodega de la Ola 1). Así un campo renombrado en el backend rompe la prueba.

Para actualizar el OpenAPI: `pnpm openapi:pull -- <url|ruta>` (p. ej. `https://136.243.223.39.sslip.io/docs-json` o el `openapi.json` de `drinks-on-chain-back`), después `pnpm test` y revisar `pendientes.json` y este documento. El 27-09-2026 se trajo el de O0-BE-2 (mismas 45 operaciones; listas paginadas y errores del contrato de la Ola 0 ya declarados).

## 6. Contrato de la Ola 1 (mocks 0.3)

Los mocks imitan `plan/contratos/o1-backoffice-y-bodegas.md` antes de que el backend lo publique (O1-BE-1). Las 64 operaciones nuevas están en `openapi/pendientes.json` → `adelantadas`; el login y `PATCH /users/me`, en `cambios`. Esquemas zod en la entrada raíz (`src/backoffice/schemas/`), rutas en `src/backoffice/handlers/`, fixtures en `fixtures/backoffice/` (`src/backoffice/seed/generate.ts`).

### 6.1 Decisiones de los mocks (lo que el contrato no fija)

| Tema | Contrato | Mocks 0.3 |
|---|---|---|
| Estado de la bodega | §0: `INVITED` sustituye a `PENDING` | `WineryResponseDto.certificationStatus` (ERP) y `Membership.organizationStatus` usan `INVITED`; `?status=PENDING` se acepta como alias en `GET /v1/wineries` (`enumCambios` en la prueba de contrato) |
| `ORG_NOT_ACTIVE` | §4: rutas del ERP con la bodega activa no `ACTIVE`; perfil y bitácora propia permitidos en `SUSPENDED` | Se aplica a las rutas de bodega del ERP y a `/v1/organizations/current/*`. En `SUSPENDED` se permiten `GET /v1/wineries/my`, `GET /v1/organizations/current` y `GET /v1/organizations/current/audit`; en `INVITED` y `REVOKED`, nada. La plataforma no se ve afectada |
| Segundo factor | §1 | TOTP RFC 6238 (SHA-1, 30 s, 6 dígitos) con la **hora real** ± 1 paso; el reto (`mfaToken`) caduca a los 5 min del **reloj de los mocks** (`advanceMockClock`). Código inválido → 401 `AUTH_MFA_INVALID_CODE`; reto caducado o usado → 401 `AUTH_MFA_TOKEN_INVALID`; 5 fallos seguidos → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After: 300`, correo `MFA_FAILED_ATTEMPTS` y reto anulado; `verify` sin inscripción o `enroll` ya inscrito → 409 `CONFLICT`. Inscribir usa siempre el secreto de demo. Aceptar una invitación de plataforma devuelve el reto (forma del login de una persona de plataforma) |
| Atajo `000000` | — | `MOCK_TOTP_BYPASS_CODE` vale como TOTP en `mfa/verify` y `mfa/enroll/confirm`. **Solo existe en los mocks**: úsalo en demos; las e2e deben generar el código con `generateTotp(DEMO_TOTP_SECRET)` |
| Tokens estáticos | — | `mock.access.<clave>` cuenta como sesión con TOTP (paneles y pruebas) |
| Contraseñas nuevas | §1: ≥ 10 caracteres, no comunes | Lista corta de comunes (`1234567890`, `password123`…) y caracteres repetidos; 422 `AUTH_WEAK_PASSWORD` con un detalle por problema. Las contraseñas de los fixtures (`demo1234`) no se revalidan; `DEMO_NEW_PASSWORD` (`vendimia-2026`) cumple la política |
| Captcha | §0: Turnstile | Cualquier `captchaToken` no vacío vale salvo el que contenga `fail` → 422 `CAPTCHA_INVALID` en `captchaToken` |
| Caducidades | §1, §2 | Invitaciones (`invitacion.caducidadHoras`, 72 h), recuperación (60 min) y retos TOTP (5 min) con el reloj de los mocks (empieza el 2026-09-25 12:00 UTC y avanza un minuto por escritura; `advanceMockClock(ms)` lo adelanta) |
| Tokens de invitación | §2: un solo uso, hash guardado | Los de los fixtures son legibles (`demo-invitacion-…`); los que emiten los handlers son "portátiles" (`inv.<base64url>.<firma>`): si otra app (con su propio `localStorage`) abre el enlace, la invitación se importa con su bodega. Las apps no deben leerlos. Reenviar da un token nuevo y el anterior → 404 `INVITATION_NOT_FOUND` |
| Aceptar | §2 | Cuenta existente sin sesión → 401; sesión de otra persona o cuenta nueva con sesión → 403 `INVITATION_EMAIL_MISMATCH`; aceptada o anulada → 409 `INVITATION_NOT_PENDING`; caducada → 422 `INVITATION_EXPIRED`; nueva sin `fullName`/`password` → 422 `VALIDATION_ERROR`. Si ya era miembro (bloqueado o con otro rol) se reactiva con el rol invitado |
| Reenviar / anular | §2 | Reenviar: `PENDING` o `EXPIRED`; anular: `PENDING`; si no, 409 `INVITATION_NOT_PENDING`. Pueden el dueño (bodega `ACTIVE`) y el personal de plataforma (las de plataforma, solo administración); otra organización → 404 |
| Límite de colaboradores | §5 | Miembros activos (dueño incluido) + invitaciones pendientes ≥ `equipo.maxColaboradoresPorBodega` → 422 `ORG_MEMBER_LIMIT_REACHED` en `email`. No cuenta para invitaciones de dueño (alta y transferencia) |
| Solicitudes | §3 | `take` solo desde `RECEIVED`; `notes` en cualquier estado verificado; `reject` solo desde `IN_REVIEW` (diagrama de docs-back/07 §1.2). La lista ordena por fecha descendente; `q` busca en razón social, nombre, NIT, contacto y región |
| Bodegas | §4 | `slug`: nombre comercial sin tildes ni "bodega"; `lotPrefix`: código del catálogo o 3 letras (iniciales de las palabras significativas + letras de la última), 4–5 si está tomado. `PATCH /v1/platform/wineries/{id}` edita también razón social, NIT, categoría y región. `region` filtra por coincidencia parcial. Revocar anula las invitaciones pendientes. Transferir exige bodega `ACTIVE`/`SUSPENDED` con dueño activo; `BLOCKED` deja al anterior como enólogo bloqueado por la plataforma. Transición inválida → 409 `ORG_INVALID_TRANSITION` |
| `by`, `updatedBy` | §3, §4, §6 | Nombre de la persona (no su id); `Sistema` en los hechos anteriores a la Ola 1 |
| Equipo | §5 | El dueño no se cambia ni se bloquea a sí mismo → 403 `ORG_CANNOT_MODIFY_SELF`; `OWNER` no se asigna ni se quita por rol → 403 `ORG_OWNER_ROLE_RESERVED`. Los demás roles leen solo los miembros activos. `/v1/platform/organizations/{id}/…` solo para bodegas (`ORG_NOT_FOUND` si no); invitar desde la plataforma exige bodega `ACTIVE` o `SUSPENDED` |
| Usuarios internos | §5 | `POST /v1/platform/users/{id}/block\|unblock`: con el id de una **membresía** de plataforma bloquea al usuario interno; con el id de una **persona**, la cuenta completa (`UserAccountStatus`). Los pendientes de `GET /v1/platform/users` usan el correo como `fullName` y llevan `invitationId` (propuesta de los mocks) |
| Configuración | §6 | Valores de enumeración en inglés (`BURN`/`EXTEND`/`COMPENSATE`, `DISABLED`/`OPTIONAL`/`REQUIRED`), unidades y límites `min`/`max` propuestos por los mocks; límites de laboratorio de ejemplo (no normativos); `precio.politica` = `null`. Tipo, límites o enumeración → 422 `VALIDATION_ERROR` en `value`; clave desconocida → 404 `SETTING_NOT_FOUND`; `wineryIds: 'ALL'` = bodegas no revocadas. `GET …/overrides` y `…/history` son listas paginadas; `GET /v1/platform/settings` y `/v1/organizations/current/settings`, arrays |
| Bitácora | §7 | `hash` = SHA-256 (hex) del JSON canónico del evento sin `hash` (claves ordenadas, sin espacios; incluye `prevHash`). La app de origen es `X-Client-App` si es válida; si no, `PUBLIC` en rutas públicas sin sesión y `API` en el resto; `ip` de `X-Forwarded-For`, `deviceId` de `X-Device-Id`. También se registran las escrituras del ERP. CSV con cabecera, CRLF y orden cronológico; `from`/`to` aceptan `AAAA-MM-DD` (día completo) o ISO |
| Correos | §10 | En el buzón simulado. Enlaces: ERP `…/invitacion/{token}`, Backoffice `…/invitacion/{token}`, sitio de bodegas `…/unirse/verificar?token=`, recuperación `…/restablecer-contrasena?token=` (en la app de `X-Client-App`), verificación `…/verificar-correo?token=`. URL base por defecto: WEB 3000, ERP 3002, BACKOFFICE 3003, POS 3004, MARKETPLACE 3005 (`setMockAppUrls` o `appUrls`) |
| Respuestas 202 | §1, §3, §5 | `forgot-password`, `resend-verification` y `send-password-reset` → 202 con `data: null` |
| `PATCH /v1/users/me` | §1: responde `{ user, memberships, activeOrganizationId }` | **Sigue respondiendo el perfil** para no romper el ERP antes de O1-ERP-1; acepta `notificationPrefs` (parcial) y `promotionsConsent`, que aparecen en `GET /v1/users/me` → `user`. A decidir por la coordinación al cerrar la ola |
| Persistencia | — | En el navegador, bodegas, personas, billeteras, estado de la Ola 1, reloj y contadores en `localStorage` (`doc-mocks:state`) tras cada escritura; la trazabilidad del ERP sigue en memoria. `resetErpDb()` lo borra; un estado de otros fixtures se descarta |

### 6.2 Datos de demo

Contraseña de todos: `demo1234`. **Secreto TOTP de demo** (base32) del personal inscrito: `DRINKSONCHAINDEMOTOTPKEY` (`DEMO_TOTP_SECRET`; código actual con `generateTotp(DEMO_TOTP_SECRET)`); atajo solo de los mocks: `000000`. Códigos de recuperación de cada persona en `demoStaff[i].mfa.recoveryCodes`.

| Correo | Nombre | Rol de plataforma | TOTP |
|---|---|---|---|
| `gestor@drinksonchain.test` | Ana Gutiérrez | `SUPERADMIN` | Inscrito |
| `administracion@drinksonchain.test` | Jorge Salinas | `ADMIN` | Inscrito |
| `operaciones@drinksonchain.test` | Valeria Méndez | `OPERATIONS` | Inscrito |
| `soporte@drinksonchain.test` | Pablo Rivera | `SUPPORT` | Inscrito |
| `analista@drinksonchain.test` | Camila Torrez | `OPERATIONS` | Sin inscribir (recorrido de inscripción) |

| Dato | Para qué |
|---|---|
| Bodegas: Altos de Calamuchita y Cinti Viejo `ACTIVE` (`ALT`, `CVJ`), Viñedos del Guadalquivir `INVITED` (dueña con cuenta, invitación caducada), Sol de Padcaya `INVITED` (invitación pendiente a una cuenta nueva), Casa Uriondo `SUSPENDED` (`CUR`), Valle Escondido `REVOKED` (`VES`) | `ORG_NOT_ACTIVE` con cada estado; activar con cuenta nueva o existente |
| Invitaciones: `demo-invitacion-padcaya` (dueña, cuenta nueva), `demo-invitacion-guadalquivir` (caducada: reenviar), `demo-invitacion-altos-enologo` (vence en < 24 h), `demo-invitacion-cintiviejo-operario` (de soporte), `demo-invitacion-soporte` (usuario interno), una aceptada y una anulada | Aceptar, reenviar, anular |
| Solicitud sin verificar: token `demo-verificacion-alto-camargo` | `/unirse/verificar` |
| Bloqueos: Inés Salazar en Altos (dueño), Verónica Quiroga en Cinti Viejo (plataforma: el dueño no puede desbloquearla) | Reglas de `blockedBy` |
| Cinti Viejo: `equipo.maxColaboradoresPorBodega` = 6 con 6 ocupados | `ORG_MEMBER_LIMIT_REACHED` |
| Altos: `trazabilidad.singani.altitudMinimaMsnm` = 1500 con excepción legal | A-31 |
