import { defineConfig } from 'tsdown'

/** Bundle the Electron process entries while leaving Electron's built-in module external. */
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'update-renderer': 'src/update-renderer.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
    alwaysBundle: (id: string) => id !== 'electron',
    onlyBundle: false,
  },
})
