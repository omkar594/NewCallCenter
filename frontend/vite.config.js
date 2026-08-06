import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_API_BASE_URL selects which backend this build talks to (see src/api/client.js) - not
// set here, since it differs between local dev (http://localhost:5000) and the deployed
// Render backend (https://newcallcenter.onrender.com). Set it in a .env.local file or in
// Render's static-site environment variables.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});
