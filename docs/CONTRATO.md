# Contrato OpenAPI ↔ mocks del ERP

Revisión del 25-09-2026 contra `openapi/erp.json` (descargado de `https://136.243.223.39.sslip.io/docs-json`: 35 rutas, 45 operaciones, 38 esquemas) y contra respuestas reales del servidor sin credenciales (401, 400, 404). Complementa el doc 09 §8 de `drinks-on-chain-docsfront`. Regla: donde el catálogo o las guías del backend discrepan del OpenAPI, manda el OpenAPI.

## 1. Resultado de la comparación de DTO

Los 13 fixtures con DTO en el OpenAPI (`WineryResponseDto` y sus miembros, `UserProfileResponseDto`, `WineryMembershipDto`, `WalletResponseDto`, `AuthUserDto`, `AuthTokensDto`, `TerroirResponseDto`, `HarvestBatchResponseDto`, `FermentationTankResponseDto`, `CreateFermentationLogDto`, `CreateEnologicalTreatmentDto`, `WineAgingResponseDto`, `ProductionBatchResponseDto`, `BottlingBatchResponseDto`, `BatchLabAnalysisResponseDto`) coinciden **exactamente** con el OpenAPI: mismos nombres de campo, ningún campo requerido ausente o nulo, ningún campo desconocido, todos los valores de enumeración válidos. **No hubo que cambiar `generate.py`**: la referencia de `test/reference/erp/` es la salida sin modificar del script de `docs/mocks/erp/`.

## 2. Diferencias y huecos del OpenAPI (y qué hacen los mocks)

