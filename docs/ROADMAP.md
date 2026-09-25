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
- [ ] Revisión y push de `dev`; PR `dev → main`
- [ ] Etiqueta `v0.1.0` y primera GitHub Release con el tarball
- [ ] Instalar en la plantilla de aplicación (Etapa 0.3) y en `drinks-on-chain-erp` (Etapa 1)
- [ ] Confirmar con backend los puntos abiertos de `docs/CONTRATO.md` §4 (forma de listas, DAG, detalles con relaciones, códigos 403/409/422)

## Más adelante

- [ ] Página `/__mocks` de ejemplo (selector de escenario y de usuario) en la plantilla de aplicación
- [ ] Dominio Marketplace (`src/marketplace/`, `fixtures/marketplace/`): colecciones, pedidos, pases, billeteras
- [ ] Dominio Backoffice (`src/backoffice/`): alta de bodegas, emisión, tickets
- [ ] Dominio POS (`src/pos/`): dispositivos, turnos, entregas, cola sin conexión
- [ ] Escenarios con nombre del doc 08 (`dia-de-vendimia`, `lote-listo`)
