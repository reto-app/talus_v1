export function installGracefulShutdown({ app, pool, worker, exit = process.exit, signals = true }) {
  const readiness = app.talusReadiness ?? { isShuttingDown: false };
  let shutdownPromise;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    readiness.isShuttingDown = true;
    shutdownPromise = (async () => {
      const forceExit = setTimeout(() => exit(1), 10_000);
      forceExit.unref();
      try {
        await app.close();
        if (worker) {
          const stopped = worker.stop();
          await (stopped ?? worker.completion);
        }
        await pool.end();
        clearTimeout(forceExit);
      } catch (error) {
        clearTimeout(forceExit);
        throw error;
      }
    })();
    return shutdownPromise;
  };
  if (signals) {
    process.once("SIGTERM", () => { shutdown().then(() => exit(0)).catch(() => exit(1)); });
    process.once("SIGINT", () => { shutdown().then(() => exit(0)).catch(() => exit(1)); });
  }
  return { readiness, shutdown };
}
