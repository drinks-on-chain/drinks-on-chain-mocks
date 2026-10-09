# Contrato OpenAPI ↔ mocks

Revisión del 25-09-2026, actualizada el 09-10-2026 con la **apertura de la Ola 3: tokenización y cadena** (mocks 0.6.0-rc.1: §13), el 02-10-2026 con las **precisiones del backend de la Etapa 2** (mocks 0.5.0-rc.2: §11), el 01-10-2026 con el **ERP v2 y el dominio público de la Ola 2** (mocks 0.5.0-rc.1: §10), el 27-09-2026 con el **backend real de la Ola 1 completa** (mocks 0.4.0-rc.1: §7) y antes con el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro, §0 de este documento, con sus precisiones del §8), el OpenAPI del backend de la Ola 0 (O0-BE-2 y **O0-BE-4**: sesiones, membresías, estado `INVITED`) y el **contrato de la Ola 1** (`plan/contratos/o1-backoffice-y-bodegas.md`, §6, con las precisiones del §11 bis). Comparado contra `openapi/erp.json` (el `openapi.json` de `drinks-on-chain-back` en `dev`, commit `eace713`, igual al de `https://136.243.223.39.sslip.io/docs-json` el 27-09-2026: 102 rutas, 119 operaciones, 144 esquemas; antes, el de O0-BE-4, commit `c224e0a`, 48 operaciones), contra los guards del backend (`AccessTokenGuard`, `AuthorizationGuard`, `TenantGuard`, `@Roles` de cada controlador) y `docs/arquitectura/identidad.md` de `drinks-on-chain-back` y contra respuestas reales del servidor sin credenciales (401, 400, 404). Complementa el doc 09 §8 de `drinks-on-chain-docsfront`. Regla: donde el catálogo o las guías del backend discrepan del OpenAPI, manda el OpenAPI.

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
| 8 | `GET /traceability/public/:lotCode` | Público (`@Public()`); responde el grafo DAG | Retirada en el cierre H2 (§12): 404. La sustituye `GET /v1/public/passports/{code}` |
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
| 22 | `GET /traceability/dag/:id` | Sin `@OrgType` ni `@Roles`: cualquier sesión, sin filtrar por bodega | Retirada en el cierre H2 (§12): 404. La sustituye `GET /v1/lots/{id}/graph` (solo la bodega dueña y la plataforma) |
| 23 | Archivos | `POST /v1/uploads` solo personal, tipo por firma de bytes (JPEG, PNG, WEBP, GIF ≤ 5 MB; PDF ≤ 15 MB), clave privada `org/<id>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>` y URL firmada de 15 min; `GET /v1/uploads/url?key=` | Igual (0.4): consumidor → 403 `FORBIDDEN`; tipo que no coincide → 422 `FILE_TYPE_NOT_ALLOWED` en `file`; demasiado grande → 413 `FILE_TOO_LARGE`; clave de otra organización → 404 `FILE_NOT_FOUND`. La URL `/mocks/uploads/<clave>?expires=…&signature=mock` no sirve ningún archivo |
| 24 | Rutas obsoletas | Retiradas en H1 (404): `POST /wineries`, `wineries/pending`, `wineries/{id}/approve|reject`, `wineries/my/members*`. La maquinaria `deprecated` + `x-replaced-by` + `Deprecation`/`Link` queda para próximas retiradas | Igual: sin rutas; `RouteSpec.deprecated` se conserva y la prueba de contrato exige las mismas obsoletas que el OpenAPI (ninguna tras H1; desde 0.5, las tres legadas del §10.1) |
| 25 | Trazabilidad de la Ola 2 | Lote como entidad, reglas en el servidor, códigos de botella, expediente y pasaportes públicos (163 operaciones) | §10. Desde 0.5 los puntos 10, 15, 16, 17, 18, 19 y 22 de esta tabla quedan sustituidos por las reglas del §10.2 (análisis opcional en el pesaje, candados en meses de calendario, D.O. calculada, tanque cerrado por la operación, QR del Marketplace, grafo restringido) |

## 3. Permisos aplicados por los handlers

Desde 0.3.0-rc.2, la matriz de los guards del backend (`@OrgType('WINERY') @Roles(...)` de cada controlador en `origin/dev`, `docs-back/05` §3 y `docs/arquitectura/identidad.md`), con el **rol de la membresía activa**. Regla `winery(...)` en `src/erp/handlers/auth-context.ts`; `resolveTenant` hace de `TenantGuard`.

| Ruta | OWNER | ENOLOGIST | AGRONOMIST | OPERATOR | ACCOUNTANT |
|---|---|---|---|---|---|
| Parcelas: alta y edición | ✅ | — | ✅ | — | — |
| Parcelas: lectura | ✅ | ✅ | ✅ | ✅ (mínima, §11 bis; desde 0.4) | ✅ |
| Vendimia (pesaje): alta | ✅ | ✅ | ✅ | ✅ | — |
| Vendimia: lectura | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dictamen fitosanitario (`phyto-decisions`) | ✅ | ✅ | ✅ | — | — |
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
- **Cualquier sesión**: `users/me*`, `POST /uploads`, `switch-organization`, `logout-all`. **Públicas**: `GET /v1/public/*` (pasaporte, directorio y borrador del catálogo), `GET /health`, `signup`, `login`, `refresh`, `logout`.
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

## 10. Ola 2 · ERP v2 y dominio público (mocks 0.5.0-rc.1)

Contrato `plan/contratos/o2-erp-confiable.md` (§2–§13, §16–§18). OpenAPI de `drinks-on-chain-back` en `dev` en la apertura de la ola (`bfda9bd`, igual al del servidor de desarrollo el 01-10-2026: 141 rutas, 163 operaciones, 271 esquemas; 45 operaciones nuevas). El backend declara todas las rutas con sus DTO y responde **501** en las que aún no implementa (transiciones de tanque, descartes y cierre de la destilación, códigos de botella, laboratorio por lote, correcciones, expediente, vistas, adjuntos y pasaportes públicos); los mocks las implementaron todas con las reglas del contrato. **Desde `rc.2` el backend ya no tiene ninguna ruta con 501 y los mocks siguen su código: las filas de esta sección que cambian están en §11.** Código de referencia portado: `src/modules/lots/domain/*` del backend (`src/erp/trace/` de este repo).

### 10.1 Contrato escrito ↔ OpenAPI (manda el OpenAPI)

| Tema | Contrato escrito | OpenAPI (y mocks) |
|---|---|---|
| Listas | Varias «devuelven la lista» | Análisis de madurez, dictámenes, correcciones, adjuntos, análisis del lote, códigos de botella y directorio de bodegas son páginas `{ items, total, limit, offset }` |
| Tanque (`FermentationTankResponseDto`) | `availableLiters`, `transferLossLiters`, `transitions` | En la apertura solo añadía `lotId`, `finalVolumeLiters` e `inputs`; **desde la Etapa 2 (rc.2) los tiene los tres** (§11) |
| Destilación (respuesta) | Objeto `cuts` | Campos planos `headsLiters`, `heartLiters`, `tailsLiters`, `vinasseLiters`, `heartAbvPercent` (el cierre sí recibe `cuts`) |
| Destilación (alta) | `closeTank`; `inputVolumeLiters` obligatorio | `closeTank` llegó con la Etapa 2 (rc.2); `inputVolumeLiters` sigue opcional |
| Registros corregidos | `correctedFields`, `voided`, `correctionIds` en cada recurso | Llegaron con la Etapa 2 (rc.2), **opcionales** en el DTO: los llevan los registros que responde su propia ruta (§11) |
| `TraceActor` | `role` enumerado; siempre presente | `role` es texto y `createdBy`/`decidedBy`/`by` son anulables (registros migrados sin autor) |
| `MaturityAnalysis`, `PhytoDecision` | — | Llevan además `source` (`ERP` o `MIGRATION`) |
| `POST …/phyto-decisions` | Devuelve el dictamen | 201 con el **pesaje** completo (con `phytoDecisions`) |
| Informes (`report`, `inspectionReport`) | `{ key, sha256, url }` | `sha256` y `url` anulables |
| Laboratorio (respuesta) | `conformity` | Además `conformityStatus` y `supersededAt` (obligatorios) y `methanolMg100mlAa` |
| Reporte de producción | Totales por tipo | `totals` incluye `UNDECIDED` (lotes sin tipo decidido) |
| Rutas obsoletas | Todas las legadas con `Deprecation` | Solo 3 están `deprecated` (`PATCH …/phyto-status`, `GET /v1/traceability/dag/{id}`, `GET /v1/traceability/public/{lotCode}`) y sin `x-replaced-by`; `POST /v1/bottling` y `POST /v1/lab-analyses` no lo están. Los mocks marcan esas tres, con la sustituta del contrato §16.2 |
| Tanque sin completar | `TRC_TANK_NOT_COMPLETED` al crear crianza o destilación | El backend de la apertura no lo exige. Los mocks tampoco hasta H2: un tanque `FILLING`/`FERMENTING` se cierra con la operación (solo `CLEANED` → 409) |
| Catálogo (`/v1/public/collections`) | §17.1, borrador | No está en el OpenAPI (10.4) |

### 10.2 Reglas que aplican los handlers

