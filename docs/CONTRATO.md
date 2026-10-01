# Contrato OpenAPI ↔ mocks

Revisión del 25-09-2026, actualizada el 27-09-2026 con el **backend real de la Ola 1 completa** (mocks 0.4.0-rc.1: §7) y antes con el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro, §0 de este documento, con sus precisiones del §8), el OpenAPI del backend de la Ola 0 (O0-BE-2 y **O0-BE-4**: sesiones, membresías, estado `INVITED`) y el **contrato de la Ola 1** (`plan/contratos/o1-backoffice-y-bodegas.md`, §6, con las precisiones del §11 bis). Comparado contra `openapi/erp.json` (el `openapi.json` de `drinks-on-chain-back` en `dev`, commit `eace713`, igual al de `https://136.243.223.39.sslip.io/docs-json` el 27-09-2026: 102 rutas, 119 operaciones, 144 esquemas; antes, el de O0-BE-4, commit `c224e0a`, 48 operaciones), contra los guards del backend (`AccessTokenGuard`, `AuthorizationGuard`, `TenantGuard`, `@Roles` de cada controlador) y `docs/arquitectura/identidad.md` de `drinks-on-chain-back` y contra respuestas reales del servidor sin credenciales (401, 400, 404). Complementa el doc 09 §8 de `drinks-on-chain-docsfront`. Regla: donde el catálogo o las guías del backend discrepan del OpenAPI, manda el OpenAPI.

## 0. Contrato de la Ola 0 (mocks 0.2, alineados con el backend O0-BE-4 en 0.3.0-rc.2)

Los mocks imitaron el contrato de la Ola 0 antes de que el backend lo publicara; desde 0.3.0-rc.2 todo lo de la Ola 0 está en el OpenAPI real y ya no queda nada de ella en `openapi/pendientes.json`. La prueba de contrato (§5) valida contra el OpenAPI.

