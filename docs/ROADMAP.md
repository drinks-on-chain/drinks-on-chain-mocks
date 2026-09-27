# Roadmap · drinks-on-chain-mocks

Etapa 0.2 del roadmap del frontend (`drinks-on-chain-docsfront`, doc 03): paquete `@drinks-on-chain/mocks` 0.1 con el dominio ERP.

## Etapa 0.2 · ERP

- [x] Scaffold: pnpm 10, TypeScript estricto, tsup (ESM + d.ts), Vitest, ESLint · 25-09-2026
- [x] Snapshot del OpenAPI del backend en `openapi/erp.json` · 25-09-2026
- [x] Esquemas zod por recurso (respuesta y alta/edición), enumeraciones, envoltorio y forma de listas aislada · 25-09-2026
- [x] Generador determinista en TypeScript (`pnpm seed`), igual objeto a objeto a `generate.py` · 25-09-2026
- [x] Validación de cada fixture contra su esquema en CI · 25-09-2026
- [x] `deriveLotViews` / `deriveRestStatus` como funciones puras con pruebas contra `lots-view.json` · 25-09-2026
- [x] Handlers MSW de las 45 operaciones del OpenAPI (sesión, roles, multi-tenant, filtros, paginación, 400/404/409/422, mutaciones en memoria, uploads, trazabilidad) · 25-09-2026
- [x] Escenarios `normal`, `empty`, `error`, `slow`, `offline` y latencia simulada · 25-09-2026
- [x] Entradas `/`, `/fixtures`, `/handlers`, `/browser`, `/node` (msw fuera de la raíz) · 25-09-2026
- [x] Pruebas con `msw/node` del recorrido del ERP · 25-09-2026
- [x] CI (`ci.yml`) y release por etiqueta (`release.yml`) · 25-09-2026
- [x] README, CHANGELOG, `docs/CONTRATO.md` con las diferencias OpenAPI ↔ mocks · 25-09-2026
- [x] Revisión y push de `dev`; PR `dev → main` (#1) · 25-09-2026
- [x] Etiqueta `v0.1.0` y primera GitHub Release con el tarball · 25-09-2026
- [x] Instalar en la plantilla de aplicación (Etapa 0.3) y en `drinks-on-chain-erp` (Etapa 1) · 25-09-2026
- [ ] Confirmar con backend los puntos abiertos de `docs/CONTRATO.md` §4 (DAG, detalles con relaciones, códigos 403/409) — la forma de listas y los 422 los fija el contrato de la Ola 0

## Ola 0 · `mocks` 0.2 (O0-PK-2, contrato `plan/contratos/o0-sesiones-y-estandares.md`)

- [x] Listas `{ items, total, limit, offset }` en todas las colecciones (`limit` 20 por defecto, 100 máximo → 422), incluidas `wineries/pending` y `wineries/my/members` · 27-09-2026
- [x] Errores: 422 `VALIDATION_ERROR` con `details: [{ field, message }]`; reglas 422 con su campo; `details: null` en el resto · 27-09-2026
- [x] Organizaciones y membresías (`Membership`, `OrganizationType`, roles, `Audience`) y usuarios de demo con varias membresías · 27-09-2026
- [x] Sesión: login con membresías y organización activa, acceso de 15 min, cookie `doc_rt` (almacén de MSW + almacén propio), `refresh` rotativo con `AUTH_REFRESH_REUSED`, `switch-organization`, `logout`, `logout-all`, `GET /users/me` con membresías, revocación inmediata · 27-09-2026
- [x] Rutas en `${baseUrl}/v1/*` y `/api/v1/*` (P-1) y `X-Correlation-ID` · 27-09-2026
- [x] Esquemas exportados (`SessionResponse`, `MeResponse`, `ListPage<T>`…), fixtures regenerados y `generate.py` al día (comparación objeto a objeto completa, sesión incluida) · 27-09-2026
- [x] Prueba de contrato con Ajv (`test/contract.test.ts`) y `openapi/pendientes.json` · 27-09-2026
- [x] `pnpm openapi:pull -- <url|ruta>` · 27-09-2026
- [x] `release.yml`: `vX.Y.Z-rc.N` sobre `dev` como pre-release · 27-09-2026
- [x] Versión 0.2.0 y CHANGELOG con la migración · 27-09-2026
- [x] Etiqueta `v0.2.0-rc.1` sobre `dev`: pre-release con `drinks-on-chain-mocks-0.2.0-rc.1.tgz` · 27-09-2026
- [ ] Regenerar desde el OpenAPI del backend cuando publique O0-BE-2/O0-BE-4 (`pnpm openapi:pull`) y vaciar `openapi/pendientes.json`
- [ ] `Idempotency-Key` (contrato §3, obligatoria desde la Ola 3)
- [ ] Etiqueta estable `v0.2.0` en `main` al cerrar la Ola 0 (coordinación)

## Más adelante

- [ ] Página `/__mocks` de ejemplo (selector de escenario y de usuario) en la plantilla de aplicación
- [ ] Dominio Marketplace (`src/marketplace/`, `fixtures/marketplace/`): colecciones, pedidos, pases, billeteras
- [ ] Dominio Backoffice (`src/backoffice/`): alta de bodegas, emisión, tickets
- [ ] Dominio POS (`src/pos/`): dispositivos, turnos, entregas, cola sin conexión
- [ ] Escenarios con nombre del doc 08 (`dia-de-vendimia`, `lote-listo`)
