# Contrato OpenAPI ↔ mocks del ERP

Revisión del 25-09-2026, actualizada el 27-09-2026 con el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro, §0 de este documento). Comparado contra `openapi/erp.json` (descargado de `https://136.243.223.39.sslip.io/docs-json`: 35 rutas, 45 operaciones, 38 esquemas) y contra respuestas reales del servidor sin credenciales (401, 400, 404). Complementa el doc 09 §8 de `drinks-on-chain-docsfront`. Regla: donde el catálogo o las guías del backend discrepan del OpenAPI, manda el OpenAPI.

## 0. Contrato de la Ola 0 (mocks 0.2)

Los mocks imitan el contrato de la Ola 0 **antes** de que el backend lo publique (O0-BE-2 y O0-BE-4). Lo que el OpenAPI aún no refleja está en `openapi/pendientes.json` con su referencia al contrato; la prueba de contrato (§5) lo comprueba.

| Tema | Contrato (§) | Mocks 0.2 |
|---|---|---|
| Listas | §2 | Toda colección devuelve `{ items, total, limit, offset }`, `limit` 20 por defecto y 100 como máximo (más → 422), incluidas `wineries/pending` y `wineries/my/members` |
| Errores | §1 | Validación → **422** `VALIDATION_ERROR` con `details: [{ field, message }]` (`field` con puntos: `items.0.quantity`); reglas de negocio → 422 `UNPROCESSABLE_ENTITY` con el campo que las provoca; el resto (400 JSON mal formado, 401, 403, 404, 409, 500) con `details: null`. Códigos nuevos: `AUTH_REFRESH_REUSED`, `AUTH_SESSION_REVOKED`, `ORG_NOT_FOUND` |
| Membresías | §4 | `PLATFORM_ADMIN` → `SUPERADMIN` de la organización de plataforma (`Drinks on Chain`); cada `wineryMemberships[i]` → membresía `WINERY` (id = id de miembro; `isActive: false` → `BLOCKED`); `POS_OPERATOR` y consumidores sin membresía. La organización de una bodega es la propia bodega (enlace 1:1) y su estado es `certificationStatus` |
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
| Cabeceras | §3 | `X-Correlation-ID`: se devuelve el de la petición o `mock-<n>`. `Idempotency-Key` aún no se simula (obligatoria desde la Ola 3) |

**Cookie en MSW.** MSW 2 guarda el `Set-Cookie` de una respuesta simulada en su propio almacén (en el navegador, en `localStorage`) y lo adjunta a las peticiones siguientes; en el navegador también intenta escribirlo en `document.cookie`, lo que el navegador ignora por ser `HttpOnly`. Como ese comportamiento depende de la versión de MSW, los handlers guardan además el último `doc_rt` en un almacén propio (`localStorage` `doc-mocks:sessions` en el navegador, memoria en Node) y lo usan si la petición no trae ni cookie ni cuerpo. Las sesiones también se guardan ahí para que recargar la página no cierre la sesión; `resetErpDb()` o `resetSessions()` las borran y `expireAccessTokens()` simula el paso de 15 minutos.

## 1. Resultado de la comparación de DTO

Los 13 fixtures con DTO en el OpenAPI (`WineryResponseDto` y sus miembros, `UserProfileResponseDto`, `WineryMembershipDto`, `WalletResponseDto`, `AuthUserDto`, `AuthTokensDto`, `TerroirResponseDto`, `HarvestBatchResponseDto`, `FermentationTankResponseDto`, `CreateFermentationLogDto`, `CreateEnologicalTreatmentDto`, `WineAgingResponseDto`, `ProductionBatchResponseDto`, `BottlingBatchResponseDto`, `BatchLabAnalysisResponseDto`) coinciden **exactamente** con el OpenAPI: mismos nombres de campo, ningún campo requerido ausente o nulo, ningún campo desconocido, todos los valores de enumeración válidos. **No hubo que cambiar `generate.py`**: la referencia de `test/reference/erp/` es la salida sin modificar del script de `docs/mocks/erp/`.

## 2. Diferencias y huecos del OpenAPI (y qué hacen los mocks)

