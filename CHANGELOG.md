# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones [SemVer](https://semver.org/lang/es/).

## [0.6.0-rc.2] · 2026-10-09

**Ola 3 · precisiones del backend y pedidos de las apps.** Pre-release sobre `dev`. El contrato es ahora el OpenAPI de la rama más avanzada del backend (`feat/o3-be-emision`, `66f33fd`: pasos 3.1–3.5 implementados; mismas 212 operaciones y 403 esquemas que la apertura, sin `501` en lo ya implementado), que sigue sin desplegar: ver `docs/CONTRATO.md` §14. Instalación: `pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.6.0-rc.2/drinks-on-chain-mocks-0.6.0-rc.2.tgz`.

### Cambios que rompen (respecto a `rc.1`)

Del backend:

- **El `slug` de una colección es único por bodega, no global.** `TOK_SLUG_TAKEN` solo salta dentro de la misma bodega. `PublicNftMetadata.external_url` sin pasaporte pasa de `{MKT}/colecciones/{slug}` a **`{MKT}/colecciones/{slugBodega}/{slug}`**. En los fixtures hay dos bodegas con una colección `singani-preventa-2026` (`SAME_SLUG_CASE`): no busques una colección solo por su `slug`.
- **Catálogo (borrador)**: la ficha se resuelve por bodega, `GET /v1/public/collections/{winerySlug}/{slug}` (borrador `marketplace`, `X-Mock-Draft: plan/contratos/o3-tokenizacion.md §13.1`). `GET /v1/public/collections/{slug}` queda **obsoleta** (cabeceras `Deprecation` y `Link`; con un `slug` repetido devuelve la primera del catálogo) y se retira en `0.6.0`. Dos colecciones de demostración de bodegas distintas ya pueden compartir `slug`; su `id` sigue siendo único.
- **`stellar.toml`** ya no lleva `[[CURRENCIES]]` (S-7): los contratos se publican solo en `GET /v1/public/chain/registry`.
- **Alertas**: `TX_FAILED` cambia el mensaje (`MINT_BATCH falló (CHN_AUTH_FAILED): …`) y `actual` (`{ status, code, detail }`); una transacción que falla por `CHN_INTENT_REJECTED` o `CHN_INSUFFICIENT_BALANCE` abre la alerta con ese código o con `LOW_BALANCE`. `LOW_BALANCE` de la conciliación lleva `expected: { minBalanceXlm }`, `actual: { balanceXlm, status }` y es `CRITICAL` en la cuenta de operaciones.

De los datos (pedidos de las apps):

- **Lote y colección nuevos en Altos de Calamuchita**: «Singani Preventa 2026» (`ALT-L2026-007`, en origen, estimación 800) con su colección `PUBLISHED` de 80 NFT a Bs 150. El siguiente lote de Altos es `ALT-L2026-008`; hay 4 colecciones, 480 NFT, 9 solicitudes (4 aprobadas) y el catálogo tiene 10 fichas.
- **Cadena**: 13 transacciones (dos `EXTEND_TTL`), 14 eventos (cada contrato nace con `role_granted` **y** `base_uri_updated`; `topics` lleva los argumentos indexados), 3 alertas y 5 conciliaciones. Los ledgers de los fixtures siguen el orden de las fechas.
- **`PlatformChainAccounts.codeTtlDays`** se calcula con el reloj de los mocks (96 el día de referencia; baja al adelantarlo) y **`Dashboard.chain.indexerLagSeconds`** deja de ser fijo.
- **Buzón**: las operaciones de tokenización envían correos (9 plantillas nuevas en `MAIL_TEMPLATES`). Una prueba que cuente todos los correos del buzón verá más.
- **`GET /v1/orders`** de María (`MARKETPLACE_DEMO_ACCOUNT`) trae 4 pedidos sembrados.
- **Escenario `empty`**: `GET /v1/organizations/current/chain-account` (y la de plataforma) sale sin NFT, lotes, transacciones ni costes.
- **`POST /v1/auth/signup` con `captchaToken`** (o `website`, `acceptTerms`, `ageDeclaration`) responde **202** `{ status: 'VERIFICATION_SENT' }` sin abrir sesión (borrador §13.1). Sin esos campos, el alta del OpenAPI vigente (201 con sesión) no cambia.
- `SCENARIOS` tiene cinco nombres más; `mockChain.setMintEnabled` y los tipos `ChainState`/`StoredToken` ganan campos.

#### Qué toca cada app

- **ERP**: si alguna prueba cuenta los lotes o las colecciones de Altos, o espera `ALT-L2026-007` como siguiente referencia, actualízala. La ficha de la cuenta de la bodega tiene ya su estado vacío (`empty`) y el de identidad sin aprovisionar (`identidad-sin-aprovisionar`). El embotellado **no** lleva `explorerUrl` (el OpenAPI no lo trae): el enlace del anclaje es `LotDossier.anchor.explorerUrl`. Una emisión puede esperar con `lastError.code = 'CHN_WINERY_NOT_ACTIVE'`.
- **Backoffice**: trata `ChainAlert.subject.type` como texto (lista orientativa `CHAIN_ALERT_SUBJECT_TYPES`; el back usa `TRANSACTION`, `COLLECTION`, `MINT`, `LOT`, `CONTRACT`, `PLATFORM_ACCOUNT` y `PLATFORM`) y añade `MINT_RANGE_MISMATCH` a los códigos conocidos (`CHAIN_ALERT_CODES`). `chain/provision`, `pause` y `unpause` pueden responder 409 `CHN_DISABLED`. Las listas de colecciones y solicitudes tienen una fila más; `collectionsPublished` del tablero es 3. Revisa lo que dependa del texto o de `expected`/`actual` de `TX_FAILED` y `LOW_BALANCE`.
- **Marketplace**: enlaza la ficha con `/colecciones/{slugBodega}/{slug}` y pídela a `GET /v1/public/collections/{winerySlug}/{slug}`; las claves de lista deben ser el `id` (o bodega + `slug`), no el `slug`. El alta con captcha recibe 202 y no hay sesión hasta `verify-email` + login. `GET /v1/orders` de María ya no está vacío. `stellar.toml` no trae contratos.

### Añadido

- **Backend**: `CHN_DISABLED` (409 en `chain/provision`, `chain/pause` y `chain/unpause`; registro público con cuentas `null` y lista vacía) con `mockChain.setEnabled(false)`; `CHN_WINERY_NOT_ACTIVE` (la emisión de una bodega suspendida o revocada espera en `PENDING`, como `CHN_MINT_DISABLED`, y continúa sola al reactivarla; `MINT_HOLD_CODES`); alertas `MINT_RANGE_MISMATCH` y `ANCHOR_MISMATCH` (`mockChain.mismatchNext('MINT_BATCH' | 'ANCHOR_DOSSIER')`: emisión `FAILED` sin NFT; anclaje `FAILED` en privado y `PENDING` sin transacción en público); `CHAIN_ALERT_CODES` y `CHAIN_ALERT_SUBJECT_TYPES`. La respuesta de aprobar trae `mint.transactions` con sus `MINT_BATCH`. `GET /v1/public/lots/{lotCode}/verification` responde 429 con `Retry-After` (`pasaporte-saturado`).
- **Escenarios**: `faltante-vendidos` (cierre con 10 NFT sin vender que se queman y 10 **vendidos sin botella** para resolver ítem a ítem; los ítems llevan `orderId` y `paidAt`), `identidad-sin-aprovisionar` (bodega `ACTIVE` con identidad `NOT_PROVISIONED`), `cadena-sin-configurar`, `huella-alterada` (los bytes del expediente canónico no dan la huella anclada) y `verificacion-no-encontrada` (la verificación responde 404). `PUBLIC_RESPONSE_SCENARIOS`.
- **`mockTokenization`** (también en `window.__docMocks.tokenization`): `resubmitAsWinery(requestId, { message?, commercial?, quantity? })` simula a la bodega atendiendo los cambios pedidos y reenviando (sin datos, completa lo que pidió operaciones); `submitAsWinery(lotId, body)` y `withdrawAsWinery(requestId)`.
- **Correos de la tokenización** en el buzón simulado (`TOKENIZATION_MAIL_TEMPLATES`): al dueño, `TOKENIZATION_REQUEST_RECEIVED`, `TOKENIZATION_CHANGES_REQUESTED` (con el mensaje), `TOKENIZATION_APPROVED`, `TOKENIZATION_REJECTED` (con el motivo), `NFT_MINTED` (enlace al contrato en el explorador), `COLLECTION_STATUS_CHANGED` y `LOT_SHORTFALL_DETECTED`; a operaciones y administración, `TOKENIZATION_REQUEST_FOR_OPERATIONS` (nueva o reenviada) y `CHAIN_ALERT_CRITICAL`.
- **Conciliación**: cada ejecución abre las diferencias nuevas y **cierra solas** las que ya no se reproducen (`RECONCILED_ALERT_CODES`; en los fixtures, una ejecución abre `TTL_EXPIRING` y la siguiente la cierra tras un `EXTEND_TTL`). Profundidad `FULL`: `OWNER_MISMATCH`, `BURN_MISMATCH`, `PAUSE_MISMATCH`, `ROLE_MISMATCH` y `TTL_EXPIRING` de cada contrato y del código. Controles: `mockChain.drift()`, `clearDrift()`, `reconcile()`, `indexerGap()`, `extendTtl()`, `setCodeTtlDays()` y `setContractTtlDays()`.
- **Borrador del Marketplace**: alta con captcha, campo trampa y correo de verificación (`ConsumerSignupSchema`, `ConsumerSignupAcceptedSchema`); `ConsumerProfile.emailVerified` variable; pedidos sembrados (`MARKETPLACE_DEMO_ACCOUNT`); `GET /v1/public/purchase-settings` (`PurchaseSettingsSchema`: máximo por compra y minutos de reserva); un NFT vendido recuerda su pedido.

### Sin cambio

- `explorerUrl` del anclaje en el embotellado: `BottlingBatchResponseDto` no lo declara, así que no se añade.
- Emisión `CONFIRMED` con una `MINT_BATCH` en `PENDING` en la lista de la misma colección: es coherente (la lista une las transacciones de **todas** las emisiones; pasa con una ampliación en curso). Documentado en `docs/CONTRATO.md` §14.6 y cubierto por una prueba que recorre todos los escenarios.

