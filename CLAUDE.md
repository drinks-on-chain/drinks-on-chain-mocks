# drinks-on-chain-mocks · convenciones

Paquete `@drinks-on-chain/mocks`: esquemas, fixtures y handlers MSW del ecosistema Drinks on Chain. Lee antes `README.md`, `docs/CONTRATO.md` y `docs/ROADMAP.md` (marca las casillas `- [x] … · fecha`).

- **Fuente de verdad**: `openapi/erp.json` más el contrato de la ola en curso (`plan/contratos/` del plan maestro). Si cambia el backend: `pnpm openapi:pull -- <url|ruta>`, ajusta los esquemas, borra de `openapi/pendientes.json` lo que ya llegó y anota las diferencias en `docs/CONTRATO.md`. Lo que se adelante por contrato de ola va en `openapi/pendientes.json` con su referencia; la prueba de contrato (`test/contract.test.ts`) lo exige.
- **Fixtures**: nunca se editan a mano. Se cambia `test/reference/erp/generate.py` (y se ejecuta) y el mismo cambio en `src/erp/seed/generate.ts`; luego `pnpm seed`. `pnpm test` exige igualdad con Python.
- **Forma de las listas**: solo en `src/shared/list.ts` (`{ items, total, limit, offset }`, `limit` 20/100).
- **Sesión**: `src/erp/handlers/sessions.ts` (tokens, cookie `doc_rt`, rotación) y `auth-context.ts` (organización activa y roles efectivos).
- **Entrada raíz sin msw**: `src/index.ts` no puede importar nada de `src/erp/handlers`, `msw` ni los fixtures (va a producción).
- **Handlers**: una `RouteSpec` por operación del OpenAPI en `src/erp/handlers/routes/`, con su petición de ejemplo en `test/contract.test.ts`; errores con los helpers de `errors.ts` (422 con `details: [{ field, message }]`); mutaciones sobre `getErpDb()` y fechas con `tick()`/`today()` (nunca `Date.now()`).
- Comentarios y documentación en español, breves; identificadores en inglés. TypeScript estricto.
- Antes de cada commit: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Git: trabajo en `dev`, Conventional Commits, un commit por cambio lógico, PR `dev → main`. Las versiones se publican con una etiqueta `v*` en `main`; las pre-releases `vX.Y.Z-rc.N`, sobre `dev` (ver README).