Mismas reglas por las rutas nuevas y por las legadas (`src/erp/trace/records.ts`, `bottling.ts`, `dossier.ts`). Cada incumplimiento responde su código `TRC_…` (`TRACE_ERROR_CODES`) y `details[{ field?, message, code, rule?, expected?, actual?, meta? }]`: `rule` es la clave del parámetro de configuración, `expected`/`actual` los valores y `meta` lo que la UI necesita (fecha de desbloqueo, días que faltan, ids).

- **Instantánea de reglas** al crear el lote (configuración efectiva de la bodega, con sus excepciones legales A-31); un cambio posterior en el back office no afecta al lote. Los lotes migrados la llevan con `origin: 'MIGRATION'`.
- **Etapa derivada** (`ORIGIN → HARVEST → FERMENTING → AGING | DISTILLING → RESTING → BOTTLED → CERTIFIED`; `REJECTED`, `DISCARDED`); un lote terminal no admite escrituras (409 `TRC_LOT_TERMINAL`).
- **Dictamen** solo por inserción y bloqueante; **D.O.** calculada (`ELIGIBLE`, `ELIGIBLE_BY_EXCEPTION`, `NOT_ELIGIBLE`), nunca declarada.
- **Candados** de crianza (meses de calendario) y de reposo (días desde el cierre de la destilación) con el reloj de los mocks en la zona `America/La_Paz`; `advanceMockClock(ms)` los libera (evento `LOCK_RELEASED` sin actor).
- **Embotellado**: una sola vez por lote, con todas sus fuentes; balance de volumen, de alcohol puro (tolerancia 0,5 %) y merma (`trazabilidad.embotellado.mermaMaximaPorcentaje`); el vino no admite agua. `POST …/bottling/preview` devuelve las mismas infracciones sin escribir.
- **Laboratorio**: conformidad calculada con los límites de la instantánea (singani: metanol en mg/100 mL de alcohol anhidro, cobre y grado; vino: acidez volátil y grado; falta uno → `INCOMPLETE`). Un grado que difiere más de 0,5 % vol del embotellado es un aviso, no un bloqueo. Un análisis nuevo sustituye al anterior.
- **Correcciones** compensatorias con lista cerrada de campos y revisión de integridad (422 `TRC_CORRECTION_BREAKS_RULES` con la regla que se rompería); **expediente**: cierre con laboratorio conforme y sin incidencias, después solo lectura (409 `TRC_DOSSIER_CLOSED`).
- **Permisos** (contrato §11): la plataforma solo lee (403 `TRC_PLATFORM_READ_ONLY`); lo de otra bodega, 404; el grafo, además, 404 para consumidores (SE-07).
- Una escritura que falla no deja nada a medias ni avanza el reloj.

### 10.3 Decisiones de los mocks (lo que ni el contrato ni el OpenAPI fijan)

| Tema | Mocks |
|---|---|
| Códigos de botella | 8 caracteres Crockford con control Luhn mod 32, como el backend, pero **deterministas** (`mockBottleCode(lotId, serie, generación)`) y sin fila por botella: `bottle-lots.json` guarda el total, las series sustituidas, los anulados y los rangos exportados. El backend los generará al azar |
| Huella del expediente | Desde `rc.2`, la forma `doc-dossier/1` del backend (§11.2). La huella de un lote real y la de su copia en los mocks siguen sin coincidir: cambian los ids, los instantes y los códigos de botella |
| Raíz Merkle | Desde `rc.2`, la construcción del backend: el padre es SHA-256 de los **bytes** concatenados (§11.2). `merkleLeaf`, `merkleParent`, `merkleRoot`, `merkleRootFromProof` y `verifyMerkleProof` se exportan para que el visor compruebe la prueba |
| URL del QR | `{URL del Marketplace}/b/{código}` (`setMockAppUrls({ MARKETPLACE })`; `http://localhost:3005` en los fixtures) |
| Referencias | Lote `{prefijo}-L{año}-{NNN}`; código de lote `{prefijo}-{año del embotellado}-{WINE\|SINGANI}-{NNN}`; pesaje `HARV-{año}-{parcela}-{NNN}` |
| Exportación ZIP | `PENDING` en la solicitud y en la primera consulta; `READY` en la segunda, con una URL firmada que, desde `rc.2`, descarga un ZIP de verdad (§11.3). El CSV es inmediato |
| Enumeración de códigos | Más de 20 códigos **inexistentes** en 10 min desde una IP (`X-DOC-Client-IP` o `X-Forwarded-For`) → 429 con `Retry-After`, con el reloj de los mocks. Los mal formados (422) no cuentan. El límite general de 60 peticiones por minuto no se cuenta: el escenario `pasaporte-saturado` responde como si se hubiera superado (§11.4) |
| Caché pública | `Cache-Control: public, max-age=60` (3600 el pasaporte de un lote certificado; el de una botella, siempre 60) y `ETag` con `If-None-Match` → 304; el 404, 30 s; 422 y 429, `no-store` |
| Panel de la bodega | Avisos: última lectura > 32 °C, tanque en fermentación sin lecturas en 48 h, candados que vencen en 14 días |
| Grafo legado | `GET /v1/traceability/dag/{id}` con datos reales: sin métricas fijas, `isCertified` = expediente cerrado, operador de la línea de tiempo o «No registrado» |
| Bitácora | Las escrituras nuevas dejan su evento (`CORRECTION_REGISTERED`, `MATURITY_ANALYZED`, `PHYTO_DECIDED`, `TANK_TRANSITION`, `DISTILLATION_CLOSED`…). `audit.json` pasa de 163 a 161 eventos por las dos filas retiradas de la semilla |
| Persistencia | La trazabilidad sigue solo en memoria: recargar la página vuelve a los fixtures (o al escenario de datos elegido). La identidad y el back office siguen en `localStorage`; un estado guardado por 0.4 se descarta |
| El Portillo (Altos, 1.540 m) | Los fixtures de la Ola 1 dan a Altos `trazabilidad.singani.altitudMinimaMsnm` = 1.500 con excepción legal, así que allí es `ELIGIBLE_BY_EXCEPTION`. Para la prueba negativa del §18 sin tocar la configuración, usa la parcela de Vischoqueña de Cinti Viejo (cepa no admitida) o retira el ajuste (`POST /v1/platform/settings/{key}/overrides/reset`) |

### 10.4 Borrador del catálogo (fuera de la prueba estricta)

`GET /v1/public/collections` y `/v1/public/collections/{slug}` (contrato §17.1) **no están en el OpenAPI** ni lo estarán en esta ola: los fija el OpenAPI borrador de la Etapa 4 (O3-PK-1). Los mocks los adelantan solo para la pantalla 2A del Marketplace y pueden cambiar sin aviso. Están excluidos de la comparación estricta con el OpenAPI de forma explícita: `openapi/pendientes.json` → `adelantadas` con `"borrador": true`, su `RouteSpec` lleva `draft` y responden la cabecera `X-Mock-Draft: plan/contratos/o2-erp-confiable.md §17.1`. Se validan solo contra sus esquemas zod (`PublicCollectionSummarySchema`, `PublicCollectionSchema`, marcados `@experimental`). Las colecciones se derivan de los lotes (una por lote embotellado o en proceso); precios y disponibilidad son de ejemplo.

### 10.5 Datos de demo

| Dato | Para qué |
|---|---|
| **«Singani Gran Reserva 2026»** (Cinti Viejo, `SINGANI_CASE`; lote `CVJ-L2026-005`, código `CVJ-2026-SINGANI-004`): 18.400 kg de la Parcela 2 → 12.100 L → corazón de 1.500 L al 60 % → 180 días de reposo → 2.950 botellas de 75 cL al 40 % (agua 750 L, merma 1,67 %) → laboratorio conforme → expediente cerrado. Serie 17 con un código anulado y sustituido | Caso del contrato §18; pasaporte de botella con prueba Merkle |
| Cinti Viejo: «Moscatel de Alejandría 2026» en reposo (candado al 13-10-2026), tres lotes embotellados (`CVJ-2026-SINGANI-001`, `-002`, `CVJ-2026-WINE-003` sin laboratorio), «Singani El Molino 2026» destilando, «Singani Edición Aniversario 2026» en origen, un lote en vendimia y un pesaje sin lote | Todas las etapas; panel (embotellado sin laboratorio, listos para cerrar, dictámenes pendientes) |
| Altos: dos lotes en crianza (candados al 03-11-2026 y 28-02-2027), dos fermentando (uno con una lectura a 33,4 °C), `ALT-2026-WINE-001` embotellado, uno rechazado, uno descartado y dos en vendimia (pendiente y cuarentena) | Candados, alertas, dictamen bloqueante |
| Escenarios de datos: `lote-en-reposo` (faltan 10 días), `lote-listo` (reposo cumplido, sin embotellar), `laboratorio-no-conforme` (embotellado, metanol sobre el límite), `lote-con-incidencia` (`CVJ-2026-SINGANI-002` con una incidencia de migración abierta) | Pantallas de embotellado, laboratorio, expediente e incidencias |
| Personas de Cinti Viejo: `enologa@`, `operario@`, `agronomo@` y `admin@cintiviejo.test` (claves `cvj_enologa`, `cvj_operario`, `cvj_agronomo`, `cvj_admin`) | Roles del recorrido H2 |
| `publicFixtures.bottleCodes`: códigos de muestra de cada lote embotellado (series 1–3 y la última; del caso, además la 17 activa y la anulada) | Visor `/b/{código}` y e2e |