| Tema | Contrato (§) | Mocks 0.2 |
|---|---|---|
| Listas | §2 | Toda colección devuelve `{ items, total, limit, offset }`, `limit` 20 por defecto y 100 como máximo (más → 422) |
| Errores | §1 | Validación → **422** `VALIDATION_ERROR` con `details: [{ field, message }]` (`field` con puntos: `items.0.quantity`); reglas de negocio → 422 `UNPROCESSABLE_ENTITY` con el campo que las provoca; el resto (400 JSON mal formado, 401, 403, 404, 409, 500) con `details: null`. Códigos de sesión y permisos como `error-codes.ts` del backend (§8 del contrato, desde 0.3.0-rc.2): 401 `AUTH_INVALID_CREDENTIALS` (login; también cuenta bloqueada), `AUTH_TOKEN_INVALID` (acceso ausente o mal formado), `AUTH_TOKEN_EXPIRED`, `AUTH_REFRESH_INVALID`, `AUTH_REFRESH_REUSED`, `AUTH_SESSION_REVOKED`, `AUTH_SESSION_EXPIRED`; 403 `AUTH_INSUFFICIENT_PERMISSIONS` (antes `FORBIDDEN`), `ORG_MEMBERSHIP_BLOCKED`, `ORG_REVOKED`, `ORG_BLOCKED_BY_PLATFORM`; 404 `ORG_NOT_FOUND`; 409 `ORG_ALREADY_MEMBER`; 429 `AUTH_TOO_MANY_ATTEMPTS` |
| Membresías | §4 | `PLATFORM_ADMIN` → membresía de la organización de plataforma (`Drinks on Chain`) con el rol `_mock.platformRole` (desde 0.3; `SUPERADMIN` si no lo indica); cada `wineryMemberships[i]` → membresía `WINERY` (id = id de miembro; `isActive: false` → `BLOCKED`); `POS_OPERATOR` y consumidores sin membresía. La organización de una bodega es la propia bodega (enlace 1:1) y su estado es `certificationStatus` |
| Login | §5 | `{ user (+ audience), memberships, activeOrganizationId, tokens }` (sin `userRole`/`wineryId`/`memberRole` desde H1); acceso de 15 min (`expiresIn: 900`) con forma de JWT (`header.payload.mock`, claims `sub`, `aud`, `org`, `orgType`, `role`, `sid`, `jti`, `iat`, `exp`; sin los de compatibilidad desde H1); el refresco **solo** en `Set-Cookie: doc_rt=…; HttpOnly; [Secure;] SameSite=Lax; Path=/; Max-Age=604800` (30 días para consumidores; `Secure` solo con `https:`) |
| Organización activa | §5 | La última usada (se recuerda por persona) si sigue siendo válida; si no, la primera membresía `ACTIVE` de organización no `REVOKED` (plataforma antes que bodega); `null` si no hay |
| Refresh | §5, §8 | Refresco `<sid>.<generación>.<secreto>` como el backend (`sid` UUID, generación desde 0, secreto de 43 caracteres base64url). Lee la cookie `doc_rt` de la petición o, si no llega, el almacén propio de los mocks (el cuerpo `{ refreshToken }` no se lee desde H1). Rota siempre y responde como el login. Uno que no encaja en ninguna cadena → 401 `AUTH_REFRESH_INVALID` **sin revocar**; el inmediatamente anterior dentro de la gracia (20 s, hora real) → el mismo par nuevo; uno antiguo fuera de la gracia → revoca la sesión y 401 `AUTH_REFRESH_REUSED`; sesión revocada, persona o membresía activa bloqueada → 401 `AUTH_SESSION_REVOKED`; sesión caducada (7 días sin rotar el personal, 30 los consumidores, reloj de los mocks) → 401 `AUTH_SESSION_EXPIRED`. Si la sesión no tenía organización activa, la renovación toma la de por defecto. El refresco estático `mock.refresh.<clave>` en la cookie (solo en los mocks) abre una sesión nueva |
| `switch-organization` | §5, §8 | Misma sesión (`sid`), tokens nuevos. Exige **también el refresco de esa misma sesión** en la cookie `doc_rt`, que se rota (`refreshToken` en el cuerpo → 422 desde H1); sin él o de otra sesión → 401 `AUTH_REFRESH_INVALID`. Sin membresía → 404 `ORG_NOT_FOUND`; membresía `BLOCKED` → 403 `ORG_MEMBERSHIP_BLOCKED`; organización `REVOKED` → 403 `ORG_REVOKED`. Con un token estático `mock.access.<clave>` (sin sesión) abre una sesión nueva |
| `logout` / `logout-all` | §5 | 204 sin cuerpo y `Set-Cookie: doc_rt=; … Max-Age=0`. `logout` identifica la sesión por el acceso (aunque haya caducado) o por el refresco |
| `GET /users/me` | §5 | `{ user, memberships, activeOrganizationId }` (`MeResponseDto`); `user` es el perfil de 0.1 más `audience`. `PATCH /users/me` devuelve lo mismo desde 0.3.0-rc.2 (contrato de la Ola 1 §11 bis; el backend aún devuelve el perfil: `cambios` de `pendientes.json`) |
| Revocación inmediata | §5 (IAM-13) | Si la membresía activa pasa a `BLOCKED` o la persona a inactiva, la siguiente petición con ese acceso revoca la sesión (401 `AUTH_SESSION_REVOKED`) |
| Permisos | §6, §8 | Como los guards del backend: `@OrgType('WINERY') @Roles(...)` con el **rol de la membresía activa** (tabla del §3). No hay rol global (`userRole` se retiró en H1) |
| Bloqueo del login | §8 (IAM-07) | Por correo, con la hora real: 5 fallos en una hora → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After: 60`, que se duplica con cada fallo (tope 1 h); mientras dura no se comprueba la contraseña; un login correcto limpia el contador. El límite por IP (20) y los límites de peticiones por minuto no se simulan. `resetErpDb()` lo borra |
| SE-01 | §4 | Una bodega solo escribe su propia membresía: el equipo entra por invitación (`/organizations/current/invitations`, aceptar añade o reactiva la membresía) |
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
| 3 | Campos nulos | **Resuelto en la Ola 1**: cada campo que puede ser `null` declara `nullable: true` con su tipo; los opcionales de los DTO de entrada no son anulables (`null` = omitido para class-validator) | Respuestas con su tipo y `nullable`/`nullish`; los esquemas `Create*` usan `.optional()` sin `null` y los handlers de alta tratan `null` como omitido (`parseCreateBody`). La prueba de contrato ya no hace anulables los opcionales (§5) |
| 4 | Respuestas sin esquema | **Resuelto en la Ola 1**: `FermentationLogResponseDto` (`recordedByUserId`), `EnologicalTreatmentResponseDto` (`authorizedByMemberId`), `RestStatusResponseDto` (+ `processEndDate`) y `DagGraphResponseDto` para el DAG **y** el pasaporte público | Igual desde 0.4. Las filas de la semilla (`fermentation-logs.json`, `enological-treatments.json`, compartidas con la semilla del backend) conservan `recordedByMemberId` y no llevan autor del tratamiento: los handlers responden la persona del miembro y, en los tratamientos de la semilla, el enólogo activo o el dueño (como la semilla del backend). El DAG se calcula como `DagBuilderService` (mismos hashes que el servidor; las fechas, sin milisegundos) |
| 5 | Detalles con relaciones | **Resuelto en la Ola 1**: los DTO declaran las relaciones de los `include` de Prisma (opcionales) | Igual desde 0.4 (`src/erp/handlers/views.ts`, esquemas `*DetailSchema` de `src/erp/schemas/details.ts`): vendimia con `terroir` (lista y detalle) y `fermentationTanks` (detalle); cuba con `harvestBatch` y, en el detalle, `logs` y `treatments`; crianza y destilación con `fermentationTank` (en el detalle con vendimia y parcela) y `bottlingBatches`; embotellado con `labAnalysis` y, en el detalle, `wineAgingBatch`/`productionBatch` con su cadena |
| 6 | `GET /v1/wine-aging` | No declara `limit`/`offset` ni filtros (el resto de listas sí) | Acepta `limit`/`offset`; ningún filtro |
| 7 | Esquema de seguridad | Las operaciones usan `JWT-auth`, pero `components.securitySchemes` solo define `bearer` (que usa `POST /v1/uploads`) | Sin efecto en los mocks; avisar a backend (el botón *Authorize* de Swagger puede no aplicarse) |
| 8 | `GET /traceability/public/:lotCode` | Público (`@Public()`); responde el grafo DAG | Público. Acepta el código de lote (sin distinguir mayúsculas) o el UUID del embotellado |
| 9 | Códigos de error | Verificados: `VALIDATION_ERROR` (400, `details` = lista de mensajes), `BAD_REQUEST` (400, JSON mal formado), `UNAUTHORIZED` (401), `NOT_FOUND` (404, también `Cannot GET /v1/…`). `path` incluye la query | Desde 0.2, lo del contrato de la Ola 0 (§0): `VALIDATION_ERROR` es **422** con `details: [{ field, message }]`; `BAD_REQUEST` (400) queda para el JSON mal formado. Desde 0.3, como el backend O0-BE-2 (`error-codes.ts`): 500 `INTERNAL_ERROR`, 409 `WINERY_NOT_PENDING` y `FERMENTATION_TANK_ALREADY_TRANSFERRED`, 422 `IDEMPOTENCY_KEY_INVALID`, 409 `IDEMPOTENCY_KEY_REUSED`. Mensajes de validación en español (mapa común de zod) |
| 10 | Pesaje sin laboratorio | Brix, pH y acidez son `required` en `CreateHarvestBatchDto` | 422 `VALIDATION_ERROR` con un detalle por campo (`brixDegrees`, `initialPh`, `initialAcidityGl`) |
| 11 | Bruto ≤ tara | 400 "Peso bruto menor o igual a tara" | 422 `VALIDATION_ERROR` en `grossWeightKg` (contrato §1) |
| 12 | Rechazo de bodega | El enum `certificationStatus` no tiene `REJECTED` (el catálogo lo lista como filtro) | `POST …/reject` deja la bodega en `REVOKED` |
| 13 | Alta de usuarios | Desde H1 `signup` solo registra consumidores (`userRole` → 422); el personal entra por invitación | Igual; los fixtures de personas ya no llevan `userRole` |
| 14 | Fechas | Los DTO de alta declaran las fechas como `string` sin formato; las respuestas como `date-time` (el servidor devuelve milisegundos, `…:40.187Z`) | Aceptan `YYYY-MM-DD` o ISO; responden `YYYY-MM-DDTHH:MM:SSZ`. Los esquemas aceptan ambos formatos |
| 15 | `lockUntilDate` | Lo calcula el backend (`startDate` + `plannedMonths`), algoritmo no documentado | `startDate` (hoy por defecto) + meses, día acotado a 28 (como `generate.py`) |
| 16 | Candado y reposo | 422 "El vino se encuentra bloqueado por período de crianza hasta el YYYY-MM-DD"; 422 "reposo inerte < 180 días" | Mismo mensaje para la crianza; el reposo se calcula con `deriveRestStatus` desde `processEndDate` (o el inicio). Comparan con el "hoy" del reloj de los mocks (25-09-2026) |
| 17 | Destilación D.O. | "Validación de altitud D.O. (≥ 1.600 msnm)" en el catálogo | Con `isDoEligible: true`, 422 si la parcela de origen no es apta o está bajo 1.600 m. `mandatoryRestUntil` = fin (o inicio) + 180 días, `restStatus: RESTING` |
| 18 | Estados tras las altas | No documentado (doc 09 §8 puntos 3 y 4) | Crear crianza o destilación **no** cambia el tanque. Embotellar pasa la crianza o la destilación a `BOTTLED` |
| 19 | `qrBatchUrl` | El backend fija `https://drinksonchain.com/trace/batch/{lotCode}` | Fixtures y altas usan la propuesta `https://app.drinksonchain.bo/b/{lotCode}` (doc 09 §8 punto 2) |
| 20 | Código de lote | `{BODEGA}-{AÑO}-{TIPO}-{SEQ}` | La secuencia es por bodega y año (como en los fixtures: `CVJ-2026-WINE-003` sigue a dos singanis) |
| 21 | Conteo de rutas | El doc 09 habla de "35 rutas" | Con la Ola 1 completa son 102 rutas y 119 operaciones, incluidas `GET /v1/health`, `/health/live` y `/health/ready` (públicas) y `GET /v1/uploads/url`. Hay un handler por operación (lo comprueba `test/contract.test.ts`) |
| 22 | `GET /traceability/dag/:id` | Sin `@OrgType` ni `@Roles`: cualquier sesión, sin filtrar por bodega | Cualquier sesión; con una bodega activa solo sus lotes (404 los de otra), la plataforma y el resto ven todos. Confirmar con backend si el DAG debe filtrar por bodega |
| 23 | Archivos | `POST /v1/uploads` solo personal, tipo por firma de bytes (JPEG, PNG, WEBP, GIF ≤ 5 MB; PDF ≤ 15 MB), clave privada `org/<id>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>` y URL firmada de 15 min; `GET /v1/uploads/url?key=` | Igual (0.4): consumidor → 403 `FORBIDDEN`; tipo que no coincide → 422 `FILE_TYPE_NOT_ALLOWED` en `file`; demasiado grande → 413 `FILE_TOO_LARGE`; clave de otra organización → 404 `FILE_NOT_FOUND`. La URL `/mocks/uploads/<clave>?expires=…&signature=mock` no sirve ningún archivo |
| 24 | Rutas obsoletas | Retiradas en H1 (404): `POST /wineries`, `wineries/pending`, `wineries/{id}/approve|reject`, `wineries/my/members*`. La maquinaria `deprecated` + `x-replaced-by` + `Deprecation`/`Link` queda para próximas retiradas | Igual: sin rutas; `RouteSpec.deprecated` se conserva y la prueba de contrato exige las mismas obsoletas que el OpenAPI (hoy ninguna) |