| # | Tema | OpenAPI / backend | Mocks |
|---|---|---|---|
| 1 | Forma de las listas | Los GET de colección (`terroirs`, `harvest-batches`, `fermentation-tanks`, `wine-aging`, `production-batches`, `bottling`, `wineries`) no declaran esquema de respuesta | `data: { items, total, limit, offset }`. Suposición aislada en `src/shared/list.ts` (`LIST_SHAPE`); `unwrapList()` acepta ambas formas |
| 2 | Listas declaradas como array | `GET /v1/wineries/pending` y `GET /v1/wineries/my/members` sí declaran `T[]` | Devuelven array plano |
| 3 | Campos nulos | Los opcionales de las respuestas se declaran `type: object` sin `nullable` (efecto de `string \| null` en NestJS) | Se tipan con su tipo real y `nullish()` (`T \| null \| undefined`) |
| 4 | Respuestas sin esquema | `POST …/logs`, `POST …/treatments`, `GET …/rest-status`, `GET /traceability/dag/:id`, `GET /traceability/public/:lotCode` | Lecturas y tratamientos: DTO de alta + `id`, `fermentationTankId` (+ `recordedByMemberId`). `rest-status`: forma de la guía de pruebas + `mandatoryRestUntil`. Pasaporte: forma del ejemplo de `endpoints.md`. DAG: **propuesta de los mocks** `{ bottlingBatchId, lotCode, nodes[{ id, type, label, date, data }], edges[{ from, to }] }` (esquema `looseObject`), a confirmar |
| 5 | Detalles con relaciones | El catálogo dice que `GET /terroirs/:id` trae los lotes de vendimia, `GET /harvest-batches/:id` los tanques y `GET /fermentation-tanks/:id` lecturas y tratamientos; los DTO del OpenAPI no los declaran | Se añaden como campos **opcionales** `harvestBatches`, `fermentationTanks`, `logs`, `treatments` (`TerroirDetailSchema`, `HarvestBatchDetailSchema`, `FermentationTankDetailSchema`). Sin ellos no hay forma de leer la bitácora de un tanque: confirmar con backend |
| 6 | `GET /v1/wine-aging` | No declara `limit`/`offset` ni filtros (el resto de listas sí) | Acepta `limit`/`offset`; ningún filtro |
| 7 | Esquema de seguridad | Las operaciones usan `JWT-auth`, pero `components.securitySchemes` solo define `bearer` (que usa `POST /v1/uploads`) | Sin efecto en los mocks; avisar a backend (el botón *Authorize* de Swagger puede no aplicarse) |
| 8 | `GET /traceability/public/:lotCode` | Marcado con `JWT-auth` en el OpenAPI; en el servidor responde sin token (404 real, no 401) | Público. Acepta el código de lote (sin distinguir mayúsculas) o el UUID del embotellado |
| 9 | Códigos de error | Verificados: `VALIDATION_ERROR` (400, `details` = lista de mensajes), `BAD_REQUEST` (400, JSON mal formado), `UNAUTHORIZED` (401), `NOT_FOUND` (404, también `Cannot GET /v1/…`). `path` incluye la query | Mismos códigos. No verificados (sin credenciales): `FORBIDDEN` (403), `CONFLICT` (409), `UNPROCESSABLE_ENTITY` (422), `INTERNAL_SERVER_ERROR` (500), siguiendo el mismo patrón |
| 10 | Pesaje sin laboratorio | Brix, pH y acidez son `required` en `CreateHarvestBatchDto`: el backend real probablemente responde **400 `VALIDATION_ERROR`** | Responden **422 `UNPROCESSABLE_ENTITY`** con `details` por campo (regla de negocio pedida para el ERP). El cliente debe tratar 400 y 422 como errores de campo |
| 11 | Bruto ≤ tara | 400 "Peso bruto menor o igual a tara" | 400 `BAD_REQUEST` |
| 12 | Rechazo de bodega | El enum `certificationStatus` no tiene `REJECTED` (el catálogo lo lista como filtro) | `POST …/reject` deja la bodega en `REVOKED` |
| 13 | Alta de usuarios | `SignupDto.userRole` solo admite `CONSUMER` y `WINERY_ADMIN` | Igual. Los miembros creados con `members/create` reciben `userRole` según su `memberRole` (`OWNER → WINERY_ADMIN`; `OPERATOR` y `ACCOUNTANT → ENOLOGIST`, como los operarios de los fixtures): confirmar |
| 14 | Fechas | Los DTO de alta declaran las fechas como `string` sin formato; las respuestas como `date-time` (el servidor devuelve milisegundos, `…:40.187Z`) | Aceptan `YYYY-MM-DD` o ISO; responden `YYYY-MM-DDTHH:MM:SSZ`. Los esquemas aceptan ambos formatos |
| 15 | `lockUntilDate` | Lo calcula el backend (`startDate` + `plannedMonths`), algoritmo no documentado | `startDate` (hoy por defecto) + meses, día acotado a 28 (como `generate.py`) |
| 16 | Candado y reposo | 422 "El vino se encuentra bloqueado por período de crianza hasta el YYYY-MM-DD"; 422 "reposo inerte < 180 días" | Mismo mensaje para la crianza; el reposo se calcula con `deriveRestStatus` desde `processEndDate` (o el inicio). Comparan con el "hoy" del reloj de los mocks (25-09-2026) |
| 17 | Destilación D.O. | "Validación de altitud D.O. (≥ 1.600 msnm)" en el catálogo | Con `isDoEligible: true`, 422 si la parcela de origen no es apta o está bajo 1.600 m. `mandatoryRestUntil` = fin (o inicio) + 180 días, `restStatus: RESTING` |
| 18 | Estados tras las altas | No documentado (doc 09 §8 puntos 3 y 4) | Crear crianza o destilación **no** cambia el tanque. Embotellar pasa la crianza o la destilación a `BOTTLED` |
| 19 | `qrBatchUrl` | El backend fija `https://drinksonchain.com/trace/batch/{lotCode}` | Fixtures y altas usan la propuesta `https://app.drinksonchain.bo/b/{lotCode}` (doc 09 §8 punto 2) |
| 20 | Código de lote | `{BODEGA}-{AÑO}-{TIPO}-{SEQ}` | La secuencia es por bodega y año (como en los fixtures: `CVJ-2026-WINE-003` sigue a dos singanis) |
| 21 | Conteo de rutas | El doc 09 habla de "35 rutas" | Son 35 rutas y 45 operaciones, incluida `GET /v1/health` (pública). Hay un handler por operación (lo comprueba `test/handlers.test.ts`) |

## 3. Roles aplicados por los handlers

El doc 09 §3 y el catálogo del backend no coinciden en todo; los mocks aplican esta tabla (en `src/erp/handlers/routes/*`). "Miembros" = usuario con bodega activa en el token; el `PLATFORM_ADMIN` lee todo pero solo escribe donde aparece.

| Operación | Roles |
|---|---|
| `users/me*`, `POST /wineries`, `POST /uploads` | Cualquier usuario autenticado |
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
| `GET /traceability/public/:lotCode`, `GET /health`, `/auth/*` | Públicas |

Los roles se comprueban con `userRole` (no `memberRole`): los operarios de los fixtures tienen `userRole: ENOLOGIST` y `memberRole: OPERATOR`.

## 4. Pendiente de confirmar con backend

Puntos 1, 4 (DAG), 5, 7, 8, 9 (403/409/422/500), 10, 12, 13, 15 y 18 de la tabla anterior, además de los 12 puntos del doc 09 §8.