## 11. Ola 2 · precisiones del backend con la Etapa 2 completa (mocks 0.5.0-rc.2)

OpenAPI de `drinks-on-chain-back` en `dev` (`8e85935`), idéntico al del servidor de desarrollo el 02-10-2026: 163 operaciones, 272 esquemas (`TankTransitionResponseDto` es el nuevo) y **ninguna ruta con 501**. Código y documento de referencia: `src/modules/lots/` y `docs/arquitectura/trazabilidad.md` del backend. Comprobado contra el servidor: `GET /v1/public/passports/CVJ-2026-SINGANI-001` real pasa `PublicLotPassportSchema` (estricto) y coincide con el fixture del mismo lote salvo los milisegundos de los instantes, la hora del pesaje (el backend guarda solo el día) y la fecha de la migración.

### 11.1 Contrato escrito ↔ OpenAPI final (manda el OpenAPI)

| Tema | Contrato escrito | OpenAPI final (y mocks) |
|---|---|---|
| Marcas de corrección | `correctedFields`, `voided`, `correctionIds` en cada recurso | **Opcionales** en el DTO (`CorrectableResponseDto`): las llevan los registros que responde su propia ruta; los anidados pueden no traerlas. Los mocks las ponen siempre en el recurso y en sus lecturas, tratamientos, análisis y dictámenes |
| `voidedAt` | — | Solo en lecturas, tratamientos y análisis de laboratorio. Los análisis de madurez y los dictámenes llevan `voided`, sin `voidedAt` (en el expediente canónico sí lo tienen) |
| Prueba Merkle del pasaporte | — | `PublicMerkleProofDto` = `{ salt, path }`, **sin la raíz**: quien verifica la lee de `bottleCodes.merkleRoot` en los bytes de `GET /v1/public/lots/{lotCode}/dossier` (o en `LotDossierDto.bottleCodes`) |
| Fechas de la fermentación del pasaporte | Fechas de calendario | `string` sin formato; el backend envía **instantes** (`2025-03-11T14:30:00.000Z`) |
| Exportaciones de códigos | Solo la ZIP tiene estado | `BottleCodeExportDto` lleva `format` (`CSV`/`ZIP`), `fromSerial` y `toSerial`: `GET …/exports/{id}` devuelve también una descarga CSV (su id viaja en `X-Export-Id`); `createdBy` anulable |
| Autores | Siempre presentes | `createdBy`, `voided.by` y el `by` de las transiciones son anulables («no registrado») |
| `PATCH /v1/terroirs/{id}` | — | Declara el 409 (`TRC_TERROIR_IN_USE`) |
| Corrección que incumple una regla | Siempre 422 `TRC_CORRECTION_BREAKS_RULES` | Si la regla es de un embotellado **ya hecho** (candado, balance, merma, alcohol, agua, fuentes), la corrección se registra y abre una incidencia `CORRECTION`; el 422 queda para lo que aún se puede evitar |
| Descarte de una crianza o una destilación | Sin evento propio | Evento interno `LOT_DISCARDED` con `data.scope: 'SOURCE'` |
| Tanque sin completar | 409 `TRC_TANK_NOT_COMPLETED` | Hasta H2 solo para `TRANSFERRED` y `CLEANED`; desde `FILLING`/`FERMENTING` la operación lo completa |
| Limpieza del tanque | Solo desde `TRANSFERRED` | También desde cualquier estado si el lote está `DISCARDED` o `REJECTED` |
| Rutas obsoletas | Todas las legadas | Siguen siendo 3 (`PATCH …/phyto-status`, `GET /v1/traceability/dag/{id}`, `/public/{lotCode}`), sin `x-replaced-by` |
| Límite de metanol por defecto | — | 200 mg/100 ml a.a. (`settings.catalog.ts`); los mocks usaban 300 |

### 11.2 Expediente canónico y raíz Merkle

- **`doc-dossier/1`** (`CanonicalDossierSchema`): JSON canónico RFC 8785 con las propiedades `schema, closedAt, closedBy, winery, lot, rules, harvests, tanks, agings, distillations, bottling, labAnalyses, corrections, attachments, bottleCodes`. Medidas como cadenas de escala fija con la escala de su columna (kilos `"18400.000"`, litros de tanque y crianza `"12100.00"`, litros de destilación y embotellado `"1500.000"`, grados `"40.00"`, Brix y pH `"23.40"`, densidad `"1.0860"`); enteros como números; instantes en ISO 8601 con milisegundos; fechas `YYYY-MM-DD`; listas por fecha e id; personas `{ membershipId, role }`; sin notas, motivos, claves de archivos ni códigos de botella. La instantánea de reglas y la conformidad del laboratorio van tal como se guardaron. Los registros anulados siguen, con su `voidedAt`. Lo que no tiene dato va con `null`.
- **Vista previa**: con el expediente abierto, los bytes llevan `closedAt` y `closedBy` en `null` y `hashPreview` es su SHA-256: no cambia mientras no cambien los registros. `GET …/dossier/canonical` responde `X-Dossier-Status` (`OPEN`/`CLOSED`) y `X-Dossier-Hash`.
- **Raíz Merkle** (`sha256-merkle/serial-code-salt`): hoja = `SHA-256("{serie}:{código}:{sal}")` sobre el texto UTF-8, por serie, solo los códigos activos al cerrar; padre = `SHA-256(izquierdo ‖ derecho)` sobre los **32 bytes** de cada resumen; el nodo sin pareja sube tal cual; sin hojas, `SHA-256("")`. Un código anulado antes del cierre no tiene prueba; uno anulado después la conserva (y ya no se puede sustituir, S-14).
- **Verificar**: `sha256Hex(bytes) === dossier.hash` y `verifyMerkleProof(merkleLeaf({ serial, code, salt }), path, bottleCodes.merkleRoot)`.
- Lo que no es igual que en el backend: los actores de pesajes, tanques, crianzas, destilaciones y embotellado salen del autor de su evento en la línea de tiempo (los registros de los mocks no guardan su autor), y las sales de las hojas son deterministas.

### 11.3 Decisiones de los mocks (rc.2)

| Tema | Mocks |
|---|---|
| ZIP de códigos | Clave `exports/bottle-codes/{bodega}/{exportId}.zip` (fuera de `org/…`), como máximo 20.000 códigos activos por exportación (422 en `toSerial`), caduca a los 7 días (`downloadUrl: null`). El archivo que se descarga lleva `codigos.csv` (el mismo CSV) y un `LEEME.txt`: **las imágenes `qr/{serial}-{code}.svg\|png` no se generan** |
| CSV de códigos | Cabecera del contrato, una fila por código activo, UTF-8 con BOM, coma, CRLF y celdas neutralizadas contra fórmulas; `Content-Disposition: attachment; filename="codigos-{lotCode}-{desde}-{hasta}.csv"`, `X-Export-Rows`, `X-Export-Id` |
| Archivos de `/mocks/uploads/…` | Los sirven los handlers: imagen SVG (logotipo con monograma; botella con el nombre del archivo), PDF de una página o el ZIP de una exportación; otra extensión, 404. Opción `uploads: 'passthrough'` para que la app sirva los suyos. Con `next/image` hace falta `unoptimized` (el optimizador no pasa por MSW) |
| Historial del tanque | Los tanques nuevos guardan `transitions` desde el llenado; los migrados no: su único punto conocido es el llenado (`by: null`), como en el backend |
| Visibilidad de un adjunto | Queda como evento `FILE_ATTACHED` con `data.action: 'VISIBILITY_CHANGED'`; los mocks guardan además la visibilidad vigente en el adjunto |
| Incidencias al descartar una fuente | Se resuelven las de un código que se incumplía antes del descarte y ya no |
| Catálogo (borrador) | `featured` (lotes con el expediente cerrado y parte de los que están en venta), orden por defecto con las destacadas primero y después las más recientes; `sort=newest\|price-asc\|price-desc\|name`; las que no tienen precio, al final. No se ofrece un lote con el análisis no conforme |
| Límite de 60 consultas por minuto | No se cuentan las peticiones: el escenario `pasaporte-saturado` responde 429 `TOO_MANY_REQUESTS` con `Retry-After: 60` en todas las rutas del pasaporte. El de 120 de `/v1/public/wineries` no se simula |

### 11.4 Casos del pasaporte en los fixtures (`PASSPORT_CASES`)

| Caso | Código de lote | Qué muestra |
|---|---|---|
| `certified` | `CVJ-2026-SINGANI-004` | Expediente cerrado, laboratorio conforme, prueba Merkle de cada botella |
| `bottled` | `CVJ-2026-SINGANI-001` | Lote migrado embotellado, expediente abierto (el mismo que existe en el servidor de desarrollo) |
| `labNotRecorded` | `CVJ-2026-WINE-003` | Sin análisis: «No registrado» |
| `labNonConforming` | `ALT-2025-WINE-001` | Acidez volátil sobre el límite |
| `doByException`, `lateEntry` | `ALT-2025-SINGANI-002` | D.O. por excepción legal (1.540 m con el mínimo de la bodega en 1.500 m) y pesaje anotado 12 días después |
| `discarded` | `CVJ-2025-SINGANI-001` | Retirado tras embotellarse: `stage: DISCARDED`, todos sus códigos `VOIDED` |
| `wineryInactive` | `CUR-2026-SINGANI-001` | Casa Uriondo, suspendida: `winery.active: false` |

