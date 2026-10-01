import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Node does not provide the Workers runtime module. Keep this alias scoped
    // to Vitest so the real Wrangler bundle still imports cloudflare:workers.
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/index.security.test.ts"],
  },
});
