import { loadEnv } from "./config/env.js";
import { createLogger, setDefaultLogLevel } from "./utils/logger.js";
import { createNodeBackendRuntime } from "./bootstrap.js";

const env = loadEnv();
setDefaultLogLevel(env.LOG_LEVEL);
const logger = createLogger("main");

logger.info("ASF Junban starting...");

const runtime = createNodeBackendRuntime();
const { services } = runtime;

logger.info("Database initialized, services ready.");

try {
  await runtime.initialize();
} catch (err) {
  logger.error(
    `Plugin startup failed during app bootstrap: ${err instanceof Error ? err.message : err}`,
  );
}

let shuttingDown: Promise<void> | null = null;
async function shutdown(signal: string) {
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    logger.info(`${signal} received, shutting down...`);

    // Force exit after 5s if graceful shutdown stalls.
    const forceExitTimer = setTimeout(() => process.exit(1), 5000);
    forceExitTimer.unref();

    try {
      await runtime.dispose();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  })();

  return shuttingDown;
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// TODO: Start UI or CLI based on context

export { env, logger, runtime, services };
