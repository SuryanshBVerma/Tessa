import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    // Local-only test target: never expose the dev server on the network.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