### Pendiente para `0.6.0`

`pnpm openapi:pull` contra el servidor cuando el backend despliegue la Ola 3; rutas del paso 3.6 (conciliación, alertas, eventos y cierre siguen con `501` en el OpenAPI); retirar `GET /v1/public/collections/{slug}`; dominio `marketplace` desde el OpenAPI borrador de la Etapa 4.

## [0.6.0-rc.1] · 2026-10-09

**Ola 3 · tokenización y cadena** (`plan/contratos/o3-tokenizacion.md`). Pre-release sobre `dev`. El contrato es el OpenAPI de la apertura del backend (rama `feat/o3-be-apertura`, `157dee4`: 212 operaciones, 54 nuevas), que aún no está desplegado: ver `docs/CONTRATO.md` §13.1. Instalación: `pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.6.0-rc.1/drinks-on-chain-mocks-0.6.0-rc.1.tgz`.

### Añadido

- **Dominios `tokenization` y `chain`** (entrada raíz): esquemas zod generados de los DTO del OpenAPI (`TokenizationRequestSchema`, `PlatformTokenizationRequestSchema`, `CollectionSchema`, `MintSchema`, `TokenSchema`, `LotClosureSchema`, `WineryLotClosureSchema`, `LotTokenizationStatusSchema`, `CollectionMetricsSchema`, `WineryChainIdentitySchema`, `WineryChainAccountViewSchema`, `ChainTxRefSchema`, `ChainTransactionSchema`, `DossierAnchorSchema`, `ChainEventSchema`, `ChainAlertSchema`, `ReconciliationRunSchema`, `PlatformChainAccountsSchema`, `PublicChainRegistrySchema`, `PublicDossierVerificationSchema`, `PublicNftMetadataSchema`… y los de entrada), sus tipos y enumeraciones (`CHAIN_TX_STATUSES`, `CHAIN_TX_KINDS`, `TOKENIZATION_REQUEST_STATUSES`, `TOKENIZATION_COLLECTION_STATUSES`, `TOKEN_STATUSES`, `LOT_TOKENIZATION_STATES`…) e `isValidStrKey`.
- **Handlers de las 54 rutas nuevas** con las reglas del contrato (cuota, una solicitud abierta, solo el dueño, transiciones 409 y reglas 422, permisos) y una **red simulada**: las transacciones avanzan `PENDING → BUILDING → SUBMITTED → CONFIRMED`, la emisión crea los NFT al confirmarse, certificar un lote registra su anclaje y al confirmarse pasa a `ANCHORED`. Control con `mockChain` (`advance`, `settle`, `failNext`, `setMode`, `setMintEnabled`, `pending`; también en `window.__docMocks.chain`) y con `advanceMockClock`.
- **Fixtures** `fixtures/chain/` y `fixtures/tokenization/` (`chainFixtures`, `tokenizationFixtures`): identidades, transacciones, cuentas de la plataforma, alertas, eventos, conciliaciones, registro, cuenta de cada bodega y verificaciones; solicitudes, colecciones, 400 NFT, cierres, estado por lote y metadatos. Lote nuevo «Singani Preventa 2026» (`PREVENTA_CASE`). Direcciones `G…`/`C…` y hashes con forma válida que no existen en testnet; `explorerUrl` siempre construido.
- **Escenarios** `identidad-preparandose`, `emision-en-curso`, `emision-fallida`, `anclaje-pendiente`, `faltante-botellas`, `alerta-evento-inesperado` y `cambios-pedidos` (`CHAIN_SCENARIOS`).
- **Público**: `GET /v1/public/chain/registry`, `/.well-known/stellar.toml`, `GET /v1/public/lots/{lotCode}/verification`, `GET /v1/public/nft/{winerySlug}/{tokenId}` y `GET /v1/public/collections/images/{imageId}`.
- **Borrador `marketplace`** (contrato §13.1, fuera del OpenAPI, `X-Mock-Draft`): `GET /v1/me/consumer`, pedidos y pasarela de prueba (`ConsumerProfileSchema`, `OrderSchema`, `MARKETPLACE_DRAFT_CONTRACT`).
- Opción `publicApiBaseUrl` de los handlers; `RouteSpec.idempotent: 'required'`.

### Cambiado (revisa tu app)

- **`LotSummary.tokenization`** (`state`, `quota`, `minted`, `collectionId`) es obligatorio, igual que `TraceDashboard.tokenization` y `Dashboard.tokenization` / `Dashboard.chain`. Las alertas abiertas de la cadena se suman a `Dashboard.alerts`.
- **`ANCHORED` ya ocurre**: «Singani Gran Reserva 2026» está `ANCHORED` en los fixtures (antes `CERTIFIED`) y **ningún lote de la demo queda `CERTIFIED`** (salvo en el escenario `anclaje-pendiente`). Cerrar un expediente deja el lote `CERTIFIED` con `dossier.anchor.status = 'PENDING'` hasta que la red confirme (`mockChain.settle()`, o solo en el navegador).
- **`LotDossier.anchor` y `PublicLotPassport.dossier.anchor`** dejan de ser siempre `null`: `DossierAnchorSchema` / `PublicDossierAnchorSchema`.
- **Línea de tiempo**: tipos nuevos `TOKENIZATION_AUTHORIZED`, `NFT_MINTED`, `COLLECTION_PUBLISHED`, `DOSSIER_ANCHORED`, `TOKENS_REDEEMABLE`, `SHORTFALL_DETECTED` (los cuatro centrales, públicos: salen en el pasaporte).
- **Lote nuevo en Cinti Viejo** (`CVJ-L2026-006`): el siguiente que se cree es `CVJ-L2026-007`, y el panel cuenta dos lotes en origen.
- **`GET /v1/users/me/wallet`**: 404 `CHN_WALLET_NOT_AVAILABLE` para el personal; el consumidor recibe su dirección derivada.
- **Bodegas**: `stellarPublicKey` es la cuenta real o `null`, `onchainProducerId` siempre `null`, `onchainRegisterTxHash` el hash de la creación de la cuenta o `null`.
- **`PATCH /v1/lots/{id}`**: 422 `TOK_ESTIMATE_BELOW_MINTED` si la estimación baja de lo emitido.
- **Matriz de permisos**: capacidades `tokenization`, `chain` y `chain.admin`.
- **Catálogo (borrador)**: cada colección lleva `id`, `saleState` y `counts.available`; «Singani Preventa 2026» y «Singani Gran Reserva 2026» salen de su colección real (la segunda, 60 botellas a Bs 280).
- El estado guardado en `localStorage` por 0.5 se descarta.

### Pendiente (`rc.2`)

Correos de la tokenización, más comprobaciones de la conciliación y del indexador, y el cierre con NFT vendidos sin botella como escenario (`docs/CONTRATO.md` §13.8). Hecho en `0.6.0-rc.2`.

## [0.5.0] · 2026-10-04

**Ola 2 · ERP confiable y dominio público** (`plan/contratos/o2-erp-confiable.md`). Versión estable que reúne `rc.1`–`rc.3`. El contrato es el OpenAPI que sirve el backend desplegado (`b82beed`, su `v0.2.0`: 137 rutas, 158 operaciones, 266 esquemas, sin rutas legadas ni operaciones con 501), traído otra vez con `pnpm openapi:pull` desde el servidor: es idéntico al que `rc.3` fijó desde la rama de cierre. Los pasaportes públicos de los nueve lotes embotellados de los fixtures coinciden con los del servidor tras regenerar su semilla, salvo lo que se indica en «Fixtures». Detalle de cada candidata en sus entradas de abajo y en [docs/CONTRATO.md](docs/CONTRATO.md) §10–§12.

### Respecto a `rc.3`

- `openapi/erp.json` vuelve a salir del servidor (`pnpm openapi:pull -- https://136.243.223.39.sslip.io/docs-json`); sin cambios de operaciones ni de esquemas.
- Ningún cambio de código ni de fixtures.

### Qué trae la Ola 2 (resumen)

- **Lote como entidad del servidor** (`/v1/lots*`): instantánea de reglas, etapa derivada, candados de crianza y reposo, D.O. calculada, proyección de botellas, incidencias; línea de tiempo, grafo, balance de masas, panel de la bodega y reporte de producción (JSON y CSV).
- **Reglas en el servidor** con códigos `TRC_…` y `details` ampliados (`code`, `rule`, `expected`, `actual`, `meta`): dictamen fitosanitario aparte y bloqueante, tanques por acciones (`start`, `complete`, `clean`; crianza y destilación solo desde un tanque `COMPLETED`), balances del embotellado, un embotellado por lote, fechas coherentes, correcciones compensatorias con marcas en los recursos y la plataforma en solo lectura.
- **Códigos de botella** (uno por botella, CSV y ZIP, anulación con o sin sustituto), **laboratorio** con conformidad calculada y reanálisis, **adjuntos** y **expediente** (`doc-dossier/1`, huella SHA-256 y raíz Merkle de los códigos).
- **Dominio público** sin sesión: pasaporte de lote y de botella, bytes canónicos del expediente, adjuntos públicos y directorio de bodegas, con `ETag`, 404/422/429 del backend; **borrador del catálogo** (`/v1/public/collections`, fuera del OpenAPI, `X-Mock-Draft`).
- **Fixtures**: 21 lotes en todas las etapas, con los mismos UUID v5, referencias y códigos de lote que la semilla del backend; «Singani Gran Reserva 2026» (`SINGANI_CASE`, `CVJ-2026-SINGANI-004`) con el expediente cerrado; `PASSPORT_CASES` para cada caso del visor; escenarios de datos de `/__mocks` y `pasaporte-saturado`; los handlers sirven los archivos de `/mocks/uploads`.
- **Retirado en el cierre H2**: las cinco rutas legadas, los campos de entrada de `RETIRED_INPUT_FIELDS` (422 «property … should not exist»), `TRC_PRODUCT_TYPE_MISMATCH`, `LotView`/`deriveLotViews`/`deriveRestStatus`, el grafo DAG y `lots-view.json`/`traceability-public.json`.

### Guía de migración desde `0.4.1`

**ERP** (de la Ola 1):

