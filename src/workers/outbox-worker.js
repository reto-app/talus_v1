export function createOutboxWorker(pool, options, dispatcher) {
  let stopped = false;
  let running = false;
  let loopPromise;
  let wakePollingWait;
  const waitForPoll = (milliseconds) => new Promise((resolve) => {
    const timer = setTimeout(() => { wakePollingWait = undefined; resolve(); }, milliseconds);
    wakePollingWait = () => { clearTimeout(timer); wakePollingWait = undefined; resolve(); };
  });
  async function tick() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = (await client.query("SELECT * FROM app.claim_outbox_batch($1)", [options.batchSize ?? 10])).rows;
      for (const message of rows) {
        try {
          const result = await dispatcher.send(message);
          await client.query("UPDATE app.communication_outbox SET status='sent',provider_message_ref=$1,sent_at=clock_timestamp() WHERE communication_outbox_id=$2", [result.providerRef, message.communication_outbox_id]);
        } catch (error) {
          await client.query("UPDATE app.communication_outbox SET status=CASE WHEN retry_count+1 >= $1 THEN 'failed' ELSE 'queued' END,retry_count=retry_count+1,error_message=$2 WHERE communication_outbox_id=$3", [options.maxRetries ?? 3, String(error.message), message.communication_outbox_id]);
        }
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  function start() {
    if (loopPromise) return loopPromise;
    running = true;
    loopPromise = (async () => { try { while (!stopped) { const claimed = await tick(); if (!claimed && !stopped) await waitForPoll(options.pollIntervalMs ?? 100); } } finally { running = false; } })();
    return loopPromise;
  }
  function stop() { stopped = true; wakePollingWait?.(); return loopPromise ?? Promise.resolve(); }
  return { start, stop, tick, get running() { return running; }, get completion() { return loopPromise; } };
}
