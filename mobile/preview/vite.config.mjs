import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const mobileDirectory = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: './',
  plugins: [
    {
      name: 'preview-native-image-sources',
      enforce: 'pre',
      transform(code, id) {
        if (id.includes('/node_modules/') || !/\.[jt]sx?$/.test(id)) {
          return null;
        }
        const imports = [];
        const transformed = code.replace(
          /require\((['"])([^'"]+\.(?:png|jpe?g|webp))\1\)/g,
          (_match, _quote, imagePath) => {
            const name = `__previewImage${imports.length}`;
            imports.push(`import ${name} from ${JSON.stringify(imagePath)};`);
            return `{ uri: ${name} }`;
          },
        );
        if (imports.length === 0) {
          return null;
        }
        // Metro resolves require(image) to a native asset ID; RN Web expects
        // an image URL. This translation affects only the browser preview.
        return { code: `${imports.join('\n')}\n${transformed}`, map: null };
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      {
        find: /^(?:\.\/|\.\.\/)specs\/NativeAssist$/,
        replacement: fileURLToPath(
          new URL('./native-assist.js', import.meta.url),
        ),
      },
    ],
    extensions: [
      '.web.mjs',
      '.mjs',
      '.web.js',
      '.js',
      '.web.ts',
      '.ts',
      '.web.tsx',
      '.tsx',
      '.jsx',
      '.json',
    ],
  },
  define: {
    __DEV__: 'true',
  },
  optimizeDeps: {
    // Resolve this package's .web files through Vite rather than scanning its
    // native codegen entry points during dependency prebundling.
    exclude: ['react-native-safe-area-context'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [mobileDirectory] },
    // Wait for editors to finish a write before caching a transformed module.
    watch: {
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 10 },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../build/preview/', import.meta.url)),
    emptyOutDir: true,
  },
});