1. El lote es del servidor: `GET /v1/lots` y `LotSchema` en lugar de `LotView`/`deriveLotViews`; el reposo, en `production.lock` o `GET …/rest-status`.
2. Dictamen con `POST /v1/harvest-batches/{id}/phyto-decisions` (final; `notes` obligatorio al rechazar o poner en cuarentena); el pesaje no lleva `phytosanitaryStatus` ni los campos planos de madurez (usa `maturity` o `POST …/maturity-analyses`).
3. Tanque con `inputs` y `volumeFilledLiters`; transiciones por acciones (`…/start`, `…/complete` con `destination`, `…/clean`). Crianza (`volumeLiters` obligatorio, mínimo de meses de la instantánea) y destilación (`inputVolumeLiters`; cierre con `POST …/{id}/close` y sus cortes) solo desde un tanque `COMPLETED`.
4. Embotellado con `POST /v1/lots/{id}/bottling` (vista previa en `…/preview`, tipo derivado, `labelDesignKey`); laboratorio con `POST /v1/lots/{id}/lab-analyses` (`laboratoryReportKey` de `POST /v1/uploads`, conformidad calculada, un reanálisis sustituye al anterior); grafo con `GET /v1/lots/{id}/graph`.
5. Errores: muestra los `TRC_…` con `details[].expected`/`actual`/`meta` (no con el texto del mensaje); la plataforma recibe 403 `TRC_PLATFORM_READ_ONLY` en cualquier escritura.
6. Tipos de respuesta con campos nuevos obligatorios (`lotId`, `terroirSnapshot`, marcas de corrección, `availableLiters`, `transitions`, `conformityStatus`, `UploadResponse.sha256`…): quien los construya a mano en pruebas o historias debe añadirlos. Los registros anulados se devuelven marcados (`voided: true`).
7. Detalle punto por punto: «Cambiado» de `rc.1` y las guías de `rc.2` y `rc.3`.

**Marketplace**: construido sobre `rc.1`–`rc.3`; desde `rc.3` no cambia nada del pasaporte ni del catálogo. Si queda algo del grafo legado (`GET /v1/traceability/public/{lotCode}`, `PublicPassportSchema`), pasa a `GET /v1/public/passports/{code}` y `PublicLotPassportSchema`.

**Backoffice**: sin cambios de esquemas, tipos ni rutas de la plataforma ni de la lista de espera. Cambian el límite de metanol por defecto (200 mg/100 ml a.a., era 300), los fixtures de configuración (un ajuste por bodega más) y la bitácora (159 eventos, con otros hashes), las acciones del ERP que aparecen en la bitácora, `ScenarioName` (usa `SCENARIOS` y `SCENARIO_DESCRIPTIONS`) y la plataforma, que solo lee la trazabilidad. Lista completa en la guía de `rc.3`.

### Fixtures frente al servidor

Diferencias conocidas con los datos del servidor de desarrollo (las mismas en los pasaportes públicos):

- Los mocks fijan 6 meses de crianza mínima en Altos de Calamuchita (para probar `TRC_AGING_BELOW_MINIMUM`); la semilla del backend no siembra ajustes por bodega, así que allí es 0.
- La huella del expediente de `CVJ-2026-SINGANI-004` difiere (el backend genera los códigos de botella al sembrar) y el servidor no tiene archivos adjuntos (`publicAttachments` vacío).
- El servidor devuelve los instantes con milisegundos (`.000Z`).

## [0.5.0-rc.3] · 2026-10-02

**Cierre H2 de la Ola 2: sin rutas legadas ni `LotView`.** Candidata a la estable `0.5.0`. El contrato es el OpenAPI de la **fase de cierre** del backend (`drinks-on-chain-back`, rama `feat/o2-be-contraer`, `9ca8111`: 137 rutas, 158 operaciones, 266 esquemas, ninguna obsoleta), **todavía sin desplegar**: el servidor de desarrollo sigue sirviendo las 163 de `rc.2` hasta que se actualice. Con los mocks activos (MSW) las apps ven ya el contrato final; contra el servidor, las rutas y los campos retirados siguen respondiendo hasta el despliegue. Detalle y cómo volver a `pnpm openapi:pull` en [docs/CONTRATO.md](docs/CONTRATO.md) §12.

### Retirado (contrato §16.2 «H2»)

- **Rutas** (404, sin cabeceras `Deprecation`): `PATCH /v1/harvest-batches/{id}/phyto-status`, `POST /v1/bottling`, `POST /v1/lab-analyses`, `GET /v1/traceability/dag/{bottlingBatchId}` y `GET /v1/traceability/public/{lotCode}`. Las lecturas `GET /v1/bottling`, `GET /v1/bottling/{id}` y `GET /v1/lab-analyses/batch/{bottlingBatchId}` siguen.
- **Campos de entrada** (`RETIRED_INPUT_FIELDS`): `brixDegrees`, `initialPh`, `initialAcidityGl` (pesaje); `isDoEligible` (parcelas y destilación); `harvestBatchId` (tanque); `processEndDate`, `outputVolumeLiters`, `wasteVolumeLiters`, `additionalParams` (alta de destilación); `labelDesignUrl` (embotellado); `laboratoryReportPdfUrl` (laboratorio). Enviarlos responde **422 `VALIDATION_ERROR`** en ese campo con el mensaje del backend (`property <campo> should not exist`). `phytosanitaryStatus` en el pesaje, con cualquier valor (también `PENDING_INSPECTION`), responde 422 `TRC_PHYTO_IN_CREATE`.
- **Obligatorios**: `inputs` y `volumeFilledLiters` (tanque), `inputVolumeLiters` (destilación), `laboratoryReportKey` (laboratorio).
- **Crianza y destilación solo desde un tanque `COMPLETED`**: desde `FILLING`, `FERMENTING`, `TRANSFERRED` o `CLEANED` → 409 `TRC_TANK_NOT_COMPLETED` (`meta: { status, tankId }`). Antes, `POST /v1/fermentation-tanks/{id}/complete`.
- **Código de error** `TRC_PRODUCT_TYPE_MISMATCH` (sale de `TRACE_ERROR_CODES`): el tipo del embotellado se deriva siempre de sus fuentes.
- **De los mocks**: `LotView`, `LotViewSchema`, `deriveLotViews`, `deriveLotView`, `deriveRestStatus`, `SINGANI_REST_DAYS`, `LotChain`, `LotViewOptions`, `LOT_STAGES`/`LotStage`, `LOT_KINDS`/`LotKind`, `LotLock`; el grafo legado (`DagGraphSchema`, `DagNode`, `DagOperator`, `DagLabAnalysis`, `DAG_STAGE_NAMES`, `PublicPassportSchema`, `TraceabilityDagSchema` y sus mapas); `CreateBottlingBatchSchema`, `CreateBatchLabAnalysisSchema`, `UpdatePhytoStatusSchema`, `HARVEST_LAB_FIELDS`, `DistillationCutsSchema`; los fixtures `fixtures/erp/lots-view.json` y `traceability-public.json` (`erpFixtures.lotsView`, `erpFixtures.traceabilityPublic`).

Los campos de **respuesta** no cambian (`labelDesignUrl`, `laboratoryReportPdfUrl`, `phytoInspectionPdfUrl`, `additionalParams`, `brixDegrees`, `isDoEligible`… siguen saliendo).

### Añadido

- `sha256` (64 hexadecimales, la huella real del contenido) en la respuesta de `POST /v1/uploads`; el informe del dictamen y el del laboratorio guardan esa huella (`inspectionReport.sha256`, `report.sha256`). De un archivo que no se subió en la sesión, una huella estable derivada de la clave.
- `POST /v1/fermentation-tanks/{id}/clean` cierra también un tanque `COMPLETED` del que ya salió alguna destilación y queda un remanente: el historial anota `TRANSFERRED` y `CLEANED` y el resto cuenta como merma de trasiego. Sin ninguna salida → 409 `TRC_TANK_INVALID_TRANSITION`.
- `RETIRED_INPUT_FIELDS` (entrada raíz): los campos retirados por DTO.

### Corregido

- `pendingPhyto[].intakeDate` del panel es una **fecha** `AAAA-MM-DD` (era un instante), como el backend.
- El CSV del reporte de producción se llama `reporte-produccion-AAAA-MM-DD.csv` (día de La Paz en que se pide).
- Escenario `empty`: también vacía `GET /v1/traceability/dashboard` y `GET /v1/traceability/reports/production` (JSON y CSV).
- `?mock=<escenario>` se guarda al arrancar el worker (`startMockWorker`): ya no se pierde si la app navega antes de la primera petición.
- Corregir `volumeLiters` de una crianza (o el corazón de una destilación) **ya embotellada** reevalúa el balance con el volumen vigente de las fuentes: si las botellas ya no caben, la corrección se registra y abre la incidencia `TRC_BOTTLING_EXCEEDS_VOLUME` (`source: 'CORRECTION'`), que bloquea el cierre del expediente.

### Fixtures

- Correcciones de la semilla del backend (`src/seed/corrections.ts`): se retiran los tanques vacíos **TK-06, TK-09 y TK-RED-04** (`CLEANED` con 0 L) y sus eventos; **TK-08** pasa de `COMPLETED` a `TRANSFERRED` (su destilación se llevó los 6.300 L); **TK-01 de Cinti Viejo** queda `CLEANED` el 26-05-2025 con su historial. 18 tanques (eran 21); ya no hay ninguno `COMPLETED` (complétalo desde uno `FERMENTING`: TK-04, TK-10 o TK-15 de Altos).
- **Altos de Calamuchita fija 6 meses de crianza mínima** (`trazabilidad.vino.crianzaMinimaMeses`, ajuste por bodega): sus lotes llevan `rules.wine.minAgingMonths: 6` y una crianza más corta responde 422 `TRC_AGING_BELOW_MINIMUM`. El estándar de la plataforma sigue en 0.
- El dictamen del caso del §18 guarda la huella de su acta, así que cambian la huella del expediente cerrado (`CVJ-2026-SINGANI-004`) y la bitácora (159 eventos; `setting-overrides.json`, 7; `setting-history.json`, 9).

### Guía de migración `rc.2` → `rc.3`

**ERP**

