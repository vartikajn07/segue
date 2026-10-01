import { defineConfig } from "vite";
import { resolve } from "node:path";

// Phase 3 consumes the Phase 2 module directly; it is deliberately not copied here.
export default defineConfig({
  server: {
    fs: { allow: [resolve(import.meta.dirname, "..")] },
  },
});
