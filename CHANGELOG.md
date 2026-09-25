# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones [SemVer](https://semver.org/lang/es/).

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