1. Deja de llamar a las cinco rutas retiradas: dictamen con `POST …/phyto-decisions`; embotellado con `POST /v1/lots/{id}/bottling` (y `…/preview`); laboratorio con `POST /v1/lots/{id}/lab-analyses`; grafo con `GET /v1/lots/{id}/graph`; pasaporte con `GET /v1/public/passports/{code}`.
2. Revisa los cuerpos: ninguno de los campos de «Retirado» (un 422 ahora, antes se ignoraban o se convertían). El análisis del pesaje va en `maturity: { brixDegrees, ph, acidityGl }` o en `POST …/maturity-analyses`; el tanque, con `inputs` y `volumeFilledLiters`; la destilación se abre con `inputVolumeLiters` y se cierra con `POST …/{id}/close`; la etiqueta, por `labelDesignKey`; el informe, por `laboratoryReportKey` (los dos, una `key` de `POST /v1/uploads`).
3. Crianza y destilación: ofrece solo tanques `COMPLETED` y muestra el 409 `TRC_TANK_NOT_COMPLETED`. Quita lo que dependa de `TRC_PRODUCT_TYPE_MISMATCH`.
4. Sustituye `LotView`/`deriveLotViews` por `Lot`/`LotSummary` de `GET /v1/lots`, y `deriveRestStatus` por `production.lock` o `GET /v1/production-batches/{id}/rest-status`. `erpFixtures.lotsView` y `erpFixtures.traceabilityPublic` ya no existen (`erpFixtures.lots`, `publicFixtures.passports`).
5. Panel: `pendingPhyto[].intakeDate` es una fecha (no la formatees como instante). Reporte: usa el nombre de `Content-Disposition` (`reporte-produccion-AAAA-MM-DD.csv`).
6. `UploadResponse` gana `sha256` (obligatorio en el tipo).
7. Pruebas contra los fixtures: no hay tanques `COMPLETED` ni los tres vacíos, TK-01 de Cinti Viejo está `CLEANED`, los lotes de Altos exigen 6 meses de crianza y la huella del expediente del §18 cambió.

**Marketplace**

1. Nada cambia en el pasaporte, el expediente, el directorio ni el borrador del catálogo. Si algo consultaba todavía `GET /v1/traceability/public/{lotCode}` o usaba `PublicPassportSchema`/`DagGraphSchema` (el grafo legado), pasa a `GET /v1/public/passports/{code}` y `PublicLotPassportSchema`.
2. Fixtures: `rules.items` de los vinos de Altos muestra «Crianza mínima: 6 meses» (era 0); la huella de `CVJ-2026-SINGANI-004` (`dossier.hash`) cambió; el pasaporte de `CVJ-2026-SINGANI-001` pierde los dos eventos del tanque vacío TK-09 y su `fermentation.endDate` pasa al 12-04-2025.

**Backoffice** (sigue en `0.4.1`; esto es lo que le cambia al saltar a `0.5.0`)

1. Los esquemas, tipos y rutas de la plataforma (`/v1/platform/*`, solicitudes, bodegas, equipos, configuración, bitácora, tablero, lista de espera) **no cambian**: no hay que tocar pantallas.
2. **Límite de metanol por defecto: 200 mg/100 ml a.a.** (era 300) en `trazabilidad.laboratorio.limites` (`DEFAULT_LAB_LIMITS`, `settings.json`), el del catálogo del backend. Afecta a lo que muestre o pruebe el valor por defecto de ese parámetro.
3. Fixtures del back office: un ajuste por bodega más (Altos, `trazabilidad.vino.crianzaMinimaMeses` = 6: `setting-overrides.json` 6 → 7, `setting-history.json` 8 → 9) y la bitácora pasa de 163 a 159 eventos, con otros ids y hashes (menos tanques y destilaciones de demostración, un `SETTING_OVERRIDE_SET` más). Las pruebas que cuenten filas o fijen un hash deben actualizarse.
4. Bitácora del ERP: las escrituras de la sesión registran las acciones de la Ola 2 (`LOT_CREATED`, `LOT_UPDATED`, `LOT_DISCARDED`, `PHYTO_DECIDED`, `MATURITY_ANALYZED`, `TANK_TRANSITION`, `DISTILLATION_CLOSED`, `BOTTLED`, `LAB_REGISTERED`, `BOTTLE_CODE_VOIDED`, `BOTTLE_CODES_EXPORTED`, `CORRECTION_REGISTERED`, `ATTACHMENT_ADDED`, `ATTACHMENT_VISIBILITY_CHANGED`, `DOSSIER_CLOSED`) y ya no `HARVEST_BATCH_PHYTO_STATUS_CHANGED`, `BOTTLING_BATCH_CREATED` ni `LAB_ANALYSIS_CREATED` (las dos últimas siguen en los eventos de los fixtures). Si la pantalla traduce acciones con una lista cerrada, deja un texto por defecto.
5. `ScenarioName` crece (`lote-en-reposo`, `lote-listo`, `lote-con-incidencia`, `laboratorio-no-conforme`, `pasaporte-saturado`): un `Record<ScenarioName, …>` escrito a mano deja de compilar; el panel `/__mocks` debe usar `SCENARIOS` y `SCENARIO_DESCRIPTIONS` (o `RESPONSE_SCENARIOS` si solo quiere los cinco de siempre).
6. Los handlers sirven `/mocks/uploads/*` (logotipos y documentos de los fixtures) y las rutas `/v1/public/*`; con `uploads: 'passthrough'` no interceptan los archivos. El estado guardado en `localStorage` (`doc-mocks:state`) se descarta solo al cambiar de versión.
7. La plataforma **solo lee** la trazabilidad (`GET /v1/lots?wineryId=…`, grafo, expediente): cualquier escritura responde 403 `TRC_PLATFORM_READ_ONLY`.

### Pendiente (no cambia en `rc.3`)

- `awaitingBifurcation` no llega a ser `true` con datos de la Ola 2: como en el backend, solo lo es un tanque `COMPLETED` sin destino, y `complete` exige `destination`.
- El panel sigue sin admitir a `OPERATOR` (403), igual que el backend (`OWNER`, `ENOLOGIST`, `AGRONOMIST`, `ACCOUNTANT`).
- Los mensajes de error llevan fechas ISO y punto decimal, como los del backend: la UI debe formatear con `details[].expected`/`actual`/`meta`, no con el texto.
- Rendimiento del mosto de `CVJ-L2026-001` y `ALT-L2026-001` (~1,0 L/kg; lo habitual es 0,65–0,75): pendiente de ajustar en las filas base.

## [0.5.0-rc.2] · 2026-10-02

**Precisiones del backend con la Etapa 2 de la Ola 2 completa** (`drinks-on-chain-back` en `dev`, `8e85935`, el mismo OpenAPI que sirve el servidor de desarrollo: 163 operaciones, 272 esquemas y **ninguna ruta con 501**). Lo que en `rc.1` seguía el contrato escrito ahora sigue el código del backend (`docs/arquitectura/trazabilidad.md`). Comprobado contra el servidor: un pasaporte real pasa `PublicLotPassportSchema` y coincide con el fixture del mismo lote. Detalle en [docs/CONTRATO.md](docs/CONTRATO.md) §11.

### Añadido

- **Marcas de corrección** en los recursos (`correctedFields`, `voided`, `correctionIds`; `CorrectionMarksSchema`) y `voidedAt` en lecturas, tratamientos y análisis de laboratorio.
- **Tanque**: `availableLiters`, `transferLossLiters` y `transitions` (`TankTransitionSchema`); `closeTank` en el alta de la destilación.
- **Códigos de botella**: búsqueda `q`; `BottleCodeExportSchema` con `format`, `fromSerial` y `toSerial` (también registra cada descarga CSV, cabecera `X-Export-Id`); `BOTTLE_ZIP_MAX_CODES` (20.000 por ZIP); el ZIP se descarga de verdad (con `codigos.csv`).
- **Expediente**: `CanonicalDossierSchema` y `CANONICAL_DOSSIER_KEYS` (la forma `doc-dossier/1` del backend), `sha256Hex` y `canonicalJson` en la entrada raíz; `merkleRoot` y `verifyMerkleProof`; cabeceras `X-Dossier-Status` y `X-Dossier-Hash`.
- **Pasaporte**: `ETag` con `If-None-Match` → 304; escenario `pasaporte-saturado` (429 `TOO_MANY_REQUESTS`, el límite de 60 consultas por minuto; `PUBLIC_RATE_LIMIT`); `PASSPORT_CASES` con un lote de los fixtures para cada caso (certificado, sin laboratorio, no conforme, D.O. por excepción, registro tardío, lote retirado, bodega suspendida).
- **Catálogo (borrador)**: `featured`, `?featured=` y `?sort=featured|newest|price-asc|price-desc|name` (`COLLECTION_SORTS`).
- **Archivos de `/mocks/uploads/…`**: los handlers los sirven (imagen SVG, PDF de una página, ZIP de códigos), así ninguna imagen de los fixtures queda rota con MSW activo. Opción `uploads: 'passthrough'` para no interceptarlos.
- `RESPONSE_SCENARIOS` (los cinco escenarios de respuesta) junto a `DATA_SCENARIOS`.
- Pruebas: `test/trace-precisions.test.ts`.

### Cambiado: lo que obliga a tocar código

**ERP** (respecto a `rc.1`):