Códigos de botella de muestra de cada uno en `publicFixtures.bottleCodes`. Los escenarios de datos (`lote-en-reposo`, `lote-listo`, `laboratorio-no-conforme`, `lote-con-incidencia`) siguen rehaciendo el caso del §18.

## 12. Ola 2 · cierre H2: sin rutas legadas (mocks 0.5.0-rc.3)

Contrato: el OpenAPI de la **fase de cierre** del backend, rama `feat/o2-be-contraer` de `drinks-on-chain-back` (`9ca8111`): 137 rutas, 158 operaciones, 266 esquemas, ninguna operación `deprecated` ni con 501. Documento de referencia: `docs/arquitectura/trazabilidad.md` del backend, sección «Cierre H2: contracción (`v0.2.0`)», y `src/seed/corrections.ts`.

### 12.1 De dónde sale `openapi/erp.json` en esta versión (y cómo volver al servidor)

La fase de cierre **no está desplegada**: el servidor de desarrollo sigue sirviendo el OpenAPI de `rc.2` (163 operaciones, con las cinco rutas legadas). Por eso `openapi/erp.json` se fijó desde la rama, no desde el servidor:

```bash
git -C ../drinks-on-chain-back show origin/feat/o2-be-contraer:openapi.json > /tmp/openapi-h2.json
pnpm openapi:pull -- /tmp/openapi-h2.json
```

**No ejecutes `pnpm openapi:pull` contra el servidor mientras siga en la versión anterior**: traería de vuelta las rutas retiradas y la prueba de contrato fallaría (cada operación del OpenAPI exige su `RouteSpec`). Cuando el backend despliegue el cierre (su `v0.2.0`):

```bash
pnpm openapi:pull -- https://136.243.223.39.sslip.io/docs-json
pnpm test
```

El resumen del script debe decir «Mismas operaciones que antes» (158). Si añade o quita alguna, es un cambio del backend posterior a `9ca8111`: ajusta los esquemas y anótalo aquí.

**Hecho en 0.5.0 (04-10-2026)**: el servidor ya sirve el cierre (`b82beed`, `v0.2.0`) y `pnpm openapi:pull` contra él dio «Mismas operaciones que antes» (158) y un documento idéntico; la prueba de contrato pasa contra él. `openapi/erp.json` vuelve a salir del servidor.

### 12.2 Lo retirado y cómo responden los mocks

| Retirado | Respuesta de los mocks | En su lugar |
|---|---|---|
| `PATCH /v1/harvest-batches/{id}/phyto-status` | 404 | `POST /v1/harvest-batches/{id}/phyto-decisions` |
| `POST /v1/bottling` | 404 | `POST /v1/lots/{id}/bottling` y `…/preview` |
| `POST /v1/lab-analyses` | 404 | `POST /v1/lots/{id}/lab-analyses` |
| `GET /v1/traceability/dag/{bottlingBatchId}` | 404 | `GET /v1/lots/{id}/graph` |
| `GET /v1/traceability/public/{lotCode}` | 404 | `GET /v1/public/passports/{code}` o `/v1/public/lots/{lotCode}` |
| Pesaje: `brixDegrees`, `initialPh`, `initialAcidityGl` | 422 `VALIDATION_ERROR` en el campo | `maturity` o `POST …/maturity-analyses` |
| Pesaje: `phytosanitaryStatus` (cualquier valor) | 422 `TRC_PHYTO_IN_CREATE` | `POST …/phyto-decisions` |
| Parcela (alta y edición) y destilación: `isDoEligible` | 422 `VALIDATION_ERROR` | Calculado (`isDoEligible`, `doEvaluation` en la respuesta) |
| Tanque: `harvestBatchId` | 422 `VALIDATION_ERROR` | `inputs` (≥ 1) y `volumeFilledLiters`, obligatorios |
| Destilación: `processEndDate`, `outputVolumeLiters`, `wasteVolumeLiters`, `additionalParams` | 422 `VALIDATION_ERROR` | `inputVolumeLiters` obligatorio; el cierre, en `POST …/{id}/close` |
| Embotellado: `labelDesignUrl` | 422 `VALIDATION_ERROR` | `labelDesignKey` |
| Laboratorio: `laboratoryReportPdfUrl` | 422 `VALIDATION_ERROR` | `laboratoryReportKey`, obligatorio |
| Crianza o destilación desde un tanque sin completar | 409 `TRC_TANK_NOT_COMPLETED` | `POST /v1/fermentation-tanks/{id}/complete` antes |
| `TRC_PRODUCT_TYPE_MISMATCH` | Ya no existe | El tipo se deriva de las fuentes |

El 422 de un campo retirado copia el del backend (`forbidNonWhitelisted`): `details: [{ field: '<campo>', message: 'property <campo> should not exist' }]`. Los mocks solo rechazan así los campos de la tabla (`RETIRED_INPUT_FIELDS`); cualquier otro campo desconocido lo siguen descartando sin error, mientras que el backend responde el mismo 422 para **todos**. La prueba de contrato comprueba que cada campo de `RETIRED_INPUT_FIELDS` falta de verdad en su DTO del OpenAPI.

Los campos de respuesta no cambian. En los registros nuevos, `laboratoryReportPdfUrl` y `phytoInspectionPdfUrl` llevan la `key` del archivo y `labelDesignUrl` es `null` (la etiqueta está en `labelDesign.key`).

### 12.3 Aditivo

- `UploadResponseDto.sha256`: los mocks calculan la SHA-256 real de los bytes subidos y la recuerdan por `key` durante la sesión (`getErpDb().uploads`). El dictamen (`inspectionReport.sha256`) y el laboratorio (`report.sha256`) guardan esa huella; si la `key` no se subió en la sesión (los mocks no comprueban que el archivo exista), una estable derivada de la clave.
- `clean` de un tanque `COMPLETED` con alguna destilación ya salida y remanente: `TRANSFERRED` y `CLEANED` en el historial, en el mismo instante (`cleanedAt`). Sin ninguna salida → 409 `TRC_TANK_INVALID_TRANSITION`.

### 12.4 Diferencias vistas contra el backend real y huecos del ERP

| Tema | Antes (`rc.2`) | Ahora |
|---|---|---|
| `pendingPhyto[].intakeDate` del panel | Instante ISO | Fecha `AAAA-MM-DD` |
| Nombre del CSV del reporte | `reporte-de-produccion.csv` | `reporte-produccion-AAAA-MM-DD.csv` (día de La Paz del reloj de los mocks) |
| Escenario `empty` | Solo listas paginadas | También el panel y el reporte (bodega sin registros) |
| `?mock=<escenario>` | Se leía con la primera petición | Se guarda al arrancar el worker |
| `minAgingMonths` | 0 en todas las bodegas | Altos: 6 (ajuste por bodega); el resto, 0 |
| Corregir el volumen de una fuente ya embotellada | El balance usaba el volumen guardado al embotellar: no abría incidencia | Usa el volumen vigente de las fuentes (como `lot-integrity.ts` del backend): abre `TRC_BOTTLING_EXCEEDS_VOLUME` u otra del balance |

Lo que **no** cambia, porque el backend hace lo mismo:

- **`OPERATOR` no ve el panel**: `GET /v1/traceability/dashboard` es de `OWNER`, `ENOLOGIST`, `AGRONOMIST` y `ACCOUNTANT`; el reporte, de `OWNER`, `ENOLOGIST` y `ACCOUNTANT`.
- **`awaitingBifurcation`** solo es `true` con un tanque `COMPLETED` sin destino y sin usar. Como `complete` exige `destination`, con datos de la Ola 2 no ocurre (solo con registros anteriores). Es una incoherencia del contrato, no de los mocks.
- **Mensajes de error**: llevan las cifras con punto decimal y las fechas en ISO, como los del backend. La UI debe construir su texto con `details[].expected`, `actual` y `meta`.

### 12.5 Datos de demo

Las tres correcciones de realismo del cierre (las mismas que la semilla del backend aplica al cargar los fixtures):

| Registro | Corrección | Dónde |
|---|---|---|
| Tanques TK-06, TK-09 y TK-RED-04 | Se retiran, con sus eventos | Filas base (`generate.py` y `generate.ts`) |
| TK-08 (lote `CVJ-L2026-001`) | `COMPLETED` → `TRANSFERRED` | Filas base |
| TK-01 de Cinti Viejo (lote de `CVJ-2026-SINGANI-001`) | `TRANSFERRED` → `CLEANED` el 26-05-2025, con historial `FERMENTING`, `COMPLETED`, `TRANSFERRED`, `CLEANED` | `src/erp/seed/trace.ts` (tras la migración; cambiarlo en las filas base alteraría la secuencia pseudoaleatoria de las lecturas) |