## 3. Permisos aplicados por los handlers

Desde 0.3.0-rc.2, la matriz de los guards del backend (`@OrgType('WINERY') @Roles(...)` de cada controlador en `origin/dev`, `docs-back/05` §3 y `docs/arquitectura/identidad.md`), con el **rol de la membresía activa**. Regla `winery(...)` en `src/erp/handlers/auth-context.ts`; `resolveTenant` hace de `TenantGuard`.

| Ruta | OWNER | ENOLOGIST | AGRONOMIST | OPERATOR | ACCOUNTANT |
|---|---|---|---|---|---|
| Parcelas: alta y edición | ✅ | — | ✅ | — | — |
| Parcelas: lectura | ✅ | ✅ | ✅ | ✅ (mínima, §11 bis; desde 0.4) | ✅ |
| Vendimia (pesaje): alta | ✅ | ✅ | ✅ | ✅ | — |
| Vendimia: lectura | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dictamen fitosanitario (`phyto-status`) | ✅ | ✅ | ✅ | — | — |
| Cubas: alta y tratamientos | ✅ | ✅ | — | — | — |
| Cubas: lectura | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lecturas diarias (`…/logs`) | ✅ | ✅ | ✅ | ✅ | — |
| Crianza, destilación, embotellado: alta | ✅ | ✅ | — | — | — |
| Crianza, destilación (y `rest-status`), embotellado: lectura | ✅ | ✅ | — | — | ✅ |
| Laboratorio: alta | ✅ | ✅ | — | — | — |
| Laboratorio: lectura | ✅ | ✅ | ✅ | — | ✅ |
| `PATCH /wineries/my` | ✅ | — | — | — | — |
| `GET /wineries/my` | ✅ | ✅ | ✅ | ✅ | ✅ |