1. **Registros anulados**: ahora se devuelven **marcados** (`voided: true`) en `logs` y `treatments` del tanque, `maturityAnalyses` y `phytoDecisions` del pesaje y en sus listas y la de laboratorio (`rc.1` los omitía). La UI debe distinguirlos; el valor vigente del recurso ya no los cuenta.
2. **Correcciones**: una `VOID` tiene `changes: []` (antes un cambio `voided`); corregir pesos añade el cambio derivado `netWeightKg`; anular dos veces → 409 `CONFLICT` (antes `TRC_INVALID_STAGE`); anular un dictamen con la uva en tanque → 409 `TRC_PHYTO_DECISION_FINAL` (antes 422); una `AMEND` que no cambia nada → 422 en `changes`; `target.type: 'TERROIR'` por la ruta del lote → 422; un lote `REJECTED` solo admite anular un dictamen; en un lote **ya embotellado**, la corrección que incumple una regla del embotellado ya no es 422: se registra (201) y abre una incidencia `source: 'CORRECTION'`.
3. **Tipos**: `BottleCodeExport` gana `format`, `fromSerial`, `toSerial` (obligatorios) y `createdBy` es anulable, como `BottleUnit.voided.by` y `LotAttachment.createdBy`.
4. **Tanque**: una segunda destilación (o crianza) desde un tanque `TRANSFERRED` → 409 `TRC_TANK_NOT_COMPLETED`; el detalle de `TRC_TANK_INVALID_TRANSITION` lleva `meta.allowedFrom`.
5. **CSV de códigos**: empieza con BOM (`\uFEFF`), solo lleva códigos activos y el archivo se llama `codigos-{lotCode}-{desde}-{hasta}.csv`; un rango sin códigos activos → 422. La plataforma no exporta (403) y soporte no lista códigos.
6. **Expediente**: mensajes de `requirements` (los del backend), `hashPreview` nunca es `null` y no cambia con el reloj; `TRC_DOSSIER_CLOSED` lleva `meta: { closedAt, hash }`; `TRC_DOSSIER_NOT_READY` añade `labStatus`, `issueIds` o `sourceIds`. La huella y la raíz Merkle de los fixtures cambian.
7. **Archivos del lote**: agronomía y operación solo ven los que adjuntaron; publicar al adjuntar es de dirección y enología (403); el cambio de visibilidad queda como evento `FILE_ATTACHED` (`data.action: 'VISIBILITY_CHANGED'`).
8. **Laboratorio**: el límite de metanol por defecto baja de 300 a **200 mg/100 ml a.a.** (el del backend).
9. `ScenarioName` crece (`pasaporte-saturado`): un `Record<ScenarioName, …>` escrito a mano deja de compilar. Usa `SCENARIOS` + `SCENARIO_DESCRIPTIONS` o `Partial<Record<…>>`.

**Marketplace**:

1. `PublicLotPassport.fermentation.startDate` y `endDate` son **instantes ISO 8601**, no fechas de calendario.
2. **Prueba Merkle**: el nodo padre es SHA-256 de los **bytes** concatenados (no del texto hexadecimal). Quien la verifique por su cuenta debe usar `verifyMerkleProof` / `merkleRootFromProof` de esta versión. Un código anulado **después** del cierre conserva su prueba (`status: 'VOIDED'` con `merkleProof`).
3. Textos de `timeline[].summary` y `rules.items` (sin la merma máxima; etiquetas del backend): no dependas de su texto.
4. Catálogo: `featured` es obligatorio en la fila; el orden por defecto cambia (destacadas primero); un lote con el análisis no conforme ya no se ofrece.
5. El pasaporte de una botella se guarda 60 s aunque el lote esté certificado; 422 y 429 llevan `no-store`; el 404 dice «Código no encontrado».

### Fixtures

- 21 lotes (4 nuevos): `ALT-2025-WINE-001` (laboratorio no conforme), `ALT-2025-SINGANI-002` (D.O. por excepción y registro tardío), `CVJ-2025-SINGANI-001` (retirado tras embotellarse) y `CUR-2026-SINGANI-001` (Casa Uriondo, bodega suspendida, con su parcela). 9 lotes con códigos (25.790), 8 colecciones.
- La instantánea de reglas de un lote nativo se toma al crearlo (`rules.takenAt` = `createdAt`, antes del primer evento); los tanques nativos guardan su `transitions`; el dictamen de un lote migrado sale como registro tardío (se anota al migrar, como en el backend).

## [0.5.0-rc.1] · 2026-10-01

**ERP v2 y dominio público de la Ola 2** («ERP completo y trazabilidad confiable», `plan/contratos/o2-erp-confiable.md`), contra el OpenAPI del backend en la apertura de la ola (`dev`, `bfda9bd`: 141 rutas, 163 operaciones, 271 esquemas). Pre-release sobre `dev` para que el ERP (O2-ERP-*) y el Marketplace (O2-MK-1) construyan contra ella; se ajustará en `rc.2` cuando el backend cierre sus pasos. El backend responde 501 en buena parte de las rutas nuevas; los mocks las implementan todas con las reglas del contrato. Diferencias entre el contrato escrito y el OpenAPI, decisiones y datos de demo: [docs/CONTRATO.md](docs/CONTRATO.md) §10. La lista de espera y el back office no cambian.

### Añadido

- **Lote como entidad del servidor** (`/v1/lots*`): alta, lista con filtros (`stage`, `productType`, `harvestYear`, `q`, `lockDueWithinDays`, `hasComplianceIssues`), detalle con instantánea de reglas, candados, D.O. calculada, proyección de botellas e incidencias; edición, descarte, línea de tiempo, grafo, balance de masas, vista previa y alta del embotellado, códigos de botella (lista, CSV, ZIP, anulación y sustitución), laboratorio con conformidad calculada y reanálisis, correcciones compensatorias, adjuntos, expediente (vista previa, cierre, JSON canónico) y, por bodega, `GET /v1/traceability/dashboard` y `GET /v1/traceability/reports/production` (JSON y CSV).
- **Acciones sobre los registros**: `POST /v1/harvest-batches/{id}/maturity-analyses` y `/phyto-decisions` (con sus `GET`), `POST /v1/fermentation-tanks/{id}/start|complete|clean`, `POST /v1/wine-aging/{id}/discard`, `POST /v1/production-batches/{id}/close|discard`, `POST /v1/terroirs/{id}/corrections`.
- **Reglas en el servidor** (las mismas por las rutas nuevas y por las legadas), con los 409/422 del contrato §13 y `details` ampliados (`code`, `rule`, `expected`, `actual`, `meta`): dictamen fitosanitario bloqueante, D.O. calculada con la instantánea del lote, candados de crianza y reposo con el reloj simulado, balance de volumen y de alcohol, merma tolerada, un embotellado por lote, fechas coherentes, expediente con huella SHA-256 y raíz Merkle de los códigos. Códigos en `TRACE_ERROR_CODES` (y en `API_ERROR_CODES`).
- **Dominio `public`** (sin sesión): `GET /v1/public/passports/{code}`, `/public/lots/{lotCode}`, `/public/bottles/{code}`, `/public/lots/{lotCode}/dossier` (bytes canónicos), `/public/lots/{lotCode}/attachments/{id}` (302) y `GET /v1/public/wineries` (directorio); 404 `PUB_CODE_NOT_FOUND`, 422 `PUB_CODE_MALFORMED`, 429 `PUB_TOO_MANY_LOOKUPS` (más de 20 códigos inexistentes en 10 min por IP, con `Retry-After`) y aviso de código anulado.
- **Catálogo (BORRADOR, fuera del OpenAPI)**: `GET /v1/public/collections` y `/{slug}` (contrato §17.1), solo para la pantalla 2A del Marketplace. Responden `X-Mock-Draft`, están en `openapi/pendientes.json` con `"borrador": true` y pueden cambiar sin aviso hasta la Etapa 4.
- **Esquemas y tipos** (entrada raíz): `LotSchema`, `LotSummarySchema`, `CreateLotSchema`, `UpdateLotSchema`, `DiscardLotSchema`, `LotRulesSchema`, `LotLockInfoSchema`, `LotStageCodeSchema`/`LOT_STAGE_CODES`, `LotProductTypeSchema`, `DoEvaluationSchema`, `ComplianceIssueSchema`, `LotEventSchema`, `LotTimelineSchema`, `LotBalanceSchema`, `LotGraphSchema`, `TraceDashboardSchema`, `ProductionReportSchema`, `MaturityAnalysisSchema`, `CreateMaturityAnalysisSchema`, `PhytoDecisionSchema`, `CreatePhytoDecisionSchema`, `TerroirSnapshotSchema`, `StartFermentationTankSchema`, `CompleteFermentationTankSchema`, `CleanFermentationTankSchema`, `DiscardWineAgingSchema`, `CloseDistillationSchema`, `DiscardProductionBatchSchema`, `CreateLotBottlingSchema`, `BottlingPreviewSchema`, `BottlingBalanceSchema`, `BottleUnitSchema`, `VoidBottleCodeSchema`, `CreateBottleCodeExportSchema`, `BottleCodeExportSchema`, `CreateLotLabAnalysisSchema`, `LabConformitySchema`, `CorrectionSchema`, `CreateLotCorrectionSchema`, `CreateTerroirCorrectionSchema`, `LotAttachmentSchema`, `CreateLotAttachmentSchema`, `LotDossierSchema`, `DossierPreviewSchema`, `CloseDossierSchema`; del dominio público, `PublicLotPassportSchema`, `PublicBottlePassportSchema`, `PublicCodePassportSchema`, `PublicTimelineEventSchema`, `LOT_CODE_PATTERN` y, del borrador, `PublicCollectionSummarySchema` y `PublicCollectionSchema`. Utilidades de los códigos de botella sin msw: `normalizeBottleCode`, `isValidBottleCode`, `looksLikeBottleCode`, `formatBottleCode`, `luhnMod32CheckChar`, `merkleLeaf`, `merkleParent`, `merkleRootFromProof`.
- **Fixtures**: `fixtures/erp/lots.json` (17 lotes en todas las etapas), `lot-events.json`, `maturity-analyses.json`, `phyto-decisions.json`, `bottle-lots.json`, `corrections.json`, `lot-attachments.json`, `lot-dossiers.json` (en `erpFixtures`) y `fixtures/public/{passports,bottle-codes,wineries,collections}.json` (`publicFixtures`, export `./fixtures/public/*.json`). Caso del contrato §18: «Singani Gran Reserva 2026» de la Destilería Cinti Viejo (`SINGANI_CASE`), certificado, con 2.950 códigos de botella. Los lotes migrados tienen el mismo UUID v5 que la semilla del backend.
- **Escenarios de datos** en `/__mocks`: `lote-en-reposo`, `lote-listo`, `lote-con-incidencia`, `laboratorio-no-conforme` (`DATA_SCENARIOS`, `isDataScenario`).
- **Pruebas**: `test/trace-rules.test.ts` (recorrido H2 y pruebas de elusión del §18), `test/public.test.ts` y las operaciones nuevas (45 del OpenAPI y las 2 del borrador) en la prueba de contrato estricta.

### Cambiado (rupturas y guía de migración del ERP de la Ola 1)

El ERP y el Backoffice de la Ola 1 siguen funcionando con sus rutas; cambia lo que el contrato §16.2 cierra «desde la apertura»:

1. **Pesaje** (`POST /v1/harvest-batches`): `phytosanitaryStatus` distinto de `PENDING_INSPECTION` → 422 `TRC_PHYTO_IN_CREATE` (el dictamen va aparte). Brix, pH y acidez son opcionales (ya no hay 422 por faltar) y **anulables en la respuesta**. `intakeDate` futura → 422 `TRC_DATE_IN_FUTURE`. El código pasa a `HARV-{año}-{parcela}-{NNN}` por bodega y año.
2. **Dictamen** (`PATCH …/phyto-status`, obsoleta): `APPROVED` y `REJECTED` son finales y nada cambia con la uva en un tanque → 409 `TRC_PHYTO_DECISION_FINAL`; rechazar o poner en cuarentena exige `notes`.
3. **Tanques** (`POST /v1/fermentation-tanks`): uva sin dictamen aprobado → 422 `TRC_PHYTO_NOT_APPROVED`; `status` `COMPLETED`/`TRANSFERRED`/`CLEANED` en el alta → 422; código físico ocupado por un tanque sin limpiar → 409 `TRC_TANK_CODE_IN_USE`; volumen sobre la capacidad → 422 `TRC_TANK_CAPACITY_EXCEEDED`. Si el pesaje no tiene lote, se crea uno. Lecturas y tratamientos: fecha futura → 422; tanque `TRANSFERRED`/`CLEANED` → 409 `TRC_TANK_NOT_ACTIVE`.
4. **Crianza** (`POST /v1/wine-aging`): `volumeLiters` obligatorio y ≤ lo disponible del tanque (422 `TRC_VOLUME_EXCEEDS_AVAILABLE`); `plannedMonths` bajo el mínimo de la instantánea → 422 `TRC_AGING_BELOW_MINIMUM`; `lockUntilDate` = inicio + meses de calendario (ya no se acota al día 28).
5. **Destilación**: `isDoEligible` enviado se ignora (calculado); uva no apta → 422 `TRC_DO_NOT_ELIGIBLE`; cortes que superan la entrada → 422 `TRC_MASS_BALANCE_EXCEEDED`. Lo mismo en parcelas: `isDoEligible` se calcula (cambian valores de `terroirs.json`).
6. **Embotellado** (`POST /v1/bottling`): el tipo se deriva (otro → 422 `TRC_PRODUCT_TYPE_MISMATCH`); candado sin cumplir → 422 `TRC_LOCK_NOT_RELEASED` (antes `UNPROCESSABLE_ENTITY` en `wineAgingBatchId`/`productionBatchId`), con la fecha y los días que faltan en `details[0]`; balances `TRC_BOTTLING_EXCEEDS_VOLUME`, `TRC_ALCOHOL_BALANCE_EXCEEDED`, `TRC_BOTTLING_LOSS_ABOVE_TOLERANCE`, `TRC_DILUTION_NOT_ALLOWED`; segundo embotellado del lote → 409 `TRC_LOT_ALREADY_BOTTLED`. `blockchainDataHash` es `null` y `qrBatchUrl` = `{URL del Marketplace}/b/{lotCode}`.
7. **Laboratorio** (`POST /v1/lab-analyses`): `conformsTo*` se ignora (conformidad calculada con los límites de la instantánea); un segundo análisis ya no es 409: sustituye al anterior (`supersededAt`).
8. **Plataforma**: solo lectura sobre la trazabilidad; cualquier escritura → 403 `TRC_PLATFORM_READ_ONLY` (antes `ADMIN`/`OPERATIONS` escribían con `?wineryId=`).
9. **Grafo legado** (`GET /v1/traceability/dag/{id}`): un consumidor o una sesión sin organización → 404 (SE-07); sin métricas inventadas; `isCertified` = expediente cerrado. `GET /v1/traceability/public/{lotCode}` ya solo acepta el código de lote.
10. **Tipos de respuesta** con campos nuevos obligatorios (`lotId`, `terroirSnapshot`, `finalVolumeLiters`, `startDate`, `containerCount`, cortes de la destilación, `conformityStatus`, `supersededAt`, `methanolMg100mlAa`…): quien construya esos objetos a mano en pruebas o historias debe añadirlos.
11. **Fixtures**: cuatro correcciones de realismo de la semilla del backend (agua de un embotellado, un tanque y una destilación sin origen retirados, una crianza `BOTTLED`), filas nuevas de los lotes de demostración en los archivos existentes y 161 eventos en `audit.json`. Estado del navegador de 0.4 (`doc-mocks:state`) se descarta.

Se retira en H2 (cierre de la Ola 2; hoy sigue funcionando): `LotView`, `deriveLotViews` y `lots-view.json` (→ `GET /v1/lots`); `PATCH …/phyto-status` (→ `POST …/phyto-decisions`); `POST /v1/bottling` (→ `POST /v1/lots/{id}/bottling`); `POST /v1/lab-analyses` (→ `POST /v1/lots/{id}/lab-analyses`); `GET /v1/traceability/dag/{id}` (→ `GET /v1/lots/{id}/graph`) y `/traceability/public/{lotCode}` (→ `GET /v1/public/passports/{code}`); en las entradas, `harvestBatchId` y `status` del alta de tanque (→ `inputs`, `startFermentation`), los campos planos de madurez y `phytosanitaryStatus` del pesaje, `isDoEligible`, `conformsTo*`, `labelDesignUrl` y `laboratoryReportPdfUrl` (→ `…Key`), el cierre compuesto de la destilación en el alta (→ `POST …/close`) y la tolerancia a crear crianza o destilación desde un tanque sin completar (→ 409 `TRC_TANK_NOT_COMPLETED`).

## [0.4.1] · 2026-10-01

**Lista de espera** (añadido a la Ola 1; `plan/contratos/o1b-lista-de-espera.md`), alineada con el backend `v0.1.1` (118 operaciones, 149 esquemas). Solo añade: nada de lo que había en 0.4.0 cambia de forma, salvo el bloque nuevo y obligatorio `waitlist` del tablero. Detalle y diferencias con el contrato escrito en [docs/CONTRATO.md](docs/CONTRATO.md) §9.

### Añadido

- **Esquemas** (entrada raíz): `WaitlistJoinRequestSchema` (unión por `type` de `WaitlistConsumerJoinSchema` y `WaitlistWineryJoinSchema`, con los mensajes del backend), `WaitlistJoinResponseSchema`, `WaitlistStatsSchema`, `WaitlistEntrySchema`, `WaitlistSourceSchema`, `WaitlistSourcesSchema`, `UpdateWaitlistEntrySchema`, `DashboardWaitlistSchema`, las enumeraciones `WaitlistTypeSchema`/`WAITLIST_TYPES`, `WaitlistStatusSchema`/`WAITLIST_STATUSES`, `WaitlistInterestSchema`/`WAITLIST_INTERESTS`, `WaitlistProducesSchema`/`WAITLIST_PRODUCES`, `WaitlistLocaleSchema`/`WAITLIST_LOCALES` y las constantes `WAITLIST_PHONE_PATTERN`, `WAITLIST_SOURCE_PATTERN`, `WAITLIST_RESOURCE_TYPE`, `WAITLIST_EMAIL_LIMIT_PER_HOUR`, `WAITLIST_CSV_COLUMNS` y `WAITLIST_EXPORT_MAX_ROWS`, con sus tipos (`WaitlistEntry`, `WaitlistJoinRequest`, `UpdateWaitlistEntryDto`…).
- **Tablero**: `DashboardSchema.waitlist` = `{ consumers, wineries, last24h }` en `GET /v1/platform/dashboard`.
- **Permisos**: capacidad `waitlist` («Lista de espera») en `GET /v1/platform/permissions`: `FULL` para `SUPERADMIN`, `ADMIN` y `OPERATIONS`; `READ` para `SUPPORT`.
- **Fixtures**: `fixtures/backoffice/waitlist.json` (`backofficeFixtures.waitlist`): 52 inscripciones (38 consumidores y 14 bodegas ficticias), con `tarija-2026` como origen mayoritario, 8 sin origen, los tres estados y 7 de las últimas 24 h.
- **Handlers** (incluidos en `createMockHandlers()`): `POST /v1/public/waitlist`, `GET /v1/public/waitlist/stats`, `GET /v1/platform/waitlist`, `GET /v1/platform/waitlist/sources`, `PATCH /v1/platform/waitlist/{id}` y `GET /v1/platform/waitlist/export` (CSV con BOM y `Content-Disposition`), con eventos `WAITLIST_JOINED`, `WAITLIST_STATUS_CHANGED` y `WAITLIST_EXPORTED` en la bitácora (recurso `waitlist_entry`).
- Código `WAITLIST_EXPORT_TOO_LARGE` en `API_ERROR_CODES`.
- Pruebas: `test/waitlist.test.ts` y las 6 rutas y `waitlist.json` en la prueba de contrato estricta (`openapi/pendientes.json` sigue vacío).

### Migración (Backoffice)

- Quien construya un `Dashboard` a mano (pruebas, historias) debe añadir `waitlist`. El resto es aditivo.
- La bitácora de los fixtures (`audit.json`) no cambia: las inscripciones sembradas no tienen eventos; las que se crean o se editan en la sesión sí.

## [0.4.0-rc.2] · 2026-09-27

**Retirada de H1** al cerrar la Ola 1 (`plan/contratos/o1-backoffice-y-bodegas.md` §11 y `o0-sesiones-y-estandares.md` §5), alineada con el backend en `dev` (`c9e96e5`: 112 operaciones, 138 esquemas). Pre-release sobre `dev`; detalle en [docs/CONTRATO.md](docs/CONTRATO.md) §8. El ERP y el Backoffice en `dev` ya no usaban nada de lo retirado (toleraban `tokens.refreshToken` como opcional).

### Retirado (rupturas y migración)