Con ellas el backend puede copiar los fixtures de esta versión sin aplicar correcciones. Quedan 18 tanques y ninguno `COMPLETED`: para probar la crianza o la destilación hay que completar antes uno en fermentación (TK-04 y TK-10 del lote `ALT-L2026-001`, con destino vino; TK-15 de `ALT-L2026-005`, sin tipo decidido).

Pendiente: el mosto de `CVJ-L2026-001` y `ALT-L2026-001` equivale a ~1,0 L por kilo de uva (lo habitual es 0,65–0,75). No incumple ninguna regla; ajustarlo cambia los volúmenes de toda su cadena.

## 13. Ola 3 · tokenización y cadena (mocks 0.6.0-rc.1)

> Actualizada por el §14 (mocks 0.6.0-rc.2): OpenAPI de la rama de la emisión, `slug` por bodega, `stellar.toml` sin `[[CURRENCIES]]`, conciliación que cierra sola, correos y escenarios nuevos. Donde se contradigan, manda el §14.

Contrato `plan/contratos/o3-tokenizacion.md` (entero, con las «Precisiones de la apertura» del 08-10-2026) y el OpenAPI de la **apertura** del backend, rama `feat/o3-be-apertura` de `drinks-on-chain-back` (`157dee4`): 212 operaciones (54 nuevas, todas con sus DTO y con `501` donde aún no hay lógica) y 403 esquemas (137 nuevos; cambian `LotDto`, `LotSummaryDto`, `LotEventDto`, `PublicTimelineEventDto`, `LotDossierDto`, `PublicDossierDto`, `TraceDashboardDto`, `DashboardDto`, `WineryResponseDto` y `WalletResponseDto`). Los mocks implementan las 54 con las reglas del contrato y una red simulada.

### 13.1 De dónde sale `openapi/erp.json` en esta versión (y cómo volver al servidor)

La apertura **no está desplegada**: el servidor de desarrollo sigue sirviendo el OpenAPI de la Ola 2 (158 operaciones). `openapi/erp.json` se fijó desde la rama:

```bash
git -C ../drinks-on-chain-back show origin/feat/o3-be-apertura:openapi.json > /tmp/openapi-o3.json
pnpm openapi:pull -- /tmp/openapi-o3.json
```

**No ejecutes `pnpm openapi:pull` contra el servidor mientras siga en la versión anterior** (quitaría las 54 operaciones y la prueba de contrato fallaría). Cuando el backend despliegue la apertura: `pnpm openapi:pull -- https://136.243.223.39.sslip.io/docs-json` y `pnpm test`; el resumen debe decir «Mismas operaciones que antes» (212).

Los esquemas zod de `src/chain/schemas.ts` y `src/tokenization/schemas.ts` se generaron de los DTO de ese OpenAPI (mismos campos, mismos anulables; `XxxDto` = `XxxSchema` / tipo `Xxx`). La prueba de contrato valida de forma estricta, contra el OpenAPI, la respuesta de las 54 operaciones y los fixtures de `fixtures/chain/` y `fixtures/tokenization/`; `pendientes.json` solo lleva los borradores (catálogo y Marketplace).

### 13.2 Contrato escrito ↔ OpenAPI de la apertura (manda el OpenAPI)

| Tema | Contrato escrito | OpenAPI (y mocks) |
|---|---|---|
| `Idempotency-Key` | Sin cabecera → 422 `VALIDATION_ERROR` | 422 **`IDEMPOTENCY_KEY_REQUIRED`** con `details[0].field = 'Idempotency-Key'`. Obligatoria en: `POST /v1/lots/{id}/tokenization-requests`, `…/resubmit`, `…/approve`, `publish`, `pause` y `resume` de la colección, `closure/decide`, `transactions/{id}/retry` y `chain/pause`, `chain/unpause`. **No** en `withdraw`, `take`, `notes`, `request-changes`, `reject`, `close`, `abandon`, `chain/provision`, `alerts/{id}/resolve` ni al lanzar una conciliación |
| Listas | Varias «devuelven la lista» | Todas son páginas `{ items, total, limit, offset }`, también `GET /v1/platform/collections/{id}/transactions`, los NFT, las alertas, los eventos y los cierres |
| Códigos HTTP | — | `notes` y `approve` → 201; `chain/provision`, `chain/pause`, `chain/unpause` → **202** con `WineryChainIdentityDto`; lanzar una conciliación → 202 con `ReconciliationRunDto` |
| Imágenes de la colección | `{ key, sha256, url, alt, isCover }` | `CollectionImageDto` lleva además `id`; los bytes se sirven por `GET /v1/public/collections/images/{imageId}` (`image/png\|jpeg\|webp\|gif`, 404 `FILE_NOT_FOUND`) |
| Detalle de plataforma de una solicitud | `internalNotes?`, `priceSuggestion?` | `PlatformTokenizationRequestDto`: `internalNotes`, `priceSuggestion` y `review` **obligatorios** (la revisión va dentro de la solicitud); las rutas del back office que escriben devuelven esa misma forma |
| Cierre visto desde el ERP | `LotClosure` «sin datos de pedidos» | `WineryLotClosureDto`: los ítems no llevan `orderId`, `paidAt` ni `note` |
| Anulables | — | `explorerUrl` de la cuenta, del contrato y de la colección; `address`, `explorerUrl` y `checkedAt` de las cuentas de la plataforma; `wasmHash`, `codeTtlDays`; `operationsAccount`, `anchorAccount` y `officialAnchorAccount` (registro y verificación); `sourceAccount` y `maxFeeStroops` de la transacción; `productType` del lote de una solicitud; `chainCosts.since`; todo el borrador comercial de la solicitud (`CollectionCommercialDraftDto`) |
| Plataforma en rutas del ERP | «Lectura» | Lee con `?wineryId=` (`GET /v1/collections`, `/v1/tokenization-requests`, `chain-account`); si escribe → 403 **`TRC_PLATFORM_READ_ONLY`** (la cantidad la autoriza la bodega, A-03) |
| Lectores de la bodega | Dueño, enología («lectura») y contabilidad | `OWNER`, `ENOLOGIST`, `ACCOUNTANT` leen solicitudes y colecciones; NFT y cierre, `OWNER` y `ACCOUNTANT`; la cuenta de la bodega, todos los miembros |
| Permisos de plataforma | Tabla del §10 | Capacidades nuevas en `GET /v1/platform/permissions`: `tokenization` (`FULL` superusuario, administración y operaciones; `READ` soporte), `chain` (igual) y `chain.admin` (`FULL` solo superusuario y administración: abandonar una transacción, pausar o reanudar un contrato). `chain/provision` es de `chain` `FULL` |
| `GET /v1/users/me/wallet` | 404 al personal | 404 `CHN_WALLET_NOT_AVAILABLE` al personal (y a un consumidor sin dirección); al consumidor, `WalletResponseDto` con su dirección derivada |
| Campos legados de la bodega | Datos reales o `null` | `stellarPublicKey` = cuenta real o `null`; `onchainProducerId` siempre `null`; `onchainRegisterTxHash` = hash de la creación de la cuenta o `null` |
| Bloques nuevos | Aditivos | `LotDto.tokenization`, `LotSummaryDto.tokenization`, `TraceDashboardDto.tokenization` y `DashboardDto.tokenization` / `.chain` son **obligatorios** |
| Nombres | `CollectionMintStatus`; `ChainAlert.subject.type` enumerado | `MintStatus`; `subject.type` es texto libre |
| `stellar.toml` | Fuera de `/v1` | Declarado en el OpenAPI (`GET /.well-known/stellar.toml`, `text/plain`) |

### 13.3 Reglas que aplican los handlers

- **Cuota (§5.2)**: solo `OWNER`; lote con tipo (`TOK_LOT_PRODUCT_UNDEFINED`) y estimación (`TOK_LOT_ESTIMATE_MISSING`), en etapa anterior a `CERTIFIED` (409 `TOK_LOT_NOT_TOKENIZABLE` con `meta.stage`); una solicitud abierta por lote (409 `TOK_REQUEST_ALREADY_OPEN` con `meta.requestId`); límite sobre la estimación o, desde el embotellado, sobre los códigos activos (422 `TOK_QUOTA_EXCEEDS_ESTIMATE` / `TOK_QUOTA_EXCEEDS_BOTTLES` con `expected`, `actual` y `meta.maxQuantity`). El tipo lo deduce el servidor (`INITIAL` / `QUOTA_INCREASE`). Se revalida al editar, al reenviar y al aprobar. `PATCH /v1/lots/{id}` no baja la estimación de lo emitido (422 `TOK_ESTIMATE_BELOW_MINTED`).
- **Solicitud**: `SUBMITTED → IN_REVIEW → CHANGES_REQUESTED → SUBMITTED … → APPROVED | REJECTED`, `WITHDRAWN` desde cualquier estado abierto; fuera de sitio → 409 `TOK_REQUEST_INVALID_TRANSITION` con `meta: { from, to }`. Aprobar exige bodega `ACTIVE` (409 `TOK_WINERY_NOT_ACTIVE`), identidad `ACTIVE` (409 `TOK_WINERY_CHAIN_NOT_READY`), nombre, descripción y portada (422 `TOK_COMMERCIAL_DATA_INCOMPLETE`, un detalle por campo: `commercial.name`, `commercial.description`, `commercial.imageKeys`) y un nombre que no repita `slug` (409 `TOK_SLUG_TAKEN`). El precio puede faltar.
- **Colección**: `MINTING → READY → PUBLISHED ⇄ PAUSED → CLOSED` (409 `TOK_COLLECTION_INVALID_TRANSITION`); publicar o reanudar exige emisión confirmada (409 `TOK_MINT_NOT_CONFIRMED`), datos completos, bodega activa y contrato sin pausar (409 `CHN_CONTRACT_PAUSED`); con ventas el precio no cambia (409 `TOK_PRICE_LOCKED`); cerrar con un faltante sin resolver → 409 `TOK_CLOSURE_PENDING`.
- **Cadena**: reintentar solo una transacción `FAILED` (409 `CHN_TX_NOT_RETRYABLE`); emisiones, anclajes e identidad no se abandonan (409 `CHN_TX_NOT_ABANDONABLE`); `CHN_CONTRACT_ALREADY_PAUSED` / `CHN_CONTRACT_NOT_PAUSED`; `CHN_IDENTITY_ALREADY_ACTIVE`; `CHN_ALERT_ALREADY_RESOLVED`; `CHN_TX_NOT_FOUND`.
- **Hechos de otras olas**: activar una bodega aprovisiona su identidad; suspenderla o revocarla pausa sus colecciones publicadas (y, al revocar, rechaza sus solicitudes abiertas y pausa el contrato en la red); cerrar un expediente registra su anclaje y, al confirmarse, el lote pasa a `ANCHORED` (eventos `DOSSIER_ANCHORED` y `TOKENS_REDEEMABLE`, campos legados del embotellado, colección `redeemable` y `ON_SALE`).

