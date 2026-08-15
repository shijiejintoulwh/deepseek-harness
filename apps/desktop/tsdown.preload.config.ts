import { defineConfig } from 'tsdown'

/** Bundle the sandbox-compatible preload as one CommonJS file. */
export default defineConfig({
  entry: ['src/preload.ts'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: true,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
    alwaysBundle: (id: string) => id !== 'electron',
    onlyBundle: false,
  },
})