- **Plataforma sobre una bodega** (OP-07): en todas las rutas de la tabla, `SUPERADMIN`, `ADMIN` y `OPERATIONS` leen y escriben y `SUPPORT` solo lee, con la bodega en `?wineryId=`. Las lecturas sin él ven todas las bodegas; las escrituras sin él → 422 `VALIDATION_ERROR` con `details[{ field: 'wineryId' }]`; `wineryId` que no es UUID → 422; bodega inexistente → 404 `ORG_NOT_FOUND`.
- **Bodega activa**: si la petición apunta a otra bodega (`?wineryId=` o `wineryId` en el cuerpo) → 404 `NOT_FOUND` (nunca 403); lo de otra bodega por id también es 404.
- **Rutas de plataforma**: `GET /wineries` (directorio): todo el personal de plataforma; `/platform/*` según la matriz de la Ola 1.
- **Cualquier sesión**: `users/me*`, `POST /uploads`, `switch-organization`, `logout-all`, `GET /traceability/dag/:id` (§2 punto 22). **Públicas**: `GET /traceability/public/:lotCode`, `GET /health`, `signup`, `login`, `refresh`, `logout`.
- Rol insuficiente, tipo de organización equivocado o `SUPPORT` escribiendo → 403 `AUTH_INSUFFICIENT_PERMISSIONS`. El personal de plataforma necesita además el segundo factor en la sesión (403 `AUTH_MFA_REQUIRED`; Ola 1).
- Cambios frente a 0.3.0-rc.1: el operario ya no actúa como enólogo (pesa y registra lecturas, no crea cubas ni lee crianza/embotellado), el contador solo lee, el dueño dictamina, el agrónomo registra lecturas, el `POS_OPERATOR` global ya no registra lecturas y los consumidores ya no leen análisis de laboratorio por el ERP.

## 4. Pendiente de confirmar con backend

Puntos 4 (DAG), 5, 7, 8, 12, 13, 15, 18 y 22 de la tabla anterior, además de los 12 puntos del doc 09 §8. Los puntos 1, 2 y 9 los resolvió el OpenAPI de O0-BE-2 (listas, 422 con `details`, códigos) y la sesión de la Ola 0 llegó con O0-BE-4 (0.3.0-rc.2). Diferencias que quedan con el backend: el refresco estático `mock.refresh.<clave>` y los tokens estáticos `mock.access.<clave>` (solo en los mocks), un acceso de una sesión que los mocks no conocen (almacenamiento borrado) se acepta con los datos del token (el backend responde `AUTH_TOKEN_INVALID`), y no se simulan los límites por minuto ni el bloqueo por IP. El §6 (Ola 1) llegó completo al backend: desde 0.4 los mocks lo validan contra el OpenAPI real (§7).

## 5. Prueba de contrato (`test/contract.test.ts`)

1. **Operaciones**: cada `RouteSpec` (ERP + Ola 1, `MOCK_ROUTE_SPECS`) existe en `openapi/erp.json` o está en `openapi/pendientes.json` → `adelantadas` con su referencia a `plan/contratos/o<ola>-…`; cada operación del OpenAPI tiene su `RouteSpec`. Una adelantada que ya aparece en el OpenAPI hace fallar la prueba: hay que quitarla de `pendientes.json`.
2. **Fixtures**: cada fixture del ERP con DTO valida con Ajv contra su esquema del OpenAPI (`users.json` sin `_mock`). Los de la Ola 1 (`fixtures/backoffice/`) los valida `test/backoffice-fixtures.test.ts` con sus esquemas zod (estrictos) y reglas de coherencia; `waitlist.json` (0.4.1) valida además contra `WaitlistEntryDto`.
3. **Respuestas**: cada operación se ejecuta con una petición de ejemplo contra los handlers y `data` valida contra el esquema de respuesta del OpenAPI o, si un contrato de ola lo cambia o lo adelanta, contra el de `pendientes.json`. Ahí, `{ "$zod": "<Esquema>" }` es el esquema zod que exporta el paquete (convertido con `z.toJSONSchema`, sin campos desconocidos), `{ "$page": "zod:<Esquema>" }` su página y `{ "$csv": true }` una exportación `text/csv` (la de la bitácora y, desde 0.4.1, la de la lista de espera; cada petición de ejemplo declara su cabecera en `csvHeader`). Quedan sin esquema las 5 operaciones del punto 4 de la tabla.
4. **Validación estricta** (desde 0.4): un `null` solo vale donde el DTO declara `nullable` y un opcional se omite. Normalización mínima de lo que genera NestJS: `{ type: 'object' }` sin propiedades (solo en DTO de entrada) → tipo del `example`; `nullable` + `allOf: [ref]` (relación opcional) → `anyOf: [ref, null]`; `nullable` + `oneOf` (valor de un parámetro de configuración) → `null` como otra opción. Las respuestas `text/csv` se comprueban por su cabecera. Además, las rutas obsoletas de los mocks son las del OpenAPI (`deprecated`, `x-replaced-by`) y las filas de la semilla del ERP se validan convertidas en respuesta (lecturas, tratamientos) o contra su DTO (`users.json` → `MeUserDto`, `production-rest-status.json`, `traceability-public.json` → `DagGraphResponseDto`). Los objetos no admiten campos desconocidos salvo los `camposExtra` de `pendientes.json` (`notificationPrefs` y `promotionsConsent` de la Ola 1 en `MeUserDto`; los detalles con relaciones del punto 5; los campos de las lecturas y tratamientos guardados del punto 4); `enumCambios` sustituye los valores de una enumeración cuando un contrato de ola la cambia (hoy ninguna: `INVITED` ya está en el OpenAPI). Así un campo renombrado en el backend rompe la prueba.

El 27-09-2026 (0.4.0-rc.1) se trajo el de la Ola 1 completa (`eace713`: 119 operaciones, 144 esquemas): salieron de `pendientes.json` las 66 adelantadas de la Ola 1, los `cambios` del login y de `PATCH /users/me` y los `camposExtra` (preferencias, relaciones, lecturas y tratamientos); `pendientes.json` queda vacío.