### 13.4 Red simulada y reloj

Las rutas solo registran intenciones; la red las hace avanzar `PENDING → BUILDING → SUBMITTED → CONFIRMED`, un paso cada `CHAIN_STEP_MS` (3 s) **del reloj de la red**, y al confirmarse aplica los efectos (la emisión crea los NFT con ids `u32` continuos por contrato y números de botella continuos por colección; emisiones de más de 32.000 se parten en trozos).

| Control | Qué hace |
|---|---|
| `mockChain.advance(ms?)` | Adelanta el reloj de la red (por defecto, un paso) |
| `mockChain.settle()` | Hasta que no quede nada en vuelo |
| `mockChain.failNext({ kind?, code? })` | La siguiente transacción (o la siguiente de ese tipo) falla: `CHN_AUTH_FAILED` por defecto (definitivo → `FAILED` y alerta `TX_FAILED`, se reintenta con `…/retry`); con un código transitorio (`CHN_RPC_UNAVAILABLE`, `CHN_TX_TIMEOUT`, `CHN_BAD_SEQUENCE`, `CHN_INSUFFICIENT_FEE`, `CHN_TRY_AGAIN_LATER`, `CHN_ARCHIVED_ENTRY`) pasa por `RETRYING` y se confirma en el intento siguiente |
| `mockChain.setMode('auto' \| 'manual')` | `auto` (navegador): avanza con el tiempo real, como mucho un paso entre dos peticiones. `manual` (Node): solo con los controles |
| `mockChain.setMintEnabled(false)` | `CHAIN_MINT_ENABLED` (ADR-011): las emisiones esperan en `PENDING` con `CHN_MINT_DISABLED` |
| `mockChain.pending()` | Transacciones en vuelo |
| `advanceMockClock(ms)` | Además del reloj de los mocks, adelanta el de la red |

En el navegador, `window.__docMocks.chain` es `mockChain`.

### 13.5 Decisiones y suposiciones de los mocks

| Tema | Mocks |
|---|---|
| Direcciones y hashes | StrKey de 56 caracteres con versión y CRC16 correctos (`G…`, `C…`) y hashes hex de 64, derivados con SHA-256 de una clave propia de los mocks: tienen forma válida y **no existen en testnet** (`isValidStrKey`, `mockAccountAddress`, `mockContractAddress`, `mockTxHash`). El `wasmHash` tampoco es el de `deployments/testnet.json` |
| `explorerUrl` | Siempre lo construye el mock (`https://stellar.expert/explorer/testnet/{tx\|account\|contract}/…`); `null` solo mientras una transacción aún no tiene hash |
| URL de imágenes | `/v1/public/collections/images/{id}`, relativa como el resto de URL públicas de los mocks; se sirven desde que se aprueba la solicitud (el backend puede restringirlas hasta publicar). El archivo es un PNG de demostración |
| `token_uri` | `{PUBLIC_API_BASE_URL}/v1/public/nft/{slug}/{id}` con `http://localhost:4000` (opción `publicApiBaseUrl`) |
| Marca del lote | Con colección: `CLOSED`/`PAUSED`; si no, la última emisión (`MINT_FAILED`, `MINTING`); si no, `READY`/`PUBLISHED`. Sin colección: `REQUESTED` o `CHANGES_REQUESTED` |
| Rechazar | Solo desde `IN_REVIEW` (como aprobar y pedir cambios) |
| Reenviar | Vuelve a `SUBMITTED` sin persona asignada: hay que tomarla otra vez |
| Portada | Sin ninguna imagen marcada `isCover`, la primera lo es |
| `slug` | Sigue al nombre solo hasta la primera publicación |
| Cerrar la colección | Permitido si el lote aún no tiene cierre calculado o si está `NO_SHORTFALL` / `RESOLVED` |
| Cierre | Se calcula al consultarlo (lote embotellado o descartado) y se recalcula mientras no haya decisión. Decidir con faltante o con `BURN` exige `chain.admin` (403); sin faltante y `KEEP_ON_SALE` queda `RESOLVED` al momento |
| Conciliación | Termina en la misma petición. Como la red es la propia base, solo detecta lo que la base ya sabe incoherente (`TOTAL_MINTED_MISMATCH`, `QUOTA_EXCEEDED`, `BOTTLES_SHORTFALL`, `TX_STUCK`, `LOW_BALANCE`) y cierra solas las `TX_STUCK` ya terminadas; nunca corrige datos |
| `tokenizacion.requiereAprobacion = false` (S-11, no acordado) | La solicitud completa de una bodega con identidad `ACTIVE` se aprueba sola (`decision.by.system`) |
| Tablero | Las alertas abiertas de la cadena se suman a `alerts`; `indexerLagSeconds` fijo |
| `stellar.toml` | `ACCOUNTS`, `[DOCUMENTATION]` y una entrada `[[CURRENCIES]]` con `contract` por bodega |
| Persistencia | El estado de la Ola 3 vive solo en memoria (como la trazabilidad): recargar vuelve a los fixtures o al escenario |
| Línea de tiempo | Los hechos de tokenización de un lote ya avanzado se sembraron con su fecha: la línea de tiempo queda en orden cronológico |

### 13.6 Datos de demo y escenarios

| Dato | Para qué |
|---|---|
| Identidad `ACTIVE` de Cinti Viejo (`CVJ`), Altos (`ALT`) y Casa Uriondo (`CUR`); el resto, `NOT_PROVISIONED` | 1F, ficha de bodega, registro |
| **«Singani Preventa 2026»** (`PREVENTA_CASE`, Cinti Viejo, `CVJ-L2026-006`, en origen, estimación 3.000): solicitud con un cambio pedido, aprobada sin precio, 100 NFT, colección `PUBLISHED` en `PRESALE` | Recorrido H3 |
| «Singani Gran Reserva 2026»: `ANCHORED`, colección de 60 a Bs 280, `ON_SALE` y canjeable, cierre `NO_SHORTFALL` | Verificación 2E, compra 2C |
| «Singani El Portillo 2025» (Altos, embotellado): colección `READY` de 240 y una ampliación `SUBMITTED` de 500 | Publicar, ampliación, límite por botellas |
| Bandeja: «Singani El Molino 2026» `IN_REVIEW` con datos completos (y una retirada antes), «Tannat La Angostura 2024» `CHANGES_REQUESTED` (falta la portada), Casa Uriondo `REJECTED` | Bandeja 4C |
| Alertas: `LOW_BALANCE` resuelta y `TTL_EXPIRING` abierta; tres conciliaciones | Cadena |

| Escenario | Qué deja |
|---|---|
| `identidad-preparandose` | Altos recién activada: cuenta y contrato creándose; aprobar → `TOK_WINERY_CHAIN_NOT_READY` |
| `emision-en-curso` | «Singani Preventa 2026» recién aprobada, con la emisión avanzando |
| `emision-fallida` | La misma con la emisión `FAILED` (`CHN_AUTH_FAILED`) y su alerta; `…/retry` la confirma |
| `anclaje-pendiente` | «Singani Gran Reserva 2026» `CERTIFIED` con el anclaje en la red; al confirmarse, `ANCHORED` (el estado `normal` es el anclaje confirmado) |
| `faltante-botellas` | «Singani El Portillo 2025» con 20 NFT más que botellas (1.060 frente a 1.040): cierre `SHORTFALL_OPEN`. El escenario rehace la colección (otro id) |
| `alerta-evento-inesperado` | Alerta `CRITICAL` `UNEXPECTED_EVENT` por un `role_granted` ajeno en el contrato de Cinti Viejo |
| `cambios-pedidos` | «Singani Preventa 2026» en `CHANGES_REQUESTED` («falta la nota de cata») |

