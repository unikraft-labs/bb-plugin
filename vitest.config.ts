import { defineConfig } from "vitest/config";

export default defineConfig({
  // Without a host, Vite looks up "localhost" at startup, and that lookup
  // fails on a machine whose /etc/hosts has no localhost entry.
  server: { host: "127.0.0.1" },
});
