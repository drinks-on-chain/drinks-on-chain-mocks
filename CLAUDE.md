# drinks-on-chain-mocks · convenciones

Paquete `@drinks-on-chain/mocks`: esquemas, fixtures y handlers MSW del ecosistema Drinks on Chain. Lee antes `README.md`, `docs/CONTRATO.md` y `docs/ROADMAP.md` (marca las casillas `- [x] … · fecha`).

- **Fuente de verdad**: `openapi/erp.json`. Si cambia el backend, vuelve a descargarlo (`curl -s https://136.243.223.39.sslip.io/docs-json`), ajusta los esquemas y anota las diferencias en `docs/CONTRATO.md`.
- **Fixtures**: nunca se editan a mano. Se cambia `test/reference/erp/generate.py` (y se ejecuta) y el mismo cambio en `src/erp/seed/generate.ts`; luego `pnpm seed`. `pnpm test` exige igualdad con Python.
- **Forma de las listas**: solo en `src/shared/list.ts`.
- **Entrada raíz sin msw**: `src/index.ts` no puede importar nada de `src/erp/handlers`, `msw` ni los fixtures (va a producción).
- **Handlers**: una `RouteSpec` por operación del OpenAPI en `src/erp/handlers/routes/`; errores con los helpers de `errors.ts`; mutaciones sobre `getErpDb()` y fechas con `tick()`/`today()` (nunca `Date.now()`).
- Comentarios y documentación en español, breves; identificadores en inglés. TypeScript estricto.
- Antes de cada commit: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Git: trabajo en `dev`, Conventional Commits, un commit por cambio lógico, PR `dev → main`. Las versiones se publican con una etiqueta `v*` en `main` (ver README).