Los escenarios de la Ola 2 que rehacen el caso del §18 retiran también su anclaje y su colección.

### 13.7 Borrador del Marketplace (fuera de la prueba estricta)

Contrato §13.1; **no está en el OpenAPI** y puede cambiar. `GET /v1/me/consumer`, `POST|GET /v1/orders`, `GET /v1/orders/{id}` y `POST /v1/payments/test/{paymentId}/simulate` llevan `draft` y responden `X-Mock-Draft: plan/contratos/o3-tokenizacion.md §13.1`; en `pendientes.json` están como `borrador` y se validan solo contra sus esquemas zod (`ConsumerProfileSchema`, `OrderSchema`, `@experimental`).

- El catálogo (`/v1/public/collections`) añade `id`, `saleState` y `counts.available`; un lote con colección real **publicada** sale de ella (nombre, precio, disponibilidad, imagen), el resto sigue siendo de demostración.
- Reglas: solo consumidores; precio definido (422 `MKT_PRICE_UNDEFINED`), máximo por pedido (422 `MKT_MAX_PER_ORDER`, `compra.maxBotellasPorCompra`), existencias (409 `MKT_NOT_ENOUGH_STOCK`); la reserva caduca a los `compra.minutosReserva` (`EXPIRED`). `simulate`: `APPROVE` → `PAID`, `REJECT` → `PAYMENT_FAILED`, `DELAY` → sigue esperando. Con una colección real el pedido mueve sus NFT (`MINTED → RESERVED → SOLD`, o `REDEEMABLE` si el lote ya está anclado).
- No se adelanta: el alta con `202 VERIFICATION_SENT` (la ruta `POST /v1/auth/signup` es del OpenAPI vigente y se valida contra él), la entrega en la red (`transfer` queda en `null`) ni los estados `DELIVERING` y `COMPLETED`.

### 13.8 Pendiente para `rc.2`

> Hecho en `0.6.0-rc.2` (§14), salvo `NETWORK_RESET` y `BALANCE_MISMATCH`, que ningún control de los mocks provoca.

- Correos de la tokenización en el buzón simulado (solicitud recibida, cambios pedidos, aprobada, rechazada, NFT emitidos, colección publicada, faltante).
- Indexador y conciliación con más casos (`OWNER_MISMATCH`, `BURN_MISMATCH`, `PAUSE_MISMATCH`, `ANCHOR_MISMATCH`, `INDEXER_GAP`, `NETWORK_RESET`) y la tarea de TTL.
- Cierre con faltante: escenario con NFT **vendidos** sin botella (hoy se prueba forzándolo en la base) y sus avisos.
- Precisiones que anuncie el backend al implementar cada paso (3.1–3.6).

## 14. Ola 3 · precisiones del backend con los pasos 3.1–3.5 (mocks 0.6.0-rc.2)

El backend ya implementó la cadena, la identidad, las solicitudes, la emisión y el anclaje (pasos 3.1–3.5); queda el 3.6 (conciliación, alertas, eventos y cierre con faltante). Esta sección recoge lo que cambió desde la apertura (§13) y lo que pidieron el ERP, el Backoffice y el Marketplace. Donde contradice al §13, manda esta.

### 14.1 De dónde sale `openapi/erp.json` en esta versión

La Ola 3 **sigue sin desplegar**. `openapi/erp.json` se fijó desde la rama más avanzada del backend:

```bash
git -C ../drinks-on-chain-back fetch origin
git -C ../drinks-on-chain-back show origin/feat/o3-be-emision:openapi.json > /tmp/openapi-o3.json   # 66f33fd
pnpm openapi:pull -- /tmp/openapi-o3.json
```

Mismas 212 operaciones y 403 esquemas que la apertura (ningún DTO cambia). Cambian las respuestas declaradas: desaparece el `501` de las 43 operaciones ya implementadas (lo conservan las 11 del paso 3.6), `chain/provision`, `chain/pause` y `chain/unpause` declaran `CHN_DISABLED`, la verificación pública declara `Retry-After` en su 429 y varias descripciones se precisan. Sigue valiendo el aviso del §13.1: no ejecutes `pnpm openapi:pull` contra el servidor hasta que despliegue la ola.

### 14.2 Cambios del backend desde la apertura

| Tema | Apertura (rc.1) | Ahora (OpenAPI y mocks rc.2) |
|---|---|---|
| `slug` de la colección | Único global | Único **por bodega**. `TOK_SLUG_TAKEN` solo dentro de la misma bodega (al aprobar y al renombrar antes de publicar) |
| `PublicNftMetadata.external_url` sin pasaporte | `{MKT}/colecciones/{slug}` | `{MKT}/colecciones/{slugBodega}/{slug}`. Con pasaporte no cambia (`{MKT}/b/{lotCode}`) |
| `Mint.transactions` al aprobar | — | La respuesta de `…/approve` trae ya las `MINT_BATCH` registradas (`PENDING`, sin hash) |
| `GET /v1/public/lots/{lotCode}/verification` | `501` declarado | Implementada, mismo esquema. 429 con `Retry-After`. `pass: null` = aún no aplica; un anclaje fallido o a medias se publica `PENDING` y sin transacción (S-17) |
| Cadena sin configurar | — | 409 **`CHN_DISABLED`** en `chain/provision`, `chain/pause` y `chain/unpause`; el registro público sale con las cuentas en `null` y sin bodegas |
| Emisión con la bodega suspendida | — | La transacción espera en `PENDING` con `lastError.code = 'CHN_WINERY_NOT_ACTIVE'` (como `CHN_MINT_DISABLED`): ni falla ni abre alerta, y continúa al reactivarse la bodega |
| Alertas nuevas | — | `MINT_RANGE_MISMATCH` (`CRITICAL`, sujeto `MINT`: la emisión se confirmó pero su rango no cuadra; emisión `FAILED`, sin NFT y sin publicar) y `ANCHOR_MISMATCH` (`CRITICAL`, sujeto `LOT`: memo o cuenta de origen inesperados; el anclaje no se da por bueno) |
| `ChainAlert.subject.type` | Texto libre | **Sigue siendo texto libre** en el OpenAPI (`ChainAlertSubjectDto.type: string`, ejemplo `COLLECTION`); no es `ChainSubjectType`. El backend usa hoy `TRANSACTION`, `MINT`, `LOT`, `CONTRACT`, `PLATFORM_ACCOUNT` (id `OPERATIONS` \| `ANCHOR`) y `PLATFORM`. Los mocks usan esos, `COLLECTION` (conciliación) y `CHAIN_EVENT`, y exportan la lista orientativa `CHAIN_ALERT_SUBJECT_TYPES` |
| `stellar.toml` | `[[CURRENCIES]]` con el contrato de cada bodega | Sin `[[CURRENCIES]]` (S-7): los contratos, solo en `GET /v1/public/chain/registry` |
| Registro público | Bodegas `ACTIVE` | También las `PAUSED`, con `paused: true` |
| `abandon` / `retry` | — | `CHN_TX_NOT_ABANDONABLE` también por estado distinto de `FAILED` (`meta.status`); `CHN_TX_NOT_RETRYABLE` también si está abandonada |
| `PATCH /v1/platform/collections/{id}` | — | Declara `TOK_COMMERCIAL_DATA_INCOMPLETE` (imágenes sin portada); los mocks siguen tomando la primera como portada |
| `explorerUrl` del anclaje en el embotellado | — | **No está en el OpenAPI** (`BottlingBatchResponseDto` no lo declara): los mocks no lo añaden. El enlace es `LotDossier.anchor.explorerUrl` (y `Collection.anchor.explorerUrl`); el embotellado conserva los campos legados `blockchainAnchorTxHash`, `isAnchoredOnChain` y `anchoredAt` |

`CHN_WINERY_NOT_ACTIVE` y `MINT_RANGE_MISMATCH` no figuran en las listas del OpenAPI (el código de `lastError` y el de la alerta son texto): se implementan como los anunció el backend.

### 14.3 `slug` por bodega: antes y después

| | Antes (rc.1) | Después (rc.2) |
|---|---|---|
| Unicidad | Una colección por `slug` en toda la plataforma | Una por `slug` **dentro de cada bodega** |
| Enlace del NFT (`external_url`) | `{MKT}/colecciones/singani-preventa-2026` | `{MKT}/colecciones/destileria-cinti-viejo/singani-preventa-2026` |
| Ficha del catálogo (borrador) | `GET /v1/public/collections/{slug}` | `GET /v1/public/collections/{winerySlug}/{slug}` |
| Colisión en el catálogo de demostración | El segundo llevaba `-{slugBodega}` | Cada bodega conserva su `slug`; dos lotes de la **misma** bodega con el mismo nombre → el segundo lleva su referencia |
| Fixtures | Todos los `slug` distintos | `singani-preventa-2026` existe en Destilería Cinti Viejo (`PREVENTA_CASE`) y en Altos de Calamuchita (`SAME_SLUG_CASE`) |

