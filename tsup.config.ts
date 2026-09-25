import { defineConfig } from 'tsup'

// Cinco puntos de entrada; msw y zod quedan fuera del bundle (peer dependencies).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    fixtures: 'src/fixtures.ts',
    handlers: 'src/handlers.ts',
    browser: 'src/browser.ts',
    node: 'src/node.ts',
  },
  format: ['esm'],
  target: 'es2022',
  // tsup inyecta baseUrl al generar los .d.ts; TypeScript 6 lo marca como obsoleto.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
  splitting: true,
  treeshake: true,
  sourcemap: false,
  external: ['msw', 'msw/browser', 'msw/node', 'zod'],
})
