import crypto from "node:crypto";
import { DomainError } from "./operations-service.js";

const tenant = "app.current_context_tenant_id()";

// Settlement is computed server-side from itemized, staff-entered dollar
// charges rather than trusting raw "capture/release cents" values from the
// client. capturedCents and releasedCents are DERIVED here, not accepted as
// input, so the hold is always fully allocated by construction and a
// zero-everything submission can never silently finalize a nonzero hold
// without staff having reviewed the actual charge total.
export async function settleTripChargesWorkflow(client, {
  bookingItemId, fuelChargeCents = 0, mileageChargeCents = 0, damageChargeCents = 0, otherChargeCents = 0,
}) {
  const trip = (await client.query(
    `SELECT trip_id, machine_id FROM app.trip
      WHERE tenant_id=${tenant} AND booking_item_id=$1 AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1`,
    [bookingItemId],
  )).rows[0];
  if (!trip) throw new DomainError("TRIP_NOT_RETURNED", 409);

  // The hold journal entry is looked up server-side FOR THIS booking item --
  // never accepted from the client -- so a hold that belongs to a different
  // booking or trip can never be settled against this one.
  const hold = (await client.query(
    `SELECT journal_entry_id, amount_cents FROM app.booking_item_deposit_hold WHERE tenant_id=${tenant} AND booking_item_id=$1`,
    [bookingItemId],
  )).rows[0];
  if (!hold) throw new DomainError("NO_DEPOSIT_HOLD", 409);

  const existing = (await client.query(
    `SELECT deposit_hold_settlement_id, captured_cents, released_cents, excess_receivable_cents
       FROM app.deposit_hold_settlement WHERE tenant_id=${tenant} AND trip_id=$1`,
    [trip.trip_id],
  )).rows[0];
  if (existing) {
    return {
      settled: true,
      alreadySettled: true,
      settlementId: existing.deposit_hold_settlement_id,
      capturedCents: Number(existing.captured_cents),
      releasedCents: Number(existing.released_cents),
      excessReceivableCents: Number(existing.excess_receivable_cents),
    };
  }

  const totalChargeCents = Math.max(0, Math.round(fuelChargeCents) + Math.round(mileageChargeCents) + Math.round(damageChargeCents) + Math.round(otherChargeCents));
  const holdAmountCents = Number(hold.amount_cents);
  const capturedCents = Math.min(totalChargeCents, holdAmountCents);
  const releasedCents = holdAmountCents - capturedCents;
  const excessReceivableCents = totalChargeCents - capturedCents;

  // A savepoint lets a genuinely concurrent duplicate request recover
  // gracefully within the SAME transaction: if two settlement calls race
  // past the "existing settlement" check above, app.settle_deposit_hold's
  // internal row lock serializes them, and the loser's insert hits the
  // trip_id unique constraint. Rolling back to the savepoint (rather than
  // letting the whole transaction abort) lets the loser re-read the
  // winner's now-committed row and return the SAME success shape instead of
  // an error -- settlement is retry-safe under real concurrency, not just
  // for a client that retries after its first request already completed.
  await client.query("SAVEPOINT settle_attempt");
  try {
    const settlementId = (await client.query(
      "SELECT app.settle_deposit_hold($1,$2,$3,$4,$5) id",
      [hold.journal_entry_id, trip.trip_id, capturedCents, releasedCents, excessReceivableCents],
    )).rows[0].id;

    const accounts = Object.fromEntries((await client.query(
      `SELECT account_code, ledger_account_id FROM app.ledger_account
        WHERE tenant_id=${tenant} AND account_code IN ('deposits_held','revenue','deposit_clearing')`,
    )).rows.map((row) => [row.account_code, row.ledger_account_id]));

    if (capturedCents > 0) {
      await client.query("SELECT app.record_payment_capture($1,$2,$3,$4,$5)", [
        crypto.randomUUID(), `SETTLE:CAPTURE:${hold.journal_entry_id}`, accounts.deposits_held, accounts.revenue, capturedCents,
      ]);
    }
    if (releasedCents > 0) {
      await client.query("SELECT app.record_deposit_release($1,$2,$3,$4,$5)", [
        crypto.randomUUID(), `SETTLE:RELEASE:${hold.journal_entry_id}`, accounts.deposits_held, accounts.deposit_clearing, releasedCents,
      ]);
    }
    await client.query("RELEASE SAVEPOINT settle_attempt");
    return { settled: true, alreadySettled: false, settlementId, capturedCents, releasedCents, excessReceivableCents };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT settle_attempt");
    if (error.code === "23505") {
      const winner = (await client.query(
        `SELECT deposit_hold_settlement_id, captured_cents, released_cents, excess_receivable_cents
           FROM app.deposit_hold_settlement WHERE tenant_id=${tenant} AND trip_id=$1`,
        [trip.trip_id],
      )).rows[0];
      if (winner) {
        return {
          settled: true,
          alreadySettled: true,
          settlementId: winner.deposit_hold_settlement_id,
          capturedCents: Number(winner.captured_cents),
          releasedCents: Number(winner.released_cents),
          excessReceivableCents: Number(winner.excess_receivable_cents),
        };
      }
      throw new DomainError("DEPOSIT_ALREADY_SETTLED", 409);
    }
    if (error.code === "P0003") throw new DomainError("SETTLEMENT_EXCEEDS_HOLD", 422);
    throw error;
  }
}
