# @drinks-on-chain/mocks

Datos de prueba compartidos del ecosistema **Drinks on Chain**: esquemas zod de los DTO del backend, fixtures JSON deterministas, la vista derivada `LotView` y handlers [MSW](https://mswjs.io) que imitan el backend del ERP con su envoltorio, sesión (organizaciones, membresías y renovación rotativa en cookie), roles, multi-tenant y reglas de negocio. Desde 0.2 siguen el **contrato de la Ola 0** (`plan/contratos/o0-sesiones-y-estandares.md` del plan maestro). Las apps se construyen contra estos mocks y pasan al backend real cambiando `NEXT_PUBLIC_API_URL` y apagando MSW.

Planificación: [`drinks-on-chain-docsfront`](https://github.com/drinks-on-chain/drinks-on-chain-docsfront) (docs 08 y 09). Diferencias entre el OpenAPI y los mocks: [`docs/CONTRATO.md`](docs/CONTRATO.md). Avance: [`docs/ROADMAP.md`](docs/ROADMAP.md).

Alcance actual: dominio **ERP** (el único con backend real). Marketplace, Backoffice y POS se añadirán con la misma estructura (`src/<dominio>/`, `fixtures/<dominio>/`).

## Instalación

No hace falta registro de paquetes: cada versión se publica como GitHub Release con el tarball. Las versiones `X.Y.Z-rc.N` son pre-releases publicadas desde `dev` para adelantar el contrato de una ola; las estables salen de `main`. Migración de 0.1 a 0.2: ver [CHANGELOG](CHANGELOG.md).

```bash
pnpm add https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.2.0-rc.1/drinks-on-chain-mocks-0.2.0-rc.1.tgz
pnpm add zod msw        # peer dependencies (msw solo si usas los handlers)
```

```json
"dependencies": {
  "@drinks-on-chain/mocks": "https://github.com/drinks-on-chain/drinks-on-chain-mocks/releases/download/v0.2.0-rc.1/drinks-on-chain-mocks-0.2.0-rc.1.tgz"
}
```

## Puntos de entrada

| Import | Contenido | ¿Importa msw? |
|---|---|---|
| `@drinks-on-chain/mocks` | Esquemas zod (respuesta y alta/edición) y tipos de cada recurso, enumeraciones, sesión (`SessionResponseSchema`, `MeResponseSchema`, `MembershipSchema`, `OrganizationType`, roles de plataforma, bodega y punto de canje, `AccessTokenClaims`), envoltorio (`successEnvelopeSchema`, `ErrorEnvelopeSchema`, `ApiErrorDetail`), listas (`ListPage<T>`, `listPageSchema`, `DEFAULT_LIMIT`, `MAX_LIMIT`, `unwrapList`), `deriveLotViews`, `deriveRestStatus` | No. Apto para producción |
| `@drinks-on-chain/mocks/fixtures` | `erpFixtures` (JSON tipados), `demoUsers` (con membresías), `DEMO_PASSWORD` | No |
| `@drinks-on-chain/mocks/fixtures/erp/<archivo>.json` | JSON crudos | No |
| `@drinks-on-chain/mocks/handlers` | `createErpHandlers()`, `resetErpDb()`, `getErpDb()`, `resetSessions()`, `expireAccessTokens()`, `ERP_ROUTES`, `ERP_ROUTE_SPECS`, escenarios, `demoUsers`, `mockAccessToken()` | Sí |
| `@drinks-on-chain/mocks/browser` | `startMockWorker(options)` (Service Worker) | Sí (import dinámico) |
| `@drinks-on-chain/mocks/node` | `setupMockServer(options)` para Vitest, Playwright y scripts | Sí |

```ts
import { deriveLotViews, TerroirResponseSchema, type LotView } from '@drinks-on-chain/mocks'

const lots: LotView[] = deriveLotViews({ harvestBatches, terroirs, tanks, wineAgings, productionBatches, bottlings })
```

`deriveLotViews` es la función que usa el ERP en producción para mostrar el "lote" que el backend no tiene (doc 09 §2): acepta datos reales y un `today` opcional.

## Conectar MSW en una app Next.js 16 (App Router)

1. Copia el Service Worker a `public/` (una vez, y de nuevo al actualizar msw):

   ```bash
   pnpm exec msw init public --save
   ```

2. Variables de entorno (`.env.development.local`):

   ```bash
   NEXT_PUBLIC_MOCKS=1
   NEXT_PUBLIC_API_URL=https://136.243.223.39.sslip.io   # o vacío si la app llama a /api/v1 (P-1)
   ```

   Con la propuesta P-1 la app llama a `/api/v1/*` de su propio origen y `next.config` lo reescribe a `${API_ORIGIN}/v1/*`, para que la cookie de renovación sea de primera parte. Los handlers responden **siempre** tanto en `${baseUrl}/v1/*` como en `/api/v1/*` de cualquier origen, así que la misma configuración de MSW sirve para los dos modos.

3. Componente cliente que espera al worker antes de pintar la app:

   ```tsx
   // src/app/mocks-provider.tsx
   'use client'

   import { useEffect, useState, type ReactNode } from 'react'

   const MOCKS = process.env.NEXT_PUBLIC_MOCKS === '1'

   export function MocksProvider({ children }: { children: ReactNode }) {
     const [ready, setReady] = useState(!MOCKS)

     useEffect(() => {
       if (!MOCKS) return
       import('@drinks-on-chain/mocks/browser')
         .then(({ startMockWorker }) => startMockWorker({ baseUrl: process.env.NEXT_PUBLIC_API_URL }))
         .then(() => setReady(true))
     }, [])

     return ready ? children : null
   }
   ```

   ```tsx
   // src/app/layout.tsx
   import { MocksProvider } from './mocks-provider'

   export default function RootLayout({ children }: { children: React.ReactNode }) {
     return (
       <html lang="es">
         <body>
           <MocksProvider>{children}</MocksProvider>
         </body>
       </html>
     )
   }
   ```

   El `import()` dinámico deja msw en un chunk aparte que solo se descarga con `NEXT_PUBLIC_MOCKS=1`. Sin `baseUrl` los handlers interceptan `*/v1/...` en cualquier origen (lo que incluye `/api/v1/...`); con `baseUrl` ese origen más `*/api/v1/...`, y además responden 404 con envoltorio a las rutas `/v1/*` y `/api/v1/*` desconocidas. El `path` del envoltorio es siempre `/v1/...`.

4. Si algún Server Component llama al backend, el Service Worker no lo ve: arranca también el servidor de Node en `instrumentation.ts`:

   ```ts
   export async function register() {
     if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PUBLIC_MOCKS === '1') {
       const { setupMockServer } = await import('@drinks-on-chain/mocks/node')
       setupMockServer({ baseUrl: process.env.NEXT_PUBLIC_API_URL }).listen({ onUnhandledRequest: 'bypass' })
     }
   }
   ```

Las URL de archivos de los fixtures (`/mocks/uploads/...`) las sirve la app desde `public/mocks/uploads/` si quiere mostrarlas; si no existen, la pantalla debe tolerar el 404 de la imagen.

### En pruebas (Vitest / Playwright)

```ts
import { resetErpDb, setupMockServer } from '@drinks-on-chain/mocks/node'

const server = setupMockServer({ baseUrl: 'https://api.test' }) // latencia 0 por defecto
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => { server.resetHandlers(); resetErpDb() })
afterAll(() => server.close())
```

## Qué simulan los handlers

- Las 45 operaciones (35 rutas, incluida `/v1/health`) del OpenAPI con el envoltorio real: `{ success, statusCode, timestamp, path, data | error: { code, message, details } }`, más `switch-organization`, `logout` y `logout-all` del contrato de la Ola 0. Todas devuelven `X-Correlation-ID`.
- **Sesión** (contrato §4–§5): `POST /v1/auth/login` con cualquier usuario de `users.json` y `demo1234` devuelve `{ user, memberships, activeOrganizationId, tokens }` (lo de `auth-login.json` con tokens de sesión propios): acceso de 15 min con forma de JWT (claims `sub`, `aud`, `org`, `orgType`, `role`, `sid`…), `refreshToken` en el cuerpo por compatibilidad y cookie `doc_rt` (`HttpOnly`, `SameSite=Lax`). `refresh` lee la cookie (o el cuerpo), rota siempre y detecta la reutilización (401 `AUTH_REFRESH_REUSED`); `switch-organization` cambia la organización activa en la misma sesión; `logout`/`logout-all` revocan (204). `GET /v1/users/me` → `{ user, memberships, activeOrganizationId }`. Las sesiones sobreviven a una recarga (`localStorage`); `expireAccessTokens()` simula que pasaron 15 min. El token estático `mock.access.<clave>` sigue valiendo (paneles y pruebas).
- **Roles** (doc 09 §3) evaluados contra la **membresía activa** → 403; **multi-tenant** por la bodega activa (la plataforma ve todo; lo de otra bodega da 404). Bloquear la membresía activa revoca la sesión en la siguiente petición (401 `AUTH_SESSION_REVOKED`).
- **Filtros** de las pantallas (`status`, `destinationType`, `harvestBatchId`, `restStatus`, `processType`, `varietyName`, `isDoEligible`, `isActive`, `harvestYear`, `phytosanitaryStatus`, `productType`, `isAnchoredOnChain`, `search`…) y `limit`/`offset` (por defecto 20/0; `limit` > 100 → 422).
- **Validación** de cuerpos y parámetros con los esquemas de alta (**422** `VALIDATION_ERROR`, `details: [{ field, message }]`) y **reglas 422** con el campo que las provoca: embotellar antes de `lockUntilDate` o antes de 180 días de reposo, destilación D.O. con parcela no apta o bajo 1.600 m, pesaje sin Brix/pH/acidez. JSON mal formado → 400 `BAD_REQUEST`. También 404 y 409 documentados.
- **Mutaciones** en memoria: lo que se crea aparece en las listas durante la sesión; ids UUID v5 deterministas (`mock:<recurso>:<n>`) y reloj fijo que empieza el 2026-09-25 a las 12:00 UTC y avanza un minuto por alta. `resetErpDb()` vuelve al estado inicial.
- `POST /v1/uploads` (multipart, ≤ 15 MB, PDF e imágenes) devuelve `/mocks/uploads/<carpeta>/<n>-<archivo>`; `GET /v1/traceability/public/:lotCode` es público; `GET /v1/traceability/dag/:id` devuelve el grafo de la cadena.

Todas las colecciones responden `data: { items, total, limit, offset }` (contrato §2), también `wineries/pending` y `wineries/my/members`. La forma vive solo en `src/shared/list.ts`; `unwrapList(data)` sigue aceptando un array plano por si hay que hablar con un backend anterior al contrato.

## Escenarios

| Nombre | Efecto |
|---|---|
| `normal` | Por defecto |
| `empty` | Las listas vuelven vacías |
| `error` | 500 `INTERNAL_SERVER_ERROR` con envoltorio en todas las rutas salvo `/v1/auth/*` |
| `slow` | +2,5 s por respuesta |
| `offline` | Error de red |

Se eligen con `setScenario('empty')` (se guarda en `localStorage`), con `?mock=empty` en la URL o volviendo al valor por defecto con `resetScenario()`. La latencia normal es de 200–400 ms en el navegador y 0 en Node (`latency` en las opciones la cambia).

## Usuarios de demo

Contraseña de todos: `demo1234`. Para un panel "cambiar de usuario" usa `demoUsers` (email, rol, membresías, organización activa, contraseña y token estático). Membresías: los `PLATFORM_ADMIN` son `SUPERADMIN` de la organización de plataforma; el resto, las de su bodega con el `memberRole` indicado.

| Email | Nombre | `userRole` | `memberRole` | Bodega | Clave |
|---|---|---|---|---|---|
| `gestor@drinksonchain.test` | Ana Gutiérrez | `PLATFORM_ADMIN` | — | — | `admin` |
| `soporte@drinksonchain.test` | Pablo Rivera | `PLATFORM_ADMIN` | — | — | `soporte` |
| `admin@altos.test` | Martín Calamuchita | `WINERY_ADMIN` | `OWNER` | Bodega Altos de Calamuchita | `altos_admin` |
| `enologa@altos.test` | Lic. Carla Villarroel | `ENOLOGIST` | `ENOLOGIST` | Bodega Altos de Calamuchita | `altos_enologa` |
| `agronomo@altos.test` | Ing. Diego Paredes | `AGRONOMIST` | `AGRONOMIST` | Bodega Altos de Calamuchita | `altos_agronomo` |
| `operario@altos.test` | Mario Quispe | `ENOLOGIST` | `OPERATOR` | Bodega Altos de Calamuchita | `altos_operario` |
| `admin@cintiviejo.test` | Rosa Camargo | `WINERY_ADMIN` | `OWNER` | Destilería Cinti Viejo | `cvj_admin` |
| `enologa@cintiviejo.test` | Lic. Lucía Rojas | `ENOLOGIST` | `ENOLOGIST` | Destilería Cinti Viejo | `cvj_enologa` |
| `agronomo@cintiviejo.test` | Ing. Tomás Flores | `AGRONOMIST` | `AGRONOMIST` | Destilería Cinti Viejo | `cvj_agronomo` |
| `operario@cintiviejo.test` | Rubén Flores | `ENOLOGIST` | `OPERATOR` | Destilería Cinti Viejo | `cvj_operario` |
| `gerencia@guadalquivir.test` | Elena Vaca | `WINERY_ADMIN` | `OWNER` | Viñedos del Guadalquivir (pendiente) | `vgq_admin` |
| `maria@tribu.test` | María Fernández | `CONSUMER` | — | — | `maria` |
| `carlos@tribu.test` | Carlos Mamani | `CONSUMER` | — | — | `carlos` |
| `cajero.lacava@drinksonchain.test` | Juan Pérez | `POS_OPERATOR` | — | — (sin membresía hasta la Ola 5) | `juan_pos` |
| `sofia@aramayo.test` | Lic. Sofía Aramayo | `ENOLOGIST` | `ENOLOGIST` · `OWNER` | Bodega Altos de Calamuchita (activa) · Casa Uriondo (suspendida) | `sofia` |
| `ines@salazar.test` | Ing. Inés Salazar | `AGRONOMIST` | `AGRONOMIST` · `OPERATOR` bloqueada | Destilería Cinti Viejo (activa) · Bodega Altos de Calamuchita | `ines` |

## Regenerar los fixtures

```bash
pnpm seed          # escribe fixtures/erp/*.json desde src/erp/seed/generate.ts
pnpm seed:check    # igual, y falla si queda algún cambio sin commitear
```

El generador es un puerto exacto de `generate.py` (docs/mocks/erp): Mersenne Twister compatible con `random.Random` de CPython, `round()` de Python y UUID v5. `test/seed.test.ts` exige que la salida sea igual, objeto a objeto, a la de Python guardada en `test/reference/erp/`. Si cambias el modelo:

1. Cambia `test/reference/erp/generate.py` y ejecútalo (`python test/reference/erp/generate.py`) para regenerar la referencia.
2. Aplica el mismo cambio en `src/erp/seed/generate.ts` y ejecuta `pnpm seed`.
3. `pnpm test` debe pasar (la CI repite ambos pasos y exige que no queden diferencias).

## Desarrollo

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm openapi:pull -- <url|ruta>   # copia un OpenAPI 3 a openapi/erp.json y resume las operaciones nuevas o retiradas
```

`pnpm test` incluye la **prueba de contrato** (`test/contract.test.ts`, [docs/CONTRATO.md §5](docs/CONTRATO.md)): cada `RouteSpec` existe en `openapi/erp.json` o está adelantada en `openapi/pendientes.json` con su referencia al contrato de ola, y cada fixture y cada respuesta de ejemplo valida con Ajv contra el esquema del OpenAPI.

Estructura:

```
openapi/erp.json          OpenAPI del backend (fuente de verdad; pnpm openapi:pull)
openapi/pendientes.json   lo que adelanta un contrato de ola y el OpenAPI aún no tiene
scripts/openapi-pull.mjs  pnpm openapi:pull
src/index.ts              entrada raíz (sin msw)
src/shared/               envoltorio, forma de listas, escenarios, fechas, UUID v5
src/erp/schemas/          zod por recurso (respuesta + alta/edición) y LotView
src/erp/seed/             generador determinista (pnpm seed)
src/erp/handlers/         MSW: base en memoria, sesión, roles, rutas
src/erp/lot-view.ts       deriveLotViews / deriveRestStatus
src/{marketplace,backoffice,pos}/   dominios futuros
fixtures/erp/             JSON generados (se publican en el paquete)
test/reference/erp/       salida de Python y generate.py de referencia
```

## Publicar una versión

1. Sube `version` en `package.json` y añade la entrada en `CHANGELOG.md` (en `dev`, PR a `main`).
2. En `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. Pre-release: con `version` = `X.Y.Z-rc.N` en `dev` y la CI verde, `git tag vX.Y.Z-rc.N` sobre `dev`.
3. `release.yml` prueba, construye, ejecuta `pnpm pack` y crea la GitHub Release con `drinks-on-chain-mocks-<versión>.tgz` (marcada como pre-release si la versión lleva guion).
4. En cada app, actualiza la URL del tarball y ejecuta `pnpm install` (y `pnpm exec msw init public` si cambió msw).
