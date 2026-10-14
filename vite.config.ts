import { defineConfig, Plugin } from 'vite';

function glslPlugin(): Plugin {
  return {
    name: 'vite-plugin-glsl-raw',
    transform(code, id) {
      if (id.endsWith('.glsl') || id.endsWith('.vert') || id.endsWith('.frag')) {
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null
        };
      }
    }
  };
}

export default defineConfig({
  plugins: [glslPlugin()],
  server: {
    host: true,
    port: 5173,
    open: false
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1000
  }
});