Para actualizar el OpenAPI: `pnpm openapi:pull -- <url|ruta>` (p. ej. `https://136.243.223.39.sslip.io/docs-json` o el `openapi.json` de `drinks-on-chain-back`), después `pnpm test` y revisar `pendientes.json` y este documento. El 27-09-2026 se trajo el de O0-BE-2 (mismas 45 operaciones; listas paginadas y errores del contrato de la Ola 0 ya declarados) y después el de O0-BE-4 (48 operaciones: `switch-organization`, `logout`, `logout-all`; `refresh` y `GET /users/me` con la forma de sesión, `MembershipDto`, `MeResponseDto`, `audience`, `INVITED` y `?wineryId=` en las rutas de bodega). Salieron de `pendientes.json` las 3 operaciones de sesión, los `cambios` de `refresh` y `GET /users/me`, los `camposExtra` de `AuthUserDto`, `AuthResponseDto` y `UserProfileResponseDto` y el `enumCambios` de `certificationStatus`.

## 6. Contrato de la Ola 1 (mocks 0.3)

Los mocks imitaron `plan/contratos/o1-backoffice-y-bodegas.md` antes de que el backend lo publicara; desde 0.4 todo está en el OpenAPI real (68 operaciones de la Ola 1, con la ampliación del §11 bis) y `openapi/pendientes.json` está vacío. Lo que cambió al alinearse con el backend, en §7. Esquemas zod en la entrada raíz (`src/backoffice/schemas/`), rutas en `src/backoffice/handlers/`, fixtures en `fixtures/backoffice/` (`src/backoffice/seed/generate.ts`).

### 6.1 Decisiones de los mocks (lo que el contrato no fija)