La ruta nueva es del **borrador `marketplace`** (`draft: plan/contratos/o3-tokenizacion.md §13.1`, `borrador` en `pendientes.json`): la fijará el contrato de la Ola 4. La antigua sigue respondiendo, marcada obsoleta (`Deprecation: true`, `Link: </v1/public/collections/{winerySlug}/{slug}>; rel="successor-version"`), y con un `slug` repetido devuelve la primera del catálogo; se retira en `0.6.0`.

### 14.4 Decisiones de los mocks (rc.2)

| Tema | Mocks |
|---|---|
| Correos (§11) | Los servicios dejan avisos en `ChainState.notices` y cada petición (y `mockChain.advance/settle`) los convierte en correos. Al dueño de la bodega: solicitud recibida, cambios pedidos, aprobada, rechazada, NFT emitidos, colección publicada, pausada o reanudada y faltante. A operaciones y administración: solicitud nueva o reenviada y alertas `CRITICAL`. Enlaces propuestos: `/tokenizacion/solicitudes/{id}` y `/tokenizacion/colecciones/{id}` (ERP y Backoffice), `/cadena/alertas`; «NFT emitidos» enlaza al contrato en el explorador. La semilla y los escenarios no envían correos |
| Conciliación | Compara la base con lo que «dice la red»: la propia base más lo desviado con `mockChain.drift()`. Abre lo nuevo y **cierra sola** lo que ya no se reproduce, solo dentro del alcance y la profundidad de la ejecución. `LIGHT`: total emitido, cuota, faltante y, con alcance `ALL`, transacciones atascadas, saldos e indexador. `FULL`: además dueño y quema de cada NFT, pausa, roles y vida de cada contrato y del código |
| Vida del almacenamiento | `ChainState.ttl` guarda hasta cuándo viven el código y las entradas de cada contrato; `codeTtlDays` son los días que faltan según el reloj de los mocks (`null` si aún no se leyó). Menos de 14 días sin extensión en curso → `TTL_EXPIRING` (`CRITICAL` para el código, sujeto `PLATFORM`/`WASM`). `EXTEND_TTL` añade 30 días; el del código cuesta ≈ 6,5 XLM y lleva su propio tope de comisión |
| Indexador | `Dashboard.chain.indexerLagSeconds` es 12 salvo tras `mockChain.indexerGap()`, que además abre `INDEXER_GAP`; la siguiente conciliación con alcance `ALL` lo pone al día y cierra la alerta |
| Eventos | Cada contrato nace con `role_granted` y `base_uri_updated`; `topics` lleva el nombre y los argumentos indexados, como en `integracion/eventos/` del repo de contratos |
| Alerta de una transacción fallida | Como el backend: `CHN_INTENT_REJECTED` → alerta con ese código, `CHN_INSUFFICIENT_BALANCE` → `LOW_BALANCE`, el resto `TX_FAILED`; sujeto `TRANSACTION` |
| Cierre con vendidos | Cada NFT vendido recuerda su pedido: los ítems del cierre de la plataforma llevan `orderId` y `paidAt`; la bodega no los ve. `TokenDto` no lleva el pedido |
| Escenario `empty` | La cuenta de la bodega conserva su identidad y sale sin NFT, lotes, transacciones ni costes |
| `mockTokenization` | Actúa como el dueño de la bodega con los mismos servicios que las rutas del ERP; deja su entrada en la bitácora y sus correos |

### 14.5 Escenarios y ayudas nuevos

| Escenario | Qué deja |
|---|---|
| `faltante-vendidos` | «Singani El Portillo 2025» con 1.060 NFT, 1.040 botellas y 1.050 vendidos: de los 20 sin botella, 10 son los no vendidos (se queman al decidir) y 10 son **vendidos** (el pago más reciente primero), que se resuelven uno a uno con `MANUAL_REFUND` o `MANUAL_SUBSTITUTE`. El cierre queda `RESOLVED` al resolver el último |
| `identidad-sin-aprovisionar` | Bodega Altos de Calamuchita `ACTIVE` y `NOT_PROVISIONED`, sin nada en vuelo ni emitido; `chain/provision` la aprovisiona |
| `cadena-sin-configurar` | Lo anterior con la cadena desactivada: `CHN_DISABLED` y registro vacío |
| `huella-alterada` | `GET /v1/public/lots/{lotCode}/dossier` devuelve un expediente con un dato cambiado: su SHA-256 no es la huella anclada (la verificación del servidor no cambia) |
| `verificacion-no-encontrada` | `GET /v1/public/lots/{lotCode}/verification` → 404 `PUB_CODE_NOT_FOUND`; el pasaporte carga |

Los dos últimos son de respuesta (`PUBLIC_RESPONSE_SCENARIOS`, como `pasaporte-saturado`): no rehacen los datos.

| Ayuda | Qué hace |
|---|---|
| `mockTokenization.resubmitAsWinery(id, opciones?)` | La bodega atiende los cambios pedidos y reenvía (`CHANGES_REQUESTED → SUBMITTED`). Sin `commercial`, completa los campos que señaló operaciones |
| `mockTokenization.submitAsWinery(lotId, body)` · `withdrawAsWinery(id, motivo?)` | Solicitud nueva o retirada, como el dueño |
| `mockChain.setEnabled(false)` | Cadena sin configurar |
| `mockChain.mismatchNext('MINT_BATCH' \| 'ANCHOR_DOSSIER')` | La siguiente confirmación de ese tipo no cuadra (`MINT_RANGE_MISMATCH`, `ANCHOR_MISMATCH`) |
| `mockChain.drift(…)` · `clearDrift()` | La red dice otra cosa (dueño de un NFT, pausa o rol de un contrato) y vuelve a coincidir |
| `mockChain.reconcile(body?)` · `indexerGap(ledgers?)` | Conciliación programada; indexador con retraso |
| `mockChain.extendTtl(…)` · `setCodeTtlDays(n)` · `setContractTtlDays(bodega, n)` | Vida del almacenamiento |

### 14.6 Emisión `CONFIRMED` y `MINT_BATCH` en `PENDING` en la misma colección

Es coherente. `GET /v1/platform/collections/{id}/transactions` devuelve las transacciones de **todas** las emisiones de la colección (más las quemas), y una colección tiene una emisión por solicitud aprobada: con una ampliación de cuota en curso conviven la emisión inicial `CONFIRMED` y la `MINT_BATCH` de la ampliación en vuelo. Para saber de qué emisión es cada transacción, usa `Collection.mints[].transactions[].id`; `Collection.mintStatus` es el estado de la **última** emisión. Invariantes que comprueba `test/tokenization-rc2.test.ts` en todos los escenarios: una emisión `CONFIRMED` tiene todas sus transacciones `CONFIRMED`, toda `MINT_BATCH` de la lista pertenece a una emisión de la colección y con su mismo estado. La única excepción deliberada es `MINT_RANGE_MISMATCH`: transacción `CONFIRMED` con emisión `FAILED`.

### 14.7 Borrador del Marketplace (rc.2)

Sigue fuera del OpenAPI (§13.7). Añade:

- **Alta con verificación**: `POST /v1/auth/signup` con el cuerpo del §13.1 (`captchaToken`, `acceptTerms: true`, `ageDeclaration: true`, `website`) → 202 `{ status: 'VERIFICATION_SENT' }`, `X-Mock-Draft` y sin sesión; correo `EMAIL_VERIFY` al buzón con enlace al Marketplace. Captcha con `fail` → 422 `CAPTCHA_INVALID`; campo trampa relleno o correo ya registrado → 202 sin crear nada; contraseña con la política de la Ola 1 (≥ 10 caracteres). Como el OpenAPI vigente aún declara el alta sin captcha (201 con sesión), esa forma se sigue atendiendo cuando el cuerpo no trae ninguno de esos campos. `POST /v1/auth/verify-email` sigue respondiendo **204** (el contrato escrito dice «la forma del login»; manda el OpenAPI): después se inicia sesión.
- **`emailVerified`** de `GET /v1/me/consumer`: `false` hasta verificar para las cuentas del alta nueva; `true` en las de los fixtures. Una cuenta sin verificar puede iniciar sesión.
- **Pedidos sembrados** de `MARKETPLACE_DEMO_ACCOUNT` (María): dos `PAID`, uno `PAYMENT_FAILED` y uno `EXPIRED`, sobre colecciones del catálogo de demostración (no cambian su disponibilidad).
- **`GET /v1/public/purchase-settings`** → `{ maxBottlesPerOrder, reservationMinutes, currency }`: el mismo `compra.maxBotellasPorCompra` que aplica `POST /v1/orders` (422 `MKT_MAX_PER_ORDER`).
- **`GET /v1/public/collections/{winerySlug}/{slug}`** (§14.3). `Order.collection.winery.slug` da el primer segmento.

### 14.8 Pendiente para `0.6.0`

- `pnpm openapi:pull` contra el servidor cuando despliegue la Ola 3 (deben ser las mismas 212 operaciones) y las precisiones del paso 3.6 al implementarse: conciliación, alertas, eventos, TTL y cierre con faltante se apoyan en el contrato escrito.
- Retirar `GET /v1/public/collections/{slug}`.
- Dominio `marketplace` regenerado desde el OpenAPI borrador de la Etapa 4 (alta, verificación, pedidos, catálogo).
- Correos de la tokenización en `fixtures/backoffice/mailbox.json` (hoy solo se generan en la sesión).