1. **Refresco solo en la cookie `doc_rt`**: las respuestas de sesión (`login`, `refresh`, `switch-organization`, `mfa/*`, aceptar invitación) ya no llevan `tokens.refreshToken`; `refresh` y `logout` no leen el cuerpo; `switch-organization` con `refreshToken` → 422 `VALIDATION_ERROR` en `refreshToken`. `AuthTokensSchema.refreshToken` queda opcional y `@deprecated` (se borra en 0.5); `RefreshTokenSchema` desaparece. *Migración*: quitar `legacyRefreshToken` y el cuerpo de `doRefresh()`/`switchOrganization()` del cliente de API (plantilla, ERP, Backoffice); renovar con `credentials: 'include'`.
2. **Sin rol global**: fuera `user.userRole`, `user.wineryId` y `user.memberRole` de la sesión, `userRole` de `GET/PATCH /v1/users/me` (`UserProfileResponseSchema`, `MeUserSchema`) y de los fixtures de personas (`users.json`, `auth-login.json`), y los claims `email`, `userRole`, `wineryId`, `memberRole` (`AccessTokenClaimsSchema`). Desaparecen `UserRoleSchema`/`USER_ROLES`/`UserRole` y `SignupRoleSchema`/`SIGNUP_ROLES`. *Migración*: el rol y la bodega salen de `memberships` y `activeOrganizationId`.
3. **`DemoUser`**: `userRole` y `memberRole` → `role` (rol en la organización activa: plataforma o bodega, o `null`); `wineryId` se mantiene. *Migración (paneles `/__mocks` del ERP, Backoffice y plantilla)*: `u.memberRole ?? u.userRole` → `u.role`.
4. **`signup` solo para consumidores**: `userRole` en el cuerpo → 422 (`SignupSchema` sin `userRole`).
5. **Rutas de 0.1 retiradas** (404, como el backend): `POST /v1/wineries`, `GET /v1/wineries/pending`, `POST /v1/wineries/{id}/approve|reject`, `GET|POST /v1/wineries/my/members`, `POST /v1/wineries/my/members/create`. Con ellas, `CreateWinerySchema`, `AddMemberSchema`, `CreateMemberSchema`, `ApproveWinerySchema`, `RejectWinerySchema`, `DEPRECATED_ROUTES` (de `/handlers`) y el código `WINERY_NOT_PENDING`. *Migración*: solicitudes (`/public/winery-applications`, `/platform/winery-applications/*`), alta directa (`/platform/wineries`) y equipo (`/organizations/current/members`, `/invitations`). Quedan `GET /v1/wineries` y `GET`/`PATCH /v1/wineries/my`.
6. **OpenAPI**: `openapi/erp.json` = backend tras la retirada; la prueba de contrato comprueba además que nada de lo retirado vuelva.

## [0.4.0-rc.1] · 2026-09-27

Alineación con el **backend real de la Ola 1 completa** (OpenAPI de `drinks-on-chain-back` en `dev`, `eace713`: 119 operaciones, 144 esquemas; `plan/contratos/o1-backoffice-y-bodegas.md` con §11 bis). `openapi/pendientes.json` queda vacío: la prueba de contrato valida todas las respuestas contra el OpenAPI real, en modo estricto. Pre-release sobre `dev`; detalle en [docs/CONTRATO.md](docs/CONTRATO.md) §2, §6.1 y §7.

### Añadido