| Tema | Contrato | Mocks 0.3 |
|---|---|---|
| Estado de la bodega | §0: `INVITED` sustituye a `PENDING` | `WineryResponseDto.certificationStatus` (ERP) y `Membership.organizationStatus` usan `INVITED`; `?status=PENDING` se acepta como alias en `GET /v1/wineries`. Desde O0-BE-4 también en el OpenAPI (`OrganizationStatus`) |
| `ORG_NOT_ACTIVE` | §4: rutas del ERP con la bodega activa no `ACTIVE`; perfil y bitácora propia permitidos en `SUSPENDED` | Se aplica a las rutas de bodega del ERP y a `/v1/organizations/current/*`. En `SUSPENDED` se permiten `GET /v1/wineries/my`, `GET /v1/organizations/current` y `GET /v1/organizations/current/audit`; en `INVITED` y `REVOKED`, nada. La plataforma no se ve afectada |
| Segundo factor | §1 | TOTP RFC 6238 (SHA-1, 30 s, 6 dígitos) con la **hora real** ± 1 paso; el reto (`mfaToken`) caduca a los 5 min del **reloj de los mocks** (`advanceMockClock`). Código inválido → 401 `AUTH_MFA_INVALID_CODE`; reto caducado o usado → 401 `AUTH_MFA_TOKEN_INVALID`; 5 fallos seguidos → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After: 300`, correo `MFA_FAILED_ATTEMPTS` y reto anulado; `verify` sin inscripción → 409 `AUTH_MFA_NOT_ENROLLED`; `enroll` o `enroll/confirm` ya inscrito → 409 `AUTH_MFA_ALREADY_ENROLLED`; `enroll/confirm` sin `enroll` → 409 `AUTH_MFA_ENROLLMENT_NOT_STARTED` (desde 0.4; antes `CONFLICT`). Inscribir usa siempre el secreto de demo. Aceptar una invitación de plataforma devuelve el reto (forma del login de una persona de plataforma) |
| Atajo `000000` | — | `MOCK_TOTP_BYPASS_CODE` vale como TOTP en `mfa/verify` y `mfa/enroll/confirm`. **Solo existe en los mocks**: úsalo en demos; las e2e deben generar el código con `generateTotp(DEMO_TOTP_SECRET)` |
| Tokens estáticos | — | `mock.access.<clave>` cuenta como sesión con TOTP (paneles y pruebas) |
| Contraseñas nuevas | §1: ≥ 10 caracteres, no comunes | Lista corta de comunes (`1234567890`, `password123`…) y caracteres repetidos; 422 `AUTH_WEAK_PASSWORD` con un detalle por problema. Las contraseñas de los fixtures (`demo1234`) no se revalidan; `DEMO_NEW_PASSWORD` (`vendimia-2026`) cumple la política |
| Captcha | §0: Turnstile | Cualquier `captchaToken` no vacío vale salvo el que contenga `fail` → 422 `CAPTCHA_INVALID` en `captchaToken` |
| Caducidades | §1, §2 | Invitaciones (`invitacion.caducidadHoras`, 72 h), recuperación (60 min) y retos TOTP (5 min) con el reloj de los mocks (empieza el 2026-09-25 12:00 UTC y avanza un minuto por escritura; `advanceMockClock(ms)` lo adelanta) |
| Tokens de invitación | §2: un solo uso, hash guardado | Los de los fixtures son legibles (`demo-invitacion-…`); los que emiten los handlers son "portátiles" (`inv.<base64url>.<firma>`): si otra app (con su propio `localStorage`) abre el enlace, la invitación se importa con su bodega. Las apps no deben leerlos. Reenviar da un token nuevo y el anterior → 404 `INVITATION_NOT_FOUND` |
| Aceptar | §2 | Cuenta existente sin sesión → 401 `AUTH_LOGIN_REQUIRED`; con sesión, en una bodega hace falta además el refresco de esa sesión (cookie `doc_rt`; si no, 401 `AUTH_REFRESH_INVALID`), que se rota como en `switch-organization`; sesión de otra persona o cuenta nueva con sesión → 403 `INVITATION_EMAIL_MISMATCH`; organización revocada → 403 `ORG_REVOKED`; ya miembro activo → 409 `ORG_ALREADY_MEMBER` (salvo transferencia y, solo en los mocks, el dueño activo de una bodega `INVITED` de antes de la Ola 1, que la activa); bloqueado por la plataforma e invitación del dueño → 403 `ORG_BLOCKED_BY_PLATFORM`; aceptada o anulada → 409 `INVITATION_NOT_PENDING`; caducada → 422 `INVITATION_EXPIRED`; nueva sin `fullName`/`password` → 422 `VALIDATION_ERROR`. Una invitación de plataforma devuelve el reto TOTP (`{ mfa }`) |
| Reenviar / anular | §2 | Reenviar: `PENDING` o `EXPIRED` (una caducada vuelve a contar para el límite de colaboradores → 422 `ORG_MEMBER_LIMIT_REACHED`); anular: `PENDING`; si no, 409 `INVITATION_NOT_PENDING`. Pueden el dueño (bodega `ACTIVE`) y el personal de plataforma (las de plataforma, solo administración); otra organización → 404 |
| Límite de colaboradores | §5 | Miembros activos (dueño incluido) + invitaciones pendientes ≥ `equipo.maxColaboradoresPorBodega` → 422 `ORG_MEMBER_LIMIT_REACHED` (en `email` al invitar). Lo comprueban invitar, reenviar una caducada y **desbloquear** (desde 0.4). No cuenta para invitaciones de dueño (alta y transferencia) |
| Solicitudes | §3 | `take` solo desde `RECEIVED`; `notes` en cualquier estado verificado; `reject` solo desde `IN_REVIEW` (diagrama de docs-back/07 §1.2). La lista ordena por fecha descendente; `q` busca en razón social, nombre, NIT, contacto y región. Desde 0.4, como el backend: el NIT lo ocupa **cualquier** bodega (también `REVOKED`) y las solicitudes abiertas (`RECEIVED`, `IN_REVIEW`, `MEETING_SCHEDULED` y `UNVERIFIED` con el enlace vigente; una sin verificar caducada no); reenviar la misma solicitud sin verificar (mismo NIT y correo) la actualiza y manda un enlace nuevo; el enlace caduca a las 72 h del último envío; token desconocido, usado o caducado → 422 `APPLICATION_TOKEN_INVALID` en `token`; solicitud inexistente → 404 `NOT_FOUND`; NIT tomado → 409 `ORG_TAX_ID_TAKEN` con `details[{ field: 'taxId' }]` |
| Bodegas | §4 | `slug`: nombre comercial sin tildes ni "bodega"; `lotPrefix`: código del catálogo o 3 letras (iniciales de las palabras significativas + letras de la última), 4–5 si está tomado. `PATCH /v1/platform/wineries/{id}` edita también razón social, NIT, categoría y región. `region` filtra por coincidencia parcial. Revocar anula las invitaciones pendientes. Transferir exige bodega `ACTIVE`/`SUSPENDED` con dueño activo; `BLOCKED` deja al anterior como enólogo bloqueado por la plataforma. Transición inválida → 409 `ORG_INVALID_TRANSITION` |
| `by`, `updatedBy` | §3, §4, §6 | Nombre de la persona (no su id); `Sistema` en los hechos anteriores a la Ola 1 |
| Equipo | §5 | Nadie (dueño ni back office) se cambia ni se bloquea a sí mismo → 403 `ORG_CANNOT_MODIFY_SELF`; `OWNER` no se asigna ni se quita por rol → 403 `ORG_OWNER_ROLE_RESERVED`; el mismo rol no cambia nada. Cambiar el rol o bloquear revoca las sesiones de esa persona con la bodega. Los demás roles leen solo los miembros activos y con `lastLoginAt: null`; `accountStatus`/`accountBlockedReason` solo en las rutas de plataforma. Miembro de otra organización → 404 `NOT_FOUND`. `/v1/platform/organizations/{id}/…` solo para bodegas (`ORG_NOT_FOUND` si no, también la de plataforma en `…/invitations`); invitar desde la plataforma exige bodega `ACTIVE` o `SUSPENDED` |
| Usuarios internos | §5, §11 bis | `POST /v1/platform/users/{membershipId}/block\|unblock` solo con el id de una **membresía** de plataforma (otro id → 404 `NOT_FOUND`) y cierra solo sus sesiones con la plataforma (también al cambiar su rol); la **cuenta completa** se bloquea con `POST /v1/platform/accounts/{userId}/block\|unblock` (`UserAccountStatus`, solo `ADMIN`/`SUPERADMIN`, revoca todas las sesiones; el login de una cuenta bloqueada → 401 `AUTH_INVALID_CREDENTIALS`; persona inexistente → 404 `USER_NOT_FOUND`; un superusuario → 403 `PLATFORM_SUPERADMIN_PROTECTED`) y se consulta con `GET /v1/platform/accounts/{userId}` (`AccountDetail`: estado, motivo, fecha y membresías). `PlatformUser` lleva `accountStatus` y `accountBlockedReason` (`null` en una invitación sin cuenta); los pendientes usan el nombre de la cuenta o el correo como `fullName` y llevan `invitationId` |
| Configuración | §6 | Valores de enumeración en inglés (`BURN`/`EXTEND`/`COMPENSATE`, `DISABLED`/`OPTIONAL`/`REQUIRED`), unidades y límites `min`/`max` propuestos por los mocks; límites de laboratorio de ejemplo (no normativos); `precio.politica` = `null`. Tipo, límites o enumeración → 422 `VALIDATION_ERROR` en `value`; clave desconocida → 404 `SETTING_NOT_FOUND`; `wineryIds: 'ALL'` = bodegas no revocadas. `GET …/overrides` y `…/history` son listas paginadas; `GET /v1/platform/settings` y `/v1/organizations/current/settings`, arrays |
| Bitácora | §7 | Tipos de recurso en `snake_case` como el backend (`winery_application`, `winery`, `membership`, `invitation`, `user`, `setting`, `terroir`, `harvest_batch`, `fermentation_tank`, `fermentation_log`, `enological_treatment`, `wine_aging_batch`, `production_batch`, `bottling_batch`, `lab_analysis`, `file`) y sus códigos de acción (`FERMENTATION_LOG_ADDED`, `AUTH_LOGIN_SUCCEEDED`…; desde 0.4). `hash` = SHA-256 (hex) del JSON canónico del evento sin `hash` (claves ordenadas, sin espacios; incluye `prevHash`). La app de origen es `X-Client-App` si es válida; si no, `PUBLIC` en rutas públicas sin sesión y `API` en el resto; `ip` de `X-Forwarded-For`, `deviceId` de `X-Device-Id`. También se registran las escrituras del ERP. CSV con cabecera, CRLF y orden cronológico; `from`/`to` aceptan `AAAA-MM-DD` (día completo) o ISO |
| Correos | §10 | En el buzón simulado. Enlaces: ERP `…/invitacion/{token}`, Backoffice `…/invitacion/{token}`, sitio de bodegas `…/unirse/verificar?token=`, recuperación `…/restablecer-contrasena?token=` (en la app de `X-Client-App`), verificación `…/verificar-correo?token=`. URL base por defecto: WEB 3000, ERP 3002, BACKOFFICE 3003, POS 3004, MARKETPLACE 3005 (`setMockAppUrls` o `appUrls`) |
| Respuestas 202 | §1, §3, §5 | `forgot-password`, `resend-verification` y `send-password-reset` → 202 con `data: null` |
| `PATCH /v1/users/me` | §1 y §11 bis: responde `{ user, memberships, activeOrganizationId }` | Desde 0.3.0-rc.2 responde `{ user, memberships, activeOrganizationId }` (como `GET`); acepta `notificationPrefs` (parcial) y `promotionsConsent`, que aparecen en `user`. El backend aún devuelve el perfil (`cambios` de `pendientes.json`) |
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

## 7. Alineación con el backend de la Ola 1 completa (mocks 0.4.0-rc.1)

OpenAPI de `drinks-on-chain-back` en `dev` (`eace713`) y su código (`docs/arquitectura/identidad.md`, `organizaciones.md`, `configuracion.md`, `bitacora.md`). Rupturas y migración en el CHANGELOG.

| Tema | Backend | Mocks 0.4 |
|---|---|---|
| Operaciones | 119; ninguna adelantada | `openapi/pendientes.json` vacío; nuevas `GET /v1/health/live`, `/health/ready`, `GET /v1/uploads/url`, `GET /v1/platform/organizations/{id}/invitations`, `GET /v1/platform/accounts/{userId}` |
| DAG y pasaporte | `DagGraphResponseDto` en las dos rutas | `buildDagGraph` (`src/erp/derive.ts`) = `DagBuilderService`, también en `generate.py` (`traceability-public.json`); comprobado contra el servidor: mismos `batchId`, `metadataHash` y métricas |
| Lecturas, tratamientos, reposo | `recordedByUserId`, `authorizedByMemberId`, `processEndDate` | Igual; un tratamiento lo autoriza un miembro activo (la plataforma → 403) |
| Relaciones | `include` de Prisma | Igual (§2 punto 5) |
| Altas con `null` | `@IsOptional()`: `null` = omitido; el OpenAPI no lo declara | `Create*Schema` sin `null`; los handlers lo aceptan como omitido |
| `AuthTokens.refreshToken` | Retirado del cuerpo en H1 | Opcional y `@deprecated` en el esquema; los mocks ya no lo mandan (0.4.0-rc.2, §8) |
| Códigos | `ORG_NOT_FOUND` (bodega), `NOT_FOUND` (solicitud, miembro de otra organización, membresía de plataforma), `USER_NOT_FOUND`, `APPLICATION_TOKEN_INVALID`, `AUTH_MFA_*`, `AUTH_LOGIN_REQUIRED`, `FILE_*` | Igual; `API_ERROR_CODES` = catálogo de `error-codes.ts` |
| NIT | Único entre todas las bodegas; solicitudes abiertas | §6.1 "Solicitudes" |
| Equipo y cuentas | `TeamService`, `PlatformUsersService` | §6.1 "Equipo" y "Usuarios internos" |
| Invitaciones | Cuenta existente: acceso + refresco; plataforma → reto TOTP | §6.1 "Aceptar" |
| Bitácora | `snake_case` | §6.1 "Bitácora" |
| Obsoletas (H1) | Retiradas al cerrar la Ola 1 | §2 punto 24 y §8 |
| Archivos | Almacenamiento privado, URL firmada | §2 punto 23 |
| Salud | `storage`, `worker`; `/live` y `/ready` | Siempre `ok`, `connected`, `up`; `release: null` |

Diferencias que quedan (decisiones de los mocks): el DAG filtra por bodega activa (§2 punto 22); las fechas del DAG no llevan milisegundos y la de la vendimia es la del pesaje con hora (el backend guarda solo el día); el dueño activo de una bodega `INVITED` de los fixtures acepta su invitación de dueño (el backend respondería 409); los límites por IP y por correo del formulario público y el captcha real no se simulan; los archivos subidos no se guardan.

## 8. Retirada de H1 (mocks 0.4.0-rc.2)

Contrato de la Ola 1 §11 y de la Ola 0 §5. OpenAPI de `drinks-on-chain-back` en `dev` tras la retirada (`c9e96e5`: 112 operaciones, 138 esquemas). Detalle y migración en el CHANGELOG.

| Retirado | Queda |
|---|---|
| `tokens.refreshToken` en las respuestas de sesión (`login`, `refresh`, `switch-organization`, `mfa/*`, aceptar invitación) | Solo la cookie `doc_rt` (`AuthTokensSchema.refreshToken` opcional y `@deprecated`; se borra en 0.5) |
| Refresco en el cuerpo de `refresh`, `logout` y `switch-organization` | `refresh`/`logout` no leen el cuerpo; `switch-organization` con `refreshToken` → 422 `VALIDATION_ERROR` (`details[{ field: 'refreshToken' }]`) |
| `user.userRole`, `user.wineryId`, `user.memberRole` (sesión) y `userRole` de `/users/me` y de los fixtures de personas | `memberships` + `activeOrganizationId` |
| Claims `email`, `userRole`, `wineryId`, `memberRole` | `sub, aud, org, orgType, role, sid, jti, iat, exp` |
| `signup` con `userRole` | `signup` solo de consumidores; `userRole` → 422 |
| `POST /v1/wineries`, `GET /v1/wineries/pending`, `POST /v1/wineries/{id}/approve|reject`, `GET|POST /v1/wineries/my/members`, `POST /v1/wineries/my/members/create` | 404; sustitutas: solicitudes, alta directa, `/organizations/current/members` e `/invitations` |
| Esquemas `CreateWinerySchema`, `AddMemberSchema`, `CreateMemberSchema`, `ApproveWinerySchema`, `RejectWinerySchema`, `RefreshTokenSchema`, `UserRoleSchema`/`USER_ROLES`, `SignupRoleSchema`/`SIGNUP_ROLES`; `DEPRECATED_ROUTES`; código `WINERY_NOT_PENDING` | — |

## 9. Lista de espera (mocks 0.4.1)

Contrato `plan/contratos/o1b-lista-de-espera.md` (añadido a la Ola 1). OpenAPI del backend desplegado (`v0.1.1`: 118 operaciones, 149 esquemas); `pendientes.json` sigue vacío. Código de referencia: `src/modules/waitlist` de `drinks-on-chain-back`. Donde el contrato escrito y el OpenAPI difieren, manda el OpenAPI:

| Tema | Contrato escrito | Backend real (y mocks) |
|---|---|---|
| Permisos | «ADMIN, OPERATIONS, SUPPORT» leen; «ADMIN, OPERATIONS» escriben | Capacidad `waitlist` en la matriz (`GET /v1/platform/permissions`): `FULL` para `SUPERADMIN`, `ADMIN` y `OPERATIONS`; `READ` para `SUPPORT`. Lectura (`GET /v1/platform/waitlist`, `/sources`): `FULL` o `READ`; `PATCH` y `/export`: `FULL` |
| `GET /v1/platform/waitlist/sources` | `{ source, count }[]` | Arreglo plano (no una página), del origen más numeroso al menos; `source: null` = sin origen; filtro opcional `?type=` |
| CSV de `/export` | «sin IP ni agente de usuario» | Columnas = claves de `WaitlistEntry` sin `id`, con `position` delante: `position,type,status,fullName,email,phone,city,interest,wineryName,region,produces,message,locale,source,consentAt,createdAt,contactedAt,contactedBy,notes`. UTF-8 con BOM, CRLF, apóstrofo delante de `= + - @`; `Content-Disposition: attachment; filename="lista-de-espera-AAAAMMDD-HHMM.csv"`, `Cache-Control: no-store`, `X-Export-Rows`; acepta también `q`; en orden de llegada; más de 50.000 filas → 422 `WAITLIST_EXPORT_TOO_LARGE` |
| `POST /v1/public/waitlist` | Opcionales `?:` | Los opcionales admiten `null` y un texto vacío cuenta como ausente; `source` se pasa a minúsculas; `isAdult` en una bodega es opcional (booleano si llega); un detalle por campo en el 422 |
| `PATCH /v1/platform/waitlist/{id}` | `CONTACTED` guarda `contactedAt` y quién | Además: volver a `NEW` los borra, `DISCARDED` los conserva, `notes: null` o vacío borra las notas y sin cambios devuelve la inscripción tal cual, sin evento en la bitácora |
| Filtros | `type, status, source, q, from, to` | `source` exacto y en minúsculas (no hay forma de pedir «sin origen»); `from`/`to` como en la bitácora (`AAAA-MM-DD` = día completo UTC, o ISO); `q` (≤ 200) busca en nombre, correo y bodega sin distinguir mayúsculas, y en el teléfono |
| Tablero | Bloque aditivo | `waitlist` es obligatorio en `DashboardResponseDto` |
| Bitácora | Tres acciones | `WAITLIST_JOINED` (`after: { type, source }`, origen `PUBLIC`), `WAITLIST_STATUS_CHANGED` (`before: { status }`, `after: { status, notesChanged }`), `WAITLIST_EXPORTED` (`resource.id: null`, `after: { rows, filters }` sin el texto buscado); recurso `waitlist_entry` |
| `GET /v1/public/waitlist/stats` | Caché de 60 s | `Cache-Control: public, max-age=60` |

Decisiones de los mocks:

- **Límites**: se simula el de 3 inscripciones por hora del mismo correo (429 `TOO_MANY_REQUESTS` con `Retry-After`; hora real, como el bloqueo del login; `resetErpDb()` lo reinicia). Los límites por IP (20 por minuto, 300 por hora) no se simulan.
- **Captcha**: opcional, como el backend sin `WAITLIST_CAPTCHA_REQUIRED`; un `captchaToken` que contenga `fail` responde 422 `CAPTCHA_INVALID` (convención de los mocks) para poder probar esa pantalla.
- **Posición**: la siguiente a la mayor del tipo (el backend usa un contador por tipo; es lo mismo mientras no se borren inscripciones).
- **Bitácora de los fixtures**: `audit.json` no cambia (163 eventos): las 52 inscripciones sembradas no tienen eventos, para no alterar las pantallas y pruebas de la bitácora de 0.4.0. Las que se crean, cambian o exportan en la sesión sí los dejan.
- **Fechas** sin milisegundos, como el resto de los mocks (el backend las devuelve con ellos).
- **`{id}` que no existe** (o que no es un UUID) → 404 `NOT_FOUND`.
- No se guardan ni la IP ni el agente de usuario ni `isAdult` (el backend los guarda y no los devuelve).

Datos de demo: 52 inscripciones (38 consumidores, 14 bodegas) entre el 12 y el 25 de septiembre de 2026; `tarija-2026` (32), `instagram` (6), `boletin` (3), `qr-cata` (3) y sin origen (8); 38 `NEW`, 10 `CONTACTED` (por Valeria Méndez, Camila Torrez o Jorge Salinas) y 4 `DISCARDED`; 7 de las últimas 24 h. Ven la lista `gestor@`, `administracion@`, `operaciones@`, `analista@` y `soporte@drinksonchain.test`; todos menos soporte la editan y la exportan.