| # | Tema | OpenAPI / backend | Mocks |
|---|---|---|---|
| 1 | Forma de las listas | Los GET de colección (`terroirs`, `harvest-batches`, `fermentation-tanks`, `wine-aging`, `production-batches`, `bottling`, `wineries`) no declaran esquema de respuesta | `data: { items, total, limit, offset }`, **confirmado por el contrato de la Ola 0 §2** (`src/shared/list.ts`); `unwrapList()` sigue aceptando ambas formas |
| 2 | Listas declaradas como array | `GET /v1/wineries/pending` y `GET /v1/wineries/my/members` sí declaran `T[]` | Desde 0.2, página `{ items, total, limit, offset }` (contrato §2; en `openapi/pendientes.json`) |
| 3 | Campos nulos | Los opcionales de las respuestas se declaran `type: object` sin `nullable` (efecto de `string \| null` en NestJS), y los opcionales con tipo no declaran `nullable` aunque Prisma devuelva `null` | Se tipan con su tipo real y `nullish()` (`T \| null \| undefined`). La prueba de contrato normaliza el OpenAPI igual (§5) |
| 4 | Respuestas sin esquema | `POST …/logs`, `POST …/treatments`, `GET …/rest-status`, `GET /traceability/dag/:id`, `GET /traceability/public/:lotCode` | Lecturas y tratamientos: DTO de alta + `id`, `fermentationTankId` (+ `recordedByMemberId`). `rest-status`: forma de la guía de pruebas + `mandatoryRestUntil`. Pasaporte: forma del ejemplo de `endpoints.md`. DAG: **propuesta de los mocks** `{ bottlingBatchId, lotCode, nodes[{ id, type, label, date, data }], edges[{ from, to }] }` (esquema `looseObject`), a confirmar |
| 5 | Detalles con relaciones | El catálogo dice que `GET /terroirs/:id` trae los lotes de vendimia, `GET /harvest-batches/:id` los tanques y `GET /fermentation-tanks/:id` lecturas y tratamientos; los DTO del OpenAPI no los declaran | Se añaden como campos **opcionales** `harvestBatches`, `fermentationTanks`, `logs`, `treatments` (`TerroirDetailSchema`, `HarvestBatchDetailSchema`, `FermentationTankDetailSchema`). Sin ellos no hay forma de leer la bitácora de un tanque: confirmar con backend |
| 6 | `GET /v1/wine-aging` | No declara `limit`/`offset` ni filtros (el resto de listas sí) | Acepta `limit`/`offset`; ningún filtro |
| 7 | Esquema de seguridad | Las operaciones usan `JWT-auth`, pero `components.securitySchemes` solo define `bearer` (que usa `POST /v1/uploads`) | Sin efecto en los mocks; avisar a backend (el botón *Authorize* de Swagger puede no aplicarse) |
| 8 | `GET /traceability/public/:lotCode` | Marcado con `JWT-auth` en el OpenAPI; en el servidor responde sin token (404 real, no 401) | Público. Acepta el código de lote (sin distinguir mayúsculas) o el UUID del embotellado |
| 9 | Códigos de error | Verificados: `VALIDATION_ERROR` (400, `details` = lista de mensajes), `BAD_REQUEST` (400, JSON mal formado), `UNAUTHORIZED` (401), `NOT_FOUND` (404, también `Cannot GET /v1/…`). `path` incluye la query | Desde 0.2, lo del contrato de la Ola 0 (§0): `VALIDATION_ERROR` es **422** con `details: [{ field, message }]`; `BAD_REQUEST` (400) queda para el JSON mal formado. No verificados: `FORBIDDEN` (403), `CONFLICT` (409), `UNPROCESSABLE_ENTITY` (422), `INTERNAL_SERVER_ERROR` (500) |
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

Puntos 4 (DAG), 5, 7, 8, 9 (403/409/500), 12, 13, 15 y 18 de la tabla anterior, además de los 12 puntos del doc 09 §8. Los puntos 1, 2, 10 y 11 quedan fijados por el contrato de la Ola 0; hay que verificarlos contra el backend cuando publique su OpenAPI (O0-BE-2/O0-BE-4), igual que la tabla del §0 (en particular: 403 al cambiar a una membresía bloqueada, `PATCH /users/me` y el refresco estático de 0.1).

## 5. Prueba de contrato (`test/contract.test.ts`)

1. **Operaciones**: cada `RouteSpec` existe en `openapi/erp.json` o está en `openapi/pendientes.json` → `adelantadas` con su referencia a `plan/contratos/o0-…`; cada operación del OpenAPI tiene su `RouteSpec`. Una adelantada que ya aparece en el OpenAPI hace fallar la prueba: hay que quitarla de `pendientes.json`.
2. **Fixtures**: cada fixture con DTO valida con Ajv contra su esquema del OpenAPI (`users.json` sin `_mock`).
3. **Respuestas**: cada operación se ejecuta con una petición de ejemplo contra los handlers y `data` valida contra el esquema de respuesta del OpenAPI o, si el contrato de ola lo cambia, contra el de `pendientes.json` → `cambios` (p. ej. `refresh`, `users/me` y las listas paginadas). Quedan sin esquema las 5 operaciones del punto 4 de la tabla.
4. **Normalización** del OpenAPI generado por NestJS antes de validar: `{ type: 'object' }` sin propiedades → tipo del `example` y `nullable`; los campos opcionales aceptan `null`; los objetos no admiten campos desconocidos salvo los `camposExtra` de `pendientes.json` (`audience`, `memberships`, `activeOrganizationId` del contrato; los detalles con relaciones del punto 5; los campos de las lecturas y tratamientos guardados del punto 4). Así un campo renombrado en el backend rompe la prueba.

Para actualizar el OpenAPI: `pnpm openapi:pull -- <url|ruta>` (p. ej. `https://136.243.223.39.sslip.io/docs-json` o el `openapi.json` de `drinks-on-chain-back`), después `pnpm test` y revisar `pendientes.json` y este documento. El 27-09-2026 el OpenAPI del servidor de desarrollo seguía siendo igual al del 25-09 (35 rutas, 45 operaciones).