- Operaciones nuevas del backend: `GET /v1/health/live`, `GET /v1/health/ready`, `GET /v1/uploads/url?key=` (URL firmada nueva), `GET /v1/platform/organizations/{organizationId}/invitations?status=` y `GET /v1/platform/accounts/{userId}` (ampliación del §11 bis).
- Esquemas: `DagGraphSchema`, `DagNodeSchema`, `DagOperatorSchema`, `DagLabAnalysisSchema`, `DagGraphMapSchema`; `AccountDetailSchema`, `AccountMembershipSchema`, `AccountStatusSchema`; `LivenessSchema`, `SignedUrlResponseSchema`, `UploadMimeTypeSchema`; `FermentationLogRecordSchema` y `EnologicalTreatmentRecordSchema` (filas de la semilla); relaciones en `HarvestBatchWithTerroirSchema`, `FermentationTankWithHarvestSchema`, `WineAgingDetailSchema`, `ProductionBatchDetailSchema`, `BottlingBatchDetailSchema` (y `TerroirDetailSchema`, `HarvestBatchDetailSchema`, `FermentationTankDetailSchema` ampliados).
- Relaciones de las respuestas del ERP como los `include` del backend (vendimia con `terroir`, cuba con `harvestBatch`, crianza y destilación con `fermentationTank`, embotellado con `labAnalysis` y su cadena en el detalle).
- Rutas obsoletas (H1) con `Deprecation: true` y `Link: <sustituta>; rel="successor-version"`; `DEPRECATED_ROUTES` en `/handlers`.
- Códigos en `API_ERROR_CODES` (el catálogo completo de `error-codes.ts` del backend): `AUTH_LOGIN_REQUIRED`, `AUTH_MFA_NOT_ENROLLED`, `AUTH_MFA_ALREADY_ENROLLED`, `AUTH_MFA_ENROLLMENT_NOT_STARTED`, `USER_NOT_FOUND`, `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `FILE_NOT_FOUND` y los que los mocks no emiten.
- Campo trampa `website` en `forgot-password` y `resend-verification`.
- Pruebas de todo lo anterior (`test/backend-ola1.test.ts`), de las cabeceras de las rutas obsoletas y de los archivos; la prueba de contrato exige además las mismas rutas obsoletas que el OpenAPI.

### Cambiado (rupturas y migración)

Para el **ERP** (O1-ERP-1), el **Backoffice** (O1-BO-1/2) y el **sitio de bodegas**:

1. **DAG y pasaporte público** (`GET /v1/traceability/dag/:id` y `/public/:lotCode`): ambos responden `DagGraphResponseDto` del backend `{ rootBatchId, internationalLotCode, productType, nodes[{ batchId, stage, stageName, parents, timestamp, volumeOrUnits, metrics, metadataHash, isCertified, operator, details }] }`, con el laboratorio en `details.labAnalysis` del nodo de embotellado (`null` sin análisis). Desaparecen la propuesta de los mocks (`{ bottlingBatchId, lotCode, nodes[{ id, type, label, date, data }], edges }`) y el pasaporte de `endpoints.md` (`lotCode`, `winery`, `product`, `terroir`, `laboratoryCertification`, `blockchainIntegrity`); `traceability-public.json` guarda el grafo por código de lote. `PublicPassportSchema`, `TraceabilityDagSchema` y `PublicPassportMapSchema` quedan como alias obsoletos de los nuevos. *Migración*: pintar el linaje con `nodes` (padres en `parents`, etapa en `stageName`) y leer el certificado en `nodes.at(-1).details.labAnalysis`.
2. **Lecturas y tratamientos**: `FermentationLogSchema` es la respuesta (`recordedByUserId`, la persona; antes `recordedByMemberId`) y `EnologicalTreatmentSchema` lleva `authorizedByMemberId`; la plataforma ya no registra tratamientos (403: los autoriza un miembro activo). Las filas de `fermentation-logs.json` y `enological-treatments.json` no cambian (`FermentationLogRecordSchema`, `EnologicalTreatmentRecordSchema`). *Migración (ERP)*: mostrar el autor de la lectura por `recordedByUserId`.
3. **`rest-status`** añade `processEndDate` (`null` si no hay) y `mandatoryRestUntil` es siempre presente (`null` posible); `daysElapsed` ≥ 0.
4. **Archivos**: `POST /v1/uploads` solo para personal (consumidor → 403 `FORBIDDEN`), tipo reconocido por el contenido (JPEG, PNG, WEBP, GIF ≤ 5 MB; PDF ≤ 15 MB; SVG ya no), 422 `FILE_TYPE_NOT_ALLOWED` (antes `VALIDATION_ERROR`) y 413 `FILE_TOO_LARGE`. Responde `{ key, url, expiresAt, … }` con la clave privada `org/<organización>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>` y una URL firmada de 15 min. *Migración (ERP)*: guardar `key` (no `url`) y pedir la URL con `GET /v1/uploads/url?key=` al mostrar el archivo.
5. **Salud**: `GET /v1/health` añade `storage` y `worker`.
6. **Esquemas `Create*` sin `null`** en los opcionales (`.optional()`, como el OpenAPI); los handlers siguen aceptando `null` como omitido. *Migración*: tipos de los formularios de alta sin `null` (omitir el campo).
7. **`AuthTokensSchema.refreshToken` opcional** (se retira del cuerpo en H1). *Migración*: no depender de él; la cookie `doc_rt` basta.
8. **Bitácora**: tipos de recurso en `snake_case` (`winery_application`, `winery`, `membership`, `invitation`, `user`, `setting`, `terroir`, `harvest_batch`, `fermentation_tank`, `fermentation_log`, `enological_treatment`, `wine_aging_batch`, `production_batch`, `bottling_batch`, `lab_analysis`, `file`) y acciones del backend (`FERMENTATION_LOG_ADDED`, `ENOLOGICAL_TREATMENT_ADDED`, `WINE_AGING_BATCH_CREATED`, `PRODUCTION_BATCH_CREATED`, `BOTTLING_BATCH_CREATED`, `LAB_ANALYSIS_CREATED`, `HARVEST_BATCH_PHYTO_STATUS_CHANGED`, `AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGIN_FAILED`, `WINERY_APPROVED`/`WINERY_REJECTED` en las rutas antiguas). *Migración (Backoffice)*: filtros `resourceType` y etiquetas de acción con los códigos nuevos.
9. **Códigos 404 y 422**: bodega inexistente → 404 `ORG_NOT_FOUND` (antes `NOT_FOUND`); solicitud inexistente, miembro de otra organización o membresía de plataforma inexistente → 404 `NOT_FOUND`; persona inexistente en `/platform/accounts/*` y `send-password-reset` → 404 `USER_NOT_FOUND`; enlace de verificación de solicitud desconocido, usado o caducado (72 h) → 422 `APPLICATION_TOKEN_INVALID`; `ORG_TAX_ID_TAKEN` (409) lleva `details[{ field: 'taxId' }]`.
10. **Segundo factor**: `AUTH_MFA_NOT_ENROLLED`, `AUTH_MFA_ALREADY_ENROLLED` y `AUTH_MFA_ENROLLMENT_NOT_STARTED` (409) en lugar de `CONFLICT`; `AUTH_MFA_INVALID_CODE` sin `details`. *Migración (Backoffice)*: mensajes por código.
11. **Invitaciones**: aceptar con una cuenta existente sin sesión → 401 `AUTH_LOGIN_REQUIRED` (antes `UNAUTHORIZED`); en una bodega exige además el refresco de esa sesión (cookie `doc_rt`, que se rota como en `switch-organization`; sin él → 401 `AUTH_REFRESH_INVALID`); ya miembro activo → 409 `ORG_ALREADY_MEMBER`; bloqueado por la plataforma e invitación del dueño → 403 `ORG_BLOCKED_BY_PLATFORM`; organización revocada → 403 `ORG_REVOKED`. Reenviar una caducada respeta el límite de colaboradores. *Migración (ERP)*: aceptar con `credentials: 'include'`.
12. **NIT**: una bodega `REVOKED` también ocupa su NIT; una solicitud `UNVERIFIED` caducada no; reenviar la misma solicitud sin verificar (mismo NIT y correo) la actualiza y manda un enlace nuevo (el anterior deja de valer).
13. **Equipo**: desbloquear respeta el límite de colaboradores (422 `ORG_MEMBER_LIMIT_REACHED`); cambiar el rol (o bloquear) revoca las sesiones de esa persona con la bodega; el mismo rol no cambia nada; la plataforma tampoco se modifica a sí misma (403 `ORG_CANNOT_MODIFY_SELF`); los roles que no son dueño ven `lastLoginAt: null`; `Member.accountStatus`/`accountBlockedReason` solo en las rutas de plataforma (y `Member.mfaEnabled` desaparece: está en `PlatformUser`). Los miembros salen por antigüedad.
14. **Usuarios internos**: `PlatformUser` gana `accountStatus` (`null` en una invitación sin cuenta) y `accountBlockedReason`; una invitación pendiente usa el nombre de la cuenta o el correo como `fullName`; bloquear la membresía o cambiar el rol de plataforma cierra solo las sesiones con la plataforma; el superusuario tampoco se bloquea por la cuenta; su segundo factor solo lo restablece otro superusuario.
15. **Configuración**: `SettingHistoryEntry.legalException` (nuevo, obligatorio) y `SettingDefinition.legalMinimum` siempre presente (`null` posible).
16. **Parcelas**: el `OPERATOR` lee `GET /v1/terroirs` y `/:id` (lectura mínima del §11 bis; sigue sin crear ni editar).
17. **Rutas obsoletas** (se retiran en H1): `POST /v1/wineries`, `GET|POST /v1/wineries/my/members`, `POST /v1/wineries/my/members/create`, `GET /v1/wineries/pending`, `POST /v1/wineries/{id}/approve|reject` y `POST /v1/auth/signup` con `userRole: 'WINERY_ADMIN'`. *Migración*: usar las sustitutas del `Link` (solicitudes y alta directa, `/organizations/current/members` e `/invitations`, `/platform/winery-applications/*`).
18. **OpenAPI**: `openapi/erp.json` = backend de la Ola 1 completa; sin `UserProfileResponseDto` (los fixtures de personas se validan como `MeUserDto`). Fixtures regenerados (`traceability-public.json`, `production-rest-status.json`, `audit.json`, `setting-history.json`) y `generate.py` al día.

## [0.3.0-rc.2] · 2026-09-27

Alineación con el backend real de la Ola 0 (O0-BE-4: sesiones, membresías, estado `INVITED`; `plan/contratos/o0-sesiones-y-estandares.md` §8) y con las precisiones de la Ola 1 (`plan/contratos/o1-backoffice-y-bodegas.md` §11 bis). Pre-release sobre `dev`; detalle en [docs/CONTRATO.md](docs/CONTRATO.md) §0, §3 y §6.1.

### Añadido

- `POST /v1/platform/accounts/{userId}/block` y `/unblock`: bloqueo de la **cuenta completa** (`UserAccountStatus`, solo `ADMIN`/`SUPERADMIN`, revoca todas las sesiones).
- Periodo de gracia de 20 s de la renovación (el refresco inmediatamente anterior devuelve el mismo par nuevo), caducidad deslizante de la sesión (7 días el personal, 30 los consumidores; 401 `AUTH_SESSION_EXPIRED`) y bloqueo progresivo del login por correo (5 fallos → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After`, duplicándose hasta 1 h).
- `expireRefreshGrace()`, `REFRESH_GRACE_SECONDS` y `LOGIN_LOCK_POLICY` en `/handlers` (y `expireRefreshGrace` en `/node` y `/browser`); `expireAccessTokens()` también cierra la gracia.
- Códigos en `API_ERROR_CODES`: `AUTH_INVALID_CREDENTIALS`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_REFRESH_INVALID`, `AUTH_SESSION_EXPIRED`, `AUTH_INSUFFICIENT_PERMISSIONS`, `ORG_MEMBERSHIP_BLOCKED`, `ORG_REVOKED`.
- `SwitchOrganizationSchema.refreshToken` (opcional, *retirada* en H1).
- Pruebas de la matriz de permisos, `?wineryId=`, códigos de sesión, gracia, reutilización y bloqueo del login (`test/permissions.test.ts`, `test/sessions.test.ts`).

### Cambiado (rupturas y migración)

Para el **ERP** (O1-ERP-1) y el **Backoffice**:

1. **Permisos del ERP por la membresía activa**, como los guards del backend (matriz en docs/CONTRATO.md §3). `OPERATOR` ya no actúa como enólogo: pesa (`POST /harvest-batches`) y registra lecturas (`POST …/logs`), lee vendimia y cubas, y recibe 403 en parcelas, crianza, destilación, embotellado, laboratorio, alta de cubas, tratamientos y dictamen. `ACCOUNTANT` solo lee (parcelas, vendimia, cubas, crianza, destilación, embotellado, laboratorio). `OWNER` dictamina (`phyto-status`); `AGRONOMIST` registra lecturas pero no lee crianza, destilación ni embotellado. El `POS_OPERATOR` global ya no registra lecturas y los consumidores ya no leen `GET /lab-analyses/batch/:id`. *Migración (ERP)*: sustituir la tabla `ERP_ROLE_FOR_MEMBERSHIP` (`OPERATOR`/`ACCOUNTANT → ENOLOGIST`) y `RULES` de `src/lib/erp/permissions.ts` por la matriz por `membership.role`; ocultar al operario y al contador lo que ya no pueden hacer.
2. **Plataforma sobre una bodega con `?wineryId=`** (OP-07): las lecturas sin él ven todas las bodegas; **toda escritura del ERP de la plataforma exige `?wineryId=`** (sin él → 422 `VALIDATION_ERROR` con `details[{ field: 'wineryId' }]`; no UUID → 422; bodega inexistente → 404 `ORG_NOT_FOUND`). `SUPPORT` solo lee (escrituras → 403); `GET /wineries/my` y `/my/members` de la plataforma también usan `?wineryId=`. Una bodega que apunta a otra con `wineryId` → 404. `approve`/`reject` de `/v1/wineries/:id` solo `SUPERADMIN`, `ADMIN`, `OPERATIONS`. *Migración (ERP en modo plataforma y Backoffice)*: añadir `?wineryId=<bodega>` a las escrituras y a las lecturas de una bodega concreta.
3. **`switch-organization` exige el refresco de la misma sesión** (cookie `doc_rt` o `refreshToken` en el cuerpo) y lo rota; sin él o de otra sesión → 401 `AUTH_REFRESH_INVALID`. Membresía bloqueada → 403 `ORG_MEMBERSHIP_BLOCKED` y organización revocada → 403 `ORG_REVOKED` (antes `FORBIDDEN`). *Migración*: llamar con `credentials: 'include'` (la cookie basta; en los mocks la pone MSW) o, hasta H1, enviar `refreshToken` en el cuerpo; guardar los tokens nuevos de la respuesta.
4. **Formato del refresco** `<sid>.<generación>.<secreto>` (antes `mock.rt.<sid>.<n>`). Uno inventado → 401 `AUTH_REFRESH_INVALID` sin revocar; el anterior dentro de 20 s → el mismo par; uno antiguo fuera de la gracia → 401 `AUTH_REFRESH_REUSED` y sesión revocada. Las sesiones guardadas en `localStorage` por 0.3.0-rc.1 se descartan (hay que volver a iniciar sesión). *Migración*: tratar el refresco como opaco.
5. **Códigos 401/403/429 del backend**: login con credenciales malas o cuenta bloqueada → `AUTH_INVALID_CREDENTIALS` (antes `UNAUTHORIZED`); acceso ausente o mal formado → `AUTH_TOKEN_INVALID`; acceso caducado → `AUTH_TOKEN_EXPIRED` (antes `UNAUTHORIZED`); rol, audiencia o tipo de organización insuficientes → 403 `AUTH_INSUFFICIENT_PERMISSIONS` (antes `FORBIDDEN`, también en el back office); 5 logins fallidos → 429 `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After`. *Migración*: renovar ante `AUTH_TOKEN_EXPIRED` (o cualquier 401 que no sea de `refresh`); decidir por el estado HTTP y no por `code === 'FORBIDDEN' | 'UNAUTHORIZED'`; mostrar la espera del 429 en el login.
6. **Altas de miembros** (`POST /wineries/my/members`): ya miembro activo → 409 `ORG_ALREADY_MEMBER` (antes `CONFLICT`); reactivar a quien bloqueó la plataforma siendo dueño → 403 `ORG_BLOCKED_BY_PLATFORM` (la plataforma sí puede, con `?wineryId=`).
7. **`PATCH /v1/users/me` responde `{ user, memberships, activeOrganizationId }`** (antes el perfil suelto), como `GET` (§11 bis). *Migración (ERP)*: validar con `MeResponseSchema` (el ERP ya acepta las dos formas con `meFromUpdate`).
8. **Bloqueo de usuarios internos y de cuentas**: `POST /v1/platform/users/{membershipId}/block|unblock` solo acepta ids de membresía de plataforma (otro id → 404); la cuenta completa pasa a `POST /v1/platform/accounts/{userId}/block|unblock`. *Migración (Backoffice)*: usar la ruta de cuentas para bloquear a una persona.
9. **OpenAPI**: `openapi/erp.json` = backend O0-BE-4 (48 operaciones, 50 esquemas). Salen de `openapi/pendientes.json` `switch-organization`, `logout`, `logout-all`, los cambios de `refresh` y `GET /users/me`, los campos extra de sesión y el cambio de enumeración `INVITED` (ya están en el backend).

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
