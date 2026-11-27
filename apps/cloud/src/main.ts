#!/usr/bin/env node
// OneSeat Cloud entry point (Render web service).
import { loadConfig } from "./config.js";
import { PgStore } from "./pg-store.js";
import { createCloudApp } from "./server.js";
import { MemoryStore, type Store } from "./store.js";

async function main() {
  const cfg = loadConfig();
  let store: Store;
  if (cfg.databaseUrl) {
    store = PgStore.connect(cfg.databaseUrl);
    await store.migrate();
  } else {
    process.stderr.write("DATABASE_URL is not set: using an in-memory store (data is lost on restart)\n");
    store = new MemoryStore();
  }
  const app = createCloudApp(cfg, store);
  app.server.listen(cfg.port, () => process.stderr.write(`oneseat-cloud listening on :${cfg.port} (${cfg.publicUrl})\n`));
  // Revealed license keys are kept for 24 hours only.
  setInterval(() => void store.purgeReveals(24).catch(() => {}), 3600_000).unref();
  const stop = () => app.server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  process.stderr.write(`oneseat-cloud failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
