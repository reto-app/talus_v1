# Talus — Phase 1 Architecture, Part 2

**Status: formal specification proposed for approval.** Part 1 is approved and remains the baseline. This document completes the requested state machines, assignment/override contract, API contract, module dependency graph and build sequence, and concrete proposals for the six decisions in §35 of *TALUS — BUILD INSTRUCTIONS (MVP V1, DOC V2)*.

This is architecture only. It contains no application code, database DDL, migrations, HTML, setup commands, or executable tests. Names, field definitions, predicates, and dependency edges below are specifications. Approval of Part 1 does not activate the new business defaults proposed in this part.

The approved foundations remain: integer cents and basis points; exact pricing arithmetic; calendar-day pricing in the snapshotted tenant timezone; availability derived on read; tenant-scoped foreign keys and forced RLS; function-only writes; immutable agreements and evidence revisions; one unified audit architecture; and open-ended physical machine custody from checkout until recorded return.

## 1. State machine specifications — §6

### 1.1 Common transition contract

Every transition is a named database operation, not a generic public “set status” endpoint. It identifies the resource, expected resource version, intent, relevant evidence/revision identifiers, and idempotency key. Tenant and actor are supplied by authenticated session context. The transaction locks the relevant roots, verifies the current state and permitted edge in the versioned LifecycleTransitionDefinition, evaluates the guards below, applies all associated domain effects, and appends the specified audit event before committing.

Every table row inherits **G0**: current tenant authorization; permitted caller class and role; active session/credential; expected version; valid same-tenant references; a listed transition edge; required locks; and transactional audit/idempotency. An edge's explicit guards supplement G0. Denial leaves the state unchanged. The audit action is an immutable action identifier; its context includes from/to states, definition version, actor, reason, affected revisions, and operation ID.

“Staff” includes manager and owner. “Manager” includes owner. A worker is permitted only for its registered task type and scoped job; it never acquires a staff role by implication. Customer sessions may create and abandon their own pre-confirmation checkout, but V1 confirmed-booking changes and cancellations are staff workflows.

| Guard | Exact condition |
| --- | --- |
| G1 — Acceptable agreement | At least one selected nonterminal item, not merely historical cancelled rows; current immutable booking/item terms and price revision agree; category/location and customer contacts are valid; booking rules pass or a separately authorized, scoped override is recorded. |
| G2 — Capacity commitment | All affected category/location scopes are locked; authoritative whole-interval availability is re-evaluated; adequate capacity or an acknowledged manager overbooking decision exists; each consuming item has exactly one appropriate commitment. |
| G3 — Confirmation funding | The amount required at confirmation by the snapshotted payment schedule is supported by successful ledger-posted collections, or is explicitly zero. Pending attempts, authorizations, redirect pages, and queued messages do not satisfy collection. The accepted quote/terms match the amount. |
| G4 — Valid assignment | Exactly one blocking rental occupancy belongs to the item and accepted rental segment; machine is in the correct category/location, in_service, and free of conflicting rental/maintenance occupancy; no unresolved eligibility conflict. |
| G5 — Departure readiness | G4; required waiver signatures cover the booked signing arrangement and exact document version/hash; required pre-inspection for this checkout occurrence is submitted; required readings are valid automatic/manual observations or explicitly optional; customer is not currently do-not-rent; rental balance due before departure and configured security-deposit condition are satisfied; staff explicitly acknowledges that this machine/checkout preparation is physically ready. |
| G6 — Begin physical custody | G5 rechecked under lock; the current machine has no other open Trip; any future planned allocations conflicting with open-ended custody have been explicitly resolved; the start boundary and a new checkout occurrence are ready. Neither a timer nor telemetry can satisfy physical departure. |
| G7 — Record physical return | An actual staff-observed return/handover; the item has exactly one open Trip and matching live occupancy. End is later than start. Return is not blocked by unpaid money, missing post-inspection, or a telemetry gap. |
| G8 — Close an item | Every actual departure has a sealed returned Trip; unused preparations are explicitly abandoned; required post-inspections are submitted; equipment quantities are returned or explicitly accounted for; incidents have a documented disposition; that item's financial allocations and deposit disposition are reconciled with no pending/uncertain financial action. No live occupancy, consuming commitment or unresolved replacement request remains. |
| G9 — Classify cancellation | No checkout has occurred for the affected item(s); authorized cancellation terms/revision and financial adjustments are recorded; holds/assignments are released. Refund requests may remain pending, visibly separate from cancellation. |
| G10 — Classify no-show | No checkout ever occurred for the affected item; parent was confirmed; server time is at least scheduled pickup plus configured grace; manager explicitly records non-arrival/reason; occupancy/commitment are released and agreed financial disposition is recorded. Default proposed grace is 60 minutes; no automatic no-show transition. |
| G11 — Close a booking | Parent is active; at least one constituent item; every constituent item is closed, cancelled, or no_show; at least one actual rental occurred; no open Trip/live rental occupancy or consuming commitment remains; all booking-level and item-level financial allocations are reconciled, including pending refunds/deposit actions. |

G8/G11 do not require all offline telemetry to have arrived. Operational closure and evidence settlement are distinct: a closed rental can have a settling or gap-marked Trip summary, with later append-only evidence revisions.

### 1.2 Overall Booking transition table

Creation produces a `draft` Booking and `booking.created`. Creation is not a transition from another lifecycle state. The following nine directed edges are the complete V1 Booking transition set; every unlisted edge is illegal.

| From State | To State | Trigger / Actor | Pre-conditions / Invariant Guards | Emitted Audit Action |
| --- | --- | --- | --- | --- |
| draft | pending_payment | Begin checkout; scoped customer or staff | G1/G2; accepted quote and policy versions sealed for this checkout attempt; required expiring category holds acquired; payment operation/schedule created once. All items remain pre-departure. | booking.checkout_started |
| draft | cancelled | Abandon draft; owning customer, staff, or scoped draft-expiry worker | No successful or uncertain payment movement; no checkout/Trip. Any draft items become cancelled and temporary claims are released. An empty draft may be cancelled. | booking.draft_cancelled |
| pending_payment | draft | Return to editing/requote; owning customer or staff; expiry worker after payment outcome is definitive | No successful unreconciled collection and no live/uncertain payment attempt; holds released. Prior quote/payment attempt history is retained. An uncertain payment cannot be made to disappear by resetting the booking. | booking.checkout_reset |
| pending_payment | confirmed | Verified payment completion worker; staff with verified manual-payment evidence; zero-due confirmation workflow | G1/G2/G3. Convert valid holds to committed claims. An expired hold requires fresh capacity acceptance; payment receipt alone cannot override capacity. Confirmation and notification enqueue commit together. | booking.confirmed |
| pending_payment | cancelled | Cancel checkout; owning customer or staff | No checkout. Cancel intent and item cancellations recorded; claims released. Any in-flight/uncertain payment remains under reconciliation and, if it later succeeds, the resulting funds are refunded through the ledger rather than confirming the cancelled booking. | booking.checkout_cancelled |
| confirmed | active | First item physically checks out; staff, as part of that checkout transaction | At least one item performs ready → checked_out with G6. Open its Trip and live custody in the same transaction. Merely reaching pickup time or assigning a machine does not activate the booking. | booking.activated |
| confirmed | cancelled | Cancel all unstarted rental items; manager | G9 for every remaining item; all constituent items are cancelled; no Trip ever occurred. Pending refund status stays visible independently. | booking.cancelled |
| confirmed | no_show | Final non-arrival classification; manager or the same classification workflow | All items are cancelled/no_show, at least one is no_show, and none ever checked out. G10 applies to each newly classified no-show. Financial outcome is recorded without treating non-arrival as completion for commission. | booking.no_show_recorded |
| active | closed | Close booking; staff or scoped completion worker | G11, enforced by the mechanism in §1.4. The operation captures the closure financial/evidence references and emits the event once. | booking.closed |

A zero-price checkout still follows draft → pending_payment → confirmed, possibly within one transaction, with both events and all capacity guards. A failed/uncertain collection leaves the booking pending_payment with an explicit payment outcome; it does not invent another Booking lifecycle state. The same applies to an expired payment hold while reconciliation remains unresolved.

There is no active → cancelled or active → no_show transition: once any unit was physically rented, that booking has a rental history. Staff may cancel/no-show its remaining unstarted items, while the parent stays active until normal closure. Closed, cancelled, and no_show are terminal Booking states. Subsequent refunds or evidence annotations append history without reopening them. A late customer whose entire booking is terminal needs a new linked booking; history is not erased by “undoing” the terminal state.

### 1.3 Independent Booking-Item transition table

Creation produces `reserved` and `booking_item.created`. In a draft, that state has no capacity claim; pending payment adds an expiring hold; confirmation establishes a committed claim. Reservation strength is a separate fact from operational state. One BookingItem always represents one unit.

The following seventeen directed edges are the complete V1 item transition set. Same-state actions, such as swapping two pre-pickup assignments while the item remains assigned, are audited commands rather than extra transition edges.

| From State | To State | Trigger / Actor | Pre-conditions / Invariant Guards | Emitted Audit Action |
| --- | --- | --- | --- | --- |
| reserved | assigned | Assignment worker; manager manual assignment | Parent confirmed/active; committed claim; G4 established by inserting occupancy; no open Trip; immutable assignment attempt/result recorded. | booking_item.assigned |
| assigned | reserved | Release invalid/unneeded initial assignment; assignment worker or manager | No checkout occurrence has ever happened; release planned occupancy with reason. Retain category commitment when reservation is still accepted; invalidate prepared machine-bound readiness evidence. A replacement returns to returned via its specific edge instead. | booking_item.assignment_released |
| assigned | ready | Mark ready; staff | G5; capture a readiness receipt bound to current terms, assignment, checkout preparation and staff acknowledgement. Optional inspections are explicitly optional under the booked policy, not missing proofs treated as success. | booking_item.ready |
| ready | assigned | Invalidate readiness or replace assigned machine; staff for evidence invalidation, manager for override | No checkout/open Trip; valid assignment remains or is atomically replaced. Retain old inspections/signatures as history, invalidate only their applicability to the new preparation. | booking_item.readiness_invalidated |
| ready | reserved | Release initial assignment; assignment worker or manager | No checkout occurrence has ever happened; planned occupancy released; readiness invalidated; accepted category commitment retained and unresolved assignment becomes visible. A staged replacement uses ready → returned. | booking_item.assignment_released |
| ready | checked_out | Physical departure; staff | G6. Seal start boundary, create the Trip, convert planned allocation to live open-ended custody, and activate parent if this is its first departure. | booking_item.checked_out |
| checked_out | returned | Physical return/handover; staff | G7. Seal Trip end and end boundary; end live custody; cease the item's current consuming claim. Record missing readings honestly. Payment, inspection, or incident work can follow. | booking_item.returned |
| returned | closed | Wrap up item; staff | G8. No automatic completion merely because a return was recorded. Attempt parent closure only after the item's transactionally consistent terminal state is established. | booking_item.closed |
| returned | assigned | Replacement departure within the same still-active rental; manager | Parent active; explicit replacement request; prior Trip sealed and required post-inspection submitted; item not closed; same booked category/location and remaining accepted rental interval or explicit extension; new checkout ordinal/segment and G2/G4. Prior Trip is never rebound to replacement hardware. | booking_item.replacement_assigned |
| assigned | returned | Release or abandon an assigned but unstarted replacement; assignment worker for invalidation/reassignment, manager for abandonment | Prior returned Trip and explicit continuation request; no new open Trip/departure. Release replacement planned occupancy and preparation; retain the real prior return. The disposition either keeps the request/commitment open for reassignment or closes both for wrap-up. | booking_item.replacement_preparation_ended |
| ready | returned | Release or abandon a prepared but unstarted replacement; staff for evidence invalidation, manager for abandonment | Same continuation-only conditions; invalidate replacement readiness and release occupancy/preparation. No fictional return/Trip is created for the replacement machine. Reassignment or abandonment disposition is explicit. | booking_item.replacement_preparation_ended |
| reserved | cancelled | Remove unstarted unit; owning customer only before confirmation, otherwise manager; scoped parent-cancellation worker | G9; draft may have no claim. Do not delete the item from confirmed history. | booking_item.cancelled |
| assigned | cancelled | Cancel unstarted unit; manager or scoped parent-cancellation worker | G9; release its planned machine occupancy and commitment atomically. | booking_item.cancelled |
| ready | cancelled | Cancel unstarted unit; manager or scoped parent-cancellation worker | G9; invalidate readiness, release occupancy/commitment, retain inspection history. | booking_item.cancelled |
| reserved | no_show | Record non-arrival; manager | G10; committed item on confirmed/active parent; no earlier checkout occurrence. | booking_item.no_show_recorded |
| assigned | no_show | Record non-arrival; manager | G10; release planned occupancy and commitment in the same transaction. | booking_item.no_show_recorded |
| ready | no_show | Record non-arrival; manager | G10; invalidate readiness and release planned occupancy/commitment. | booking_item.no_show_recorded |

Replacement is the narrow exception allowing a returned item to depart again before item closure, as required by the approved multiple-checkout Trip model. It proceeds through assigned → ready → checked_out again with fresh machine-bound preparation. A real return is recorded even if the replacement attempt subsequently fails; the item remains returned with replacement work pending. Never roll a genuine return back merely to make a failed swap look seamless. Pre-pickup swaps have the different atomic contract in §2.3.

An explicit ReplacementRequest may be registered by a manager before the first machine returns or while the item is returned. It binds the current terms, old checkout, reason and a new preparation identity. On return, an accepted continuation preserves/reissues the remaining category commitment in the same transaction instead of freeing that future demand. Its segment begins no earlier than the actual return and ends at the agreed return/extension boundary; that segment reference narrows the commitment without rewriting the original full-rental terms. While pending, the request blocks G8 and appears in the replacement queue. A failed assignment attempt leaves the item returned; no transition to reserved occurs. If a subsequent committed replacement assignment is lost, assigned/ready returns to returned and the request can remain the authority for reassignment. Abandoning while already returned is a same-state audited action; abandoning from a staged departure uses the two guarded edges above. A different category/location requires a separately booked item, not rewriting the prior Trip.

No direct assigned → checked_out, checked_out → closed, returned → cancelled, or terminal-state reopening exists. Inspection-optional tenants still pass through ready; the two steps may share a transaction. Extensions do not change checked_out to another state. Machine operational state never changes as a consequence of any Booking/Item transition.

Physical checkout/return effective times default to the database-recorded action time. Separately recorded observation times retain their provenance. Backdating a sealed Trip or silently moving already attributed telemetry is not an ordinary status-edit capability; discrepancies are recorded as audited evidence annotations.

### 1.4 Exact database guarantee for parent closure

**Invariant:** every committed database state in which a Booking is closed has at least one constituent BookingItem and has zero constituent items outside {closed, cancelled, no_show}. A percentage counter, interface check, cached summary, or asynchronous job is not the enforcement mechanism.

The database uses all of the following together:

1. **Parent serialization row.** The Booking row is the lock for its item set. Before an item is inserted, deleted, changes state, or changes membership-relevant facts, a database BEFORE trigger locks its parent and increments the parent's `item_set_revision`. Reparenting an existing item is prohibited; a move is a new, audited item. This revision is a concurrency token, not a stored terminal count.
2. **Closed-parent mutation guard.** The same trigger rejects adding an item or changing an existing item's operational/membership state under a terminal Booking. Historical inspection, ledger, or late telemetry annotations are separate entities and remain governed by their own rules. V1 item removal uses cancellation rather than hard deletion, including draft items; attempted deletion is denied and covered by the defensive item-set trigger.
3. **Closure validation.** Close booking locks that Booking row, verifies expected versions, and reads its complete current item set under the original actor's RLS context. It requires a positive item count and the absence of any nonterminal item, plus G11. A staff/worker authorized to close the booking must be authorized to see every item in that booking; a partial-access customer/device cannot invoke closure.
4. **Deferred constraint trigger.** A database AFTER constraint trigger, deferred until transaction commit, repeats the parent invariant for every affected Booking after Booking state changes and item inserts/updates/deletes. It queries the authoritative rows, not a counter. It also validates cancelled/no_show branch consistency against the terminal classification rules. This catches faulty internal workflow ordering or a domain function that omitted the precheck. Immediate transition guards still validate each edge and its operation context.
5. **Permission boundary.** Public request roles cannot mutate either table, disable triggers, truncate, change constraints, or invoke the private transition primitive. RLS and same-tenant FKs apply alongside this constraint, not in place of it.

PostgreSQL supports deferred constraint triggers for transaction-end checks and row locks held through the transaction. [Constraint triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html), [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html). The parent revision is deliberately updated on item-set mutations: with an older repeatable-read snapshot, a conflicting parent update must fail/retry rather than allowing an old snapshot to certify a changed child set. Normal workflow transactions use READ COMMITTED with the specified locks; SERIALIZABLE may add retries, but is not a substitute for the constraint. [PostgreSQL isolation](https://www.postgresql.org/docs/18/sql-set-transaction.html).

**Race outcome:** if closure locks first, a concurrent item insert waits, then is rejected because the parent is closed. If the insert/state mutation locks first, closure waits and then sees the new nonterminal item, or receives a serialization failure under stronger isolation. If the last two items close concurrently, they serialize through the parent; exactly one operation can observe and perform the final active → closed edge. All other attempts return the already-applied result or a state/version conflict, never a second closure audit or commission trigger.

The full mutation lock order is: affected Booking roots by stable identifier; CategoryLocation rows; BookingItems; Machine rows/occupancies and device bindings; financial/promo roots, each sorted within its class. Multi-booking swaps and custody conflict resolution declare and lock every affected Booking first. Fleet/maintenance operations discover affected bookings, acquire the same order, and revalidate the discovered set; a changed set causes a bounded whole-transaction retry, not acquisition of an earlier-order lock halfway through. No provider call or human confirmation occurs while database locks are held.

### 1.5 Divergent items and modification permissions

| Item states in one booking | Parent state and operational meaning |
| --- | --- |
| reserved, assigned, ready; none ever departed | confirmed; readiness and unresolved assignments are visible per item. |
| returned, checked_out, checked_out | active; one unit physically returned, two still out. Only the latter two retain live custody; the first still needs G8 before item close. |
| closed, returned, cancelled | active; one item remains nonterminal even if every machine is physically back. |
| closed, closed, no_show | closed only after G11; commission eligibility excludes the no-show portion. |
| cancelled, no_show, no_show; no actual rentals | no_show after financial dispositions are recorded; no earned rental commission. |
| cancelled, cancelled, cancelled; no actual rentals | cancelled; outstanding refunds remain a separate financial attention state. |

Parent state is an explicitly transitioned lifecycle fact. Item counts, due returns, overdue indicators and completion progress are derived views. Returning one unit never closes the booking or releases another unit's occupancy.

Normal modifications retain the current lifecycle state and emit `booking.modified` plus affected item/price/ledger actions. In draft, the customer/staff may revise its selection. In pending_payment, editing requires definitive resolution/cancellation of the old payment attempt and a fresh quote/hold. In confirmed or active, staff may amend unstarted items and add/remove units through normal capacity and pricing rules; reductions cancel historical items. Ready items lose readiness when relevant terms, assignment or booking-level financial readiness change; a do-not-rent change likewise forces readiness re-evaluation. Checked_out items may be extended by authorized staff, preserving original pricing and custody; they cannot have category/location/start time silently rewritten. Returned/closed items retain their rental terms; financial corrections use separate ledger/revision operations. Parent-terminal bookings accept historical/financial annotations, not new rental items.

An active extension creates an explicit incremental receivable and collection requirement; it is not evidence of payment. It cannot forgive an existing debt or close a booking with an unsettled balance. Any manager override of a financial amount is a separate audited price adjustment, not an occupancy or lifecycle bypass.

## 2. Automatic assignment and operator override — §§3–4

### 2.1 Scheduling, inputs, and eligibility

The due instant is scheduled pickup minus the assignment lead minutes captured in the booking's policy revision. Proposed initial lead time: **1,440 minutes (24 hours)**, configurable per tenant. Policy changes affect new agreements; an explicit audited adoption updates an existing booking's policy and reschedules its job. A booking confirmed inside its lead window is immediately due. A periodic sweep every 60 seconds recovers missed jobs; it supplements, rather than replaces, transactional job creation.

The assignment request is scoped to tenant, category, location, due item identifiers, expected item/terms versions, and an assignment-cycle identifier. The database derives all dates, categories, current policies, and actor rights from those identifiers. Request-supplied availability, machine state, or capacity counts are never authoritative.

Only confirmed/active-parent items in reserved with an accepted consuming commitment are automatically assigned. A previously valid assignment is stable until an explicit release, invalidation, or override; a routine sweep does not reshuffle the fleet. A returned item awaiting a replacement uses its explicit manager-authorized replacement request, not the ordinary pre-pickup sweep.

Candidate machines must satisfy every criterion:

- Same tenant, booked category and pickup location, with current state in_service.
- Eligible for the entire planned rental segment, including explicit blocks; no overlap with any blocking rental/maintenance occupancy.
- No current open-ended live custody. Expected return is not an actual release.
- Any required transfer/reclassification has already occurred through its authorized operation; the engine cannot presume a future transfer.
- No explicit unresolved operational restriction that prevents rental. Missing optional telemetry does not become a false maintenance failure or a zero meter reading.

A maintenance task marked due is visible operational information; it blocks assignment only when an explicit block/restriction exists under the recorded policy. The engine does not silently set a machine's operational state based on a due calculation.

### 2.2 Deterministic assignment algorithm

1. **Discover and claim work.** Find due category/location scopes and claim a scoped job lease. Proposed lease: 30 seconds with a monotonically increasing fencing token; a stale worker cannot commit after its lease is replaced. Work batches are bounded, initially 50 due items per scope.
2. **Acquire and validate locks.** Use the lock order in §1.4. Re-read parent/item states, terms, category/location membership, machine facts, existing occupancy and job lease. A cancelled, modified or already-assigned item produces a recorded no-op/stale-work outcome, not a second assignment.
3. **Construct whole-interval candidates.** For each due item, calculate the machines capable of serving its full segment. Use the same fixed scheduling/feasibility function as availability and booking acceptance. Include relevant future committed items as virtual demands to avoid stranding them where a different choice would preserve capacity; do not attach machines to those future items early.
4. **Choose a deterministic feasible plan.** First maximize the number of due items assigned. Among equal plans, prefer filling items in order of scheduled pickup, confirmation time, Booking ID, and item ordinal. Next preserve the largest feasible set of other overlapping committed demands. Finally choose the lexicographically smallest machine allocation using normalized fleet-unit number and Machine ID. These criteria are versioned and audited. No random choice, unrecorded preference, or invented engine-hour value participates.
5. **Commit real assignments only for due items.** Insert their planned MachineOccupancy rows and apply reserved → assigned, with AssignmentAttempt and audit results. Each occupancy is subject to the tenant/machine/range exclusion constraint and the one-blocking-assignment-per-item constraint. The virtual feasibility plan is discarded.
6. **Handle exclusion/serialization conflicts.** The exclusion constraint remains authoritative. A conflict aborts the affected atomic attempt; re-read and replan rather than returning a previously tested candidate. Proposed bound: three complete transactional attempts with jittered short backoff. A worker must not treat skipped/locked candidate rows as proven unavailable inventory.
7. **Record unresolved outcomes honestly.** If a complete calculation finds no feasible machine, record its structured reason and open/update the assignment-attention case. If calculation timed out or lock contention prevented a reliable result, record a retryable scheduling failure, not a capacity shortage. Proposed computation budget is two seconds per transactional planning attempt; tuning this budget never authorizes an approximate positive assignment or available count.

Jobs retry unresolved needs after a meaningful supply change and at least every 60 seconds while due, with duplicate work coalesced by item assignment cycle. A failed attempt never inserts a fictitious machine assignment. Accepted overbooking does not prevent the engine from assigning the feasible subset; it does not require an impossible all-or-nothing assignment of the whole overbooked category.

### 2.3 Exact pre-pickup override contract

**Operation:** `OverrideAssignment`, API version v1. Caller must currently be manager/owner in the tenant. It applies only to reserved, assigned, or ready items on confirmed/active bookings that have never checked out. It can run before the automatic lead time.

| Request field | Requirement |
| --- | --- |
| booking_id, item_id | Same authorized booking; item belongs to that booking. |
| expected_booking_version, expected_item_version, terms_revision_id | Mandatory concurrency and agreement references. |
| expected_occupancy_id | Mandatory when replacing an assignment; explicitly absent for a currently unassigned item. |
| replacement_machine_id | Mandatory explicit machine choice. Category/location/eligibility are re-derived by the database. |
| reason_code, reason_text | Fixed reason class such as breakdown, maintenance, scheduling, operator correction; nonempty explanation. |
| idempotency_key | Mandatory; follows §3.4. |

The response contains operation ID, new resource versions, resulting item state, old/new occupancy identifiers, selected machine, invalidated readiness/preparation identifiers, audit references, and current required next actions. It does not claim the item is ready merely because a replacement was found.

**Workflow:** staff opens the same API-provided eligible-machine view; a manager chooses the replacement and submits the reviewed versions/reason. The database locks affected roots and machines, confirms the expected old assignment, evaluates all candidate criteria, releases the old planned occupancy and creates the new one in one transaction. A currently assigned item remains assigned and emits `assignment.overridden`; a ready item also performs ready → assigned and emits `booking_item.readiness_invalidated`; a reserved item performs reserved → assigned. Every outcome returns a new version.

For failure, both the old assignment and readiness remain exactly as they were before the attempted operation. A stale assignment produces `VERSION_CONFLICT`/`ASSIGNMENT_CHANGED`; an ineligible replacement produces `MACHINE_INELIGIBLE`; an overlap produces `MACHINE_OCCUPANCY_CONFLICT`. Manager status authorizes the choice, not bypass of the exclusion constraint.

**Exchanging two existing assignments:** use a separate atomic `SwapAssignments` operation with both Booking/item/terms versions, both expected occupancies and a reason. Both items must meet the pre-pickup conditions, and each machine must be eligible for the other's entire segment. Lock both bookings and machines in stable order; release both old planned rows before inserting both replacement rows within the transaction. No intermediate state commits, and failure restores both. Ready items both lose readiness. Replacing with the already assigned machine is an idempotent no-change result, not a fabricated override event.

Preserve all old inspections, machine/device bindings, and assignment records. Machine-bound pre-inspection preparation must be performed/validated for the replacement. A waiver remains applicable only if its existing exact agreement and party coverage still meet the booked requirements; the machine swap cannot silently amend waiver text, customer terms, dates, or price. A requested category/location/date change must first use the booking-modification contract and pricing/capacity checks.

### 2.4 Unresolved assignment view and staff alert contract

The queue is a **derived, tenant-scoped view**, not stored availability. Durable AssignmentAttempt and attention-event records explain actions and notifications; the currently unresolved condition is always recomputed.

The logical query is:

1. Select this tenant's items whose parent is confirmed/active and whose category commitment is committed and consuming.
2. Select items whose assignment-due instant has passed, plus any item whose formerly valid assignment has become invalid. A normal item outside its lead window is `scheduled_for_assignment`, not an unresolved incident.
3. Require that the item is unstarted and either lacks a blocking rental occupancy or has an occupancy that fails current eligibility. A manager-requested replacement on a returned item is included as a distinct replacement need. Exclude cancelled/no_show/closed items and ordinary returned items.
4. Join the current terms, latest meaningful assignment attempt, current eligibility explanation, and any originating overbooking audit references. Compute fresh category capacity context and candidate counts. A past overbooking decision is provenance, not proof that every current failure was caused by it.
5. Classify and sort. Oldest pickup first, then severity, then stable item ID; expose keyset pagination. A checked_out item missing valid live occupancy is a separate critical integrity alert, never silently treated as an ordinary item to reassign.

| Queue field | Type / meaning |
| --- | --- |
| item_id, booking_id, assignment_cycle_id | Stable case identity within the tenant. A new cycle begins after resolution followed by a new need or an assignment-relevant terms change. |
| booking_reference, item_ordinal, item_state, booking_state | Staff-readable context, with no participant profiling. |
| category_id/name, location_id/name, terms_revision_id | Booked context and current accepted revision. |
| pickup_at, return_at, assignment_due_at, assessed_at | UTC instants plus display timezone; assessed_at is the freshness boundary. |
| need_kind | initial_assignment, invalid_assignment, or replacement_requested. |
| reason_code | CAPACITY_SHORTAGE, NO_ELIGIBLE_MACHINE, FRAGMENTED_SCHEDULE, LIVE_CUSTODY, MAINTENANCE_BLOCK, INVALIDATED_ASSIGNMENT, or RETRYABLE_PLANNING_FAILURE. Multiple contributing reasons may be included. |
| eligible_candidate_count, normal_bookable_count, commitment_shortfall | Nonnegative candidate/bookable integers and explicit shortage, calculated at assessed_at. Counts are absent with an unavailable reason if calculation failed; never zero by assumption. |
| last_attempt_at, last_attempt_id, retry_at, retryable | Attempt history and scheduling facts, not evidence that a future retry will succeed. |
| overbooking_audit_ids, was_intentionally_overbooked | Optional links to actual acknowledged overbooking affecting this item/component. |
| severity, staff_action, permitted_actions | warning once due, urgent within 120 minutes of pickup, critical at/after pickup; actions are a presentation of current rights, not authorization. |
| expected_booking_version, expected_item_version, case_version | Required for a subsequent resolving command; stale versions cause a conflict. |

Proposed in-app alert payload: alert ID; event type `assignment.attention_required`; tenant-scoped case identity; severity; concise title; reason and assessed-at time; pickup/category/location; affected item count when grouped; safe link to the booking/assignment view; permitted action names; correlation and audit IDs; and deduplication key. Example wording: “UTV assignment unresolved for booking T-1042; pickup today at 09:00. Four committed units, three eligible machines at the last assessment.” It must not say that a particular customer has a machine when none is assigned.

Create one immutable attention event per assignment cycle and meaningful severity/reason change, with uniqueness on the cycle/event discriminator. Resolution emits `assignment.attention_resolved`; the queue row disappears only when the authoritative unresolved predicate becomes false. A delivery/acknowledgement record may mark an alert seen, but acknowledgement cannot resolve the underlying assignment. Counts preserved in an alert are historical context and never reused as current inventory. Routine 60-second sweeps do not create duplicate staff alerts or customer messages.

## 3. API and interface contract — §§16, 28, 30A, 31

### 3.1 Concrete identity-to-database pattern

All interfaces reach the public Talus v1 API. Fastify is the public authentication/contract boundary. A private PostgREST component verifies Talus-issued identity assertions and runs named database functions. It exposes no public table endpoints and is not a second client API. The public API process has no generic PostgreSQL login or elevated database credential.

| Caller class | Authentication and authoritative tenant resolution | Database authorization scope |
| --- | --- | --- |
| Staff | Verify managed OIDC signature, issuer, audience, expiry and session. Resolve Principal and active StaffMembership. A requested tenant selection is accepted only after verifying membership. | Original staff Principal and tenant, with owner/manager/staff role read from current database membership. A stale role claim cannot preserve revoked manager powers. |
| Scoped customer | Exchange a registered embed/standalone installation context for an AccessSession; private booking/waiver access additionally requires a SessionBookingGrant or equivalent exact scope. Email matching and hostname matching are not grants. | Published tenant catalog/scheduling facts and only the session's permitted booking/waiver resources. The user cannot supply a different tenant to broaden that scope. |
| Device | Authenticate its registered device credential; resolve Device and tenant from that credential. Validate expiry/revocation, real/simulator class and ingest capability. | Ingest for that device only, with machine attribution checked against the installation valid at accepted event time. No booking edits, customer reads, fleet commands or generic staff API. |
| Internal worker | Authenticate a workload identity; obtain an assertion bound to the registered tenant job, task kind, resource scope and current fencing token. | Only functions and rows needed for that job. Initiating staff/customer is retained for audit, not impersonated as the worker. A worker payload cannot mint a tenant grant. |

A trusted token broker mints a short-lived assertion only after these checks. Proposed lifetime: 60 seconds for request assertions, renewed for each request; up to five minutes for a scoped worker assertion, with the job lease checked again on every operation. The private assertion has explicit issuer, audience, tenant ID, Principal ID, caller class, session/credential/job reference, allowlisted database request-role name, issued/expiry times and correlation ID. It never names a table owner, command-owner or bypass role. Use asymmetric signing with the private key isolated in managed key custody, public-key rotation by key ID, and no signing interface that accepts caller-supplied claims. The database still resolves current membership/scope; possession of a recently issued role label alone is insufficient.

PostgREST verifies the assertion signature and applies the corresponding request role and claims to the transaction. Its authenticator has no inherited table-write powers and may assume only the four request-role classes. A database pre-request verifier requires every mandatory claim, including a nonempty exact audience and issuer, then validates the database-backed session/membership/device/job scope before the domain function runs. This explicit audience-presence check matters because PostgREST documents permissive treatment of some missing audience claims. [PostgREST authentication and pre-request checks](https://postgrest.org/en/stable/references/auth.html).

RLS obtains identity from that verified transaction context, not from arbitrary HTTP headers or request arguments. The database helper treats missing/empty context as denial. Transaction-local role/claims end with commit or rollback; the next request on a pooled connection must initialize and verify its own context. Neither an RPC nor any request-role grant permits callers to rewrite claims, assume another role or execute arbitrary SQL. [PostgREST transaction context](https://postgrest.org/en/stable/references/transactions.html).

Read functions and views use invoker security. Write functions use non-login command-owner roles with minimal table rights, forced RLS, no ownership or bypass, and policies evaluating the original verified Principal rather than effective function user. The same database authorization checks apply to owner pages, reports, worker operations and all sensitive commands. Current role checks occur again at the database operation boundary.

The identity broker, private API component and database credentials are isolated from interfaces. The scheduler may read only explicitly authorized tenant/job routing metadata to dispatch work; that limited internal read policy is not a general cross-tenant data role or an RLS bypass. Every resulting job execution has one tenant scope. The only elevated infrastructure exceptions remain the enumerated Part 1 maintenance/bootstrap/backup/retention paths, with separate credentials and audit, unreachable through client requests.

Provider callbacks are the inbound adapter-specific authentication exception, not an isolation exception: validate the signed raw provider event and resolve its registered tenant account, then process under a scoped worker/service Principal. Duplicate and out-of-order callback delivery must be accepted safely. [Stripe webhook verification and ordering](https://docs.stripe.com/webhooks).

### 3.2 Standard response and error envelopes

All ordinary v1 responses use one documented JSON object shape; field definitions below are descriptive specifications, not implementation schemas.

| Field | Contract |
| --- | --- |
| api_version | Required supported contract version. Breaking changes require a new major API version. |
| request_id | Required server-controlled correlation ID for this HTTP attempt. |
| operation_id | Present for an admitted mutation; the same ID is retained on retries. |
| data | Result object or list on success; null on failure. Mutation data is the immutable operation receipt and resource versions as of commit, not a claim that the resource has never changed since. |
| error | Null on success; otherwise the error object described below. |
| meta | Server time, replay indicator, original operation completion time where applicable, returned resource versions, and optional warning/attention metadata. |
| page | Lists only: limit, next_cursor, has_more and optional consistency/as-of marker. Exact total counts are optional and always scoped by the same authorization. |

An error contains category, stable code, safe message, retryable flag, recommended next action, optional field-path details, optional current authorized resource versions, and optional rule-review challenge. It never exposes SQL text, another tenant's identifiers, credentials or raw constraint details.

| HTTP status | Category / example codes | Required behavior |
| --- | --- | --- |
| 200 / 201 | Success / resource created | Committed result; required audits and domain effects exist. |
| 202 | Success, operation pending | Durable operation accepted but external work is incomplete. Include operation-status link; do not claim payment collected or message delivered. |
| 400 | validation / MALFORMED_REQUEST | Body/parameter shape invalid; no domain execution. |
| 401 | authentication / AUTHENTICATION_REQUIRED, SESSION_EXPIRED | Obtain a valid credential; no data disclosure. |
| 403 | permission / ACTION_FORBIDDEN, JOB_SCOPE_FORBIDDEN | Caller is authenticated but may not perform this action. Retry with the same unchanged authority will not help. |
| 404 | not_found / RESOURCE_NOT_FOUND | Also used to conceal inaccessible tenant/customer resources; existence is not disclosed. |
| 409 | rule / CAPACITY_EXCEEDED, MACHINE_OCCUPANCY_CONFLICT, ILLEGAL_TRANSITION, CLOSE_BLOCKED, READINESS_REQUIRED | Domain rule prevented mutation. Include only authorized context and the required resolving action. |
| 409 | conflict / IDEMPOTENCY_KEY_REUSED, OPERATION_IN_PROGRESS | Same key with changed input is a permanent conflict; identical concurrent in-progress request gets a status link and retry guidance. |
| 412 | concurrency / VERSION_CONFLICT, ASSIGNMENT_CHANGED | Re-read the resource and review a new intent. Do not silently overwrite another operation. |
| 422 | validation / INVALID_CENTS, INVALID_DATE_RANGE, INVALID_POLICY | Syntactically valid but invalid field values, units, policy structure or same-resource relationships. |
| 429 | rate_limit / DEVICE_RATE_LIMIT, TENANT_RATE_LIMIT | Include retry-after duration. Limit the offending scope without consuming another tenant's allocation. |
| 503 | system / RETRYABLE_TRANSACTION_FAILURE, CALCULATION_UNAVAILABLE, PROVIDER_UNAVAILABLE | No fabricated count or result. A mutation retry must use the same key or inspect the existing operation. |
| 500 | system / INTERNAL_ERROR | Safe correlation information only. An uncertain mutation response is not permission to create a new payment/operation. |

A capacity warning is a rule response, not a system failure and not a successful booking. The review challenge binds tenant, actor/action eligibility, item/terms versions, requested changes, observed shortage, and expiry. Proposed validity: five minutes. Acceptance is a new reviewed mutation with the challenge and reason; the database still rechecks role and current shortage under lock. No challenge or override ever waives machine occupancy.

Pagination defaults to 50 results, maximum 200. Cursors are opaque and bound to tenant, authorization scope, filters and sort order; a cursor cannot be transplanted to another tenant. Lists specify stable unique tie-breakers and an as-of boundary where needed. Date filters are explicit about UTC instants versus tenant-local rental dates. A live queue may change between pages; the contract labels that fact instead of promising a snapshot it does not hold.

All money is serialized as base-10 integer-cent strings, with explicit currency. Basis-point fields are bounded integer values. Rental dates use calendar-date strings plus the snapshotted IANA timezone; instants use UTC timestamps. Telemetry values include unit, source, method/version, observed time and supported/availability state. Null never implies zero, clean, paid or sent.

### 3.3 Public contract families and calculation identity

| Contract family | Shared authority / result |
| --- | --- |
| Catalog and booking configuration | Published tenant offerings, policies and add-ons through the same v1 read functions. |
| Availability | One read calculation returning interval, offering, as-of time, available quantity or explicit call-us/unavailable status and policy version. No endpoint accepts a frontend inventory count. |
| Quote | One exact pricing function returning immutable quote identity, terms/input hash, price components, policy/calculator version, calendar-day convention and expiry. |
| Begin/complete checkout | One workflow for both customer surfaces; revalidates quote and capacity, acquires holds, and consumes verified financial results. |
| Operational mutations | Named assign/override/swap/ready/checkout/return/close/modify/extend/cancel/no-show operations; no generic resource patch that can change protected states or financial totals. |
| Evidence and customer history | Scoped waiver, inspection, incident, Trip, telemetry and history reads/writes through their named operations. |
| Operation status | Returns the authorized durable operation receipt or pending status; not a second execution endpoint. |

The embeddable widget and standalone booking site use the **same versioned customer booking application package and generated v1 client contract**. The widget is a registered-context embedding of that application. Neither contains pricing, availability or booking-rule algorithms. The public API has one route implementation for each contract, forwarding to the same database calculation/operation. The only contextual difference is the verified installation/session; identical normalized inputs, tenant policy revision and data snapshot produce identical results.

A quote normally expires after five minutes, but expiry is not an inventory reservation. Begin checkout rechecks current capacity and quote terms and then creates the proposed 15-minute payment hold. A policy/catalog change between quote and acceptance returns a revised quote for agreement rather than altering the displayed total invisibly. Once accepted, the agreement and pricing revisions are preserved.

Supported v1 clients receive additive-compatible changes only. The server does not remove v1 routes merely because a new widget version exists. A future breaking version requires an explicit migration/deprecation plan; every supported widget and site client is part of contract testing. This creates no public partner API, integration marketplace or outbound webhook product.

### 3.4 Mutation idempotency, retries, and replay

**Key scope:** tenant, authenticated Principal, versioned operation name, and idempotency key. A key is an opaque client-generated identifier with at least 128 bits of randomness and at most 128 characters. Clients create it once for a deliberate user intent and reuse it for every network retry. Device frames and provider callbacks additionally have source-native durable identity keys, independent of who retries delivery.

At admission, compute a canonical request hash from semantic inputs: operation/version, target IDs, expected resource versions, agreement/evidence revisions, amount/currency and acknowledged warning/reason when relevant. Exclude correlation IDs, transport headers, access-token bytes and inconsequential JSON formatting. Requests with different meaning may never share the same admitted key.

| Situation | Required operation/result behavior |
| --- | --- |
| Invalid authentication, forbidden action, or malformed request before admission | No domain effect and no durable domain-operation claim. A key does not reserve authorization. |
| First valid synchronous mutation | Insert the unique OperationRecord and perform its domain changes, audit and result receipt in one transaction. A crash before commit rolls everything back. |
| Identical concurrent request | Uniqueness serializes ownership. Briefly await the first transaction within a bounded request budget; then replay its committed result or return in-progress/status guidance. Never run the effect twice. |
| Same key, different semantic hash | Return IDEMPOTENCY_KEY_REUSED; execute nothing. A new reviewed intent needs a new key. |
| Definitive admitted business rejection | Preserve its immutable rejection receipt. Same-key retries replay that decision; a changed request/state review requires a new key. |
| Database deadlock, serialization failure, or pre-commit transient failure | Roll back the attempt; retry the entire command with the same key. No partial effect/audit survives. |
| External operation required | Commit operation, intent/outbox and audit first; return pending. The worker uses that same durable operation's provider key and records attempts/results through named operations. |
| Response lost after commit | Replay the original receipt after current authorization is rechecked. A replay has the current request ID but the original operation ID, completion time and resource versions. |
| Provider result uncertain | Keep operation pending/reconciling; retrieve the known provider object or safely retry within the provider's documented guarantee. Never create a replacement money movement merely because the HTTP response was lost. |

A durable business rejection is returned as a typed failure receipt in an otherwise committed operation transaction. It is not implemented by raising a final database exception that would erase its OperationRecord. If a tentative domain step fails, its database subtransaction is rolled back before committing the rejection receipt; no successful-change audit or partial domain effect survives. Infrastructure/constraint failures that cannot be safely classified roll back the entire transaction and follow transient-failure handling. For a duplicate still waiting on an uncommitted operation claim, provide a status link only if the operation identity is resolvable; otherwise instruct a bounded same-key retry, without inventing a completed operation.

Response-cache proposal: retain the fully serialized response for **24 hours**. Durable operation identity, request hash and source/result references remain for the associated business-history lifetime, with nonexpiring minimal deduplication tombstones in V1. Cache expiry never makes a key unused. Reconstruct a permitted receipt from immutable result references; if its detailed result is no longer available, return an explicit result-unavailable status without re-executing the mutation. A cache hit is served only after current tenant/session/resource authorization succeeds.

Current resource reads are separate from operation replay. If an earlier checkout receipt says the item became checked_out at its original version, a replay labels that historical receipt; a fresh item read may now show returned. The API must not present the old receipt as a current-state refresh.

For financial operations, uniqueness also binds each provider account/event ID, transaction/refund ID, and ledger posting purpose to one local effect. Stripe can prune its idempotency keys after at least 24 hours; Talus therefore cannot rely on that provider cache as its permanent payment ledger or retry memory. Outside a provider's safe retry window, an uncertain create/capture/refund is reconciled before any resubmission. [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

No distributed transaction with an external provider is claimed. The guarantee is one authoritative local operation/posting plus controlled reconciliation of external uncertainty. A provider adapter unable to preserve or establish the required outcome must surface uncertainty and block conflicting financial actions, not claim exactly-once delivery without evidence.

## 4. Module dependency graph and Phase 2 build sequence

### 4.1 Boundary and transaction rules

Modules are isolated ownership boundaries inside one system of record. They are not independently authoritative booking and fleet services. A module owns its domain facts and named operations; another module uses its declared contract and cannot directly update its private facts. Interface components use the public API only.

Every command contract carries verified request context, operation ID, target identifiers, expected versions, and explicit input/evidence references. Its result is a committed receipt with resulting versions, audit references and any durable pending work. Read contracts return scoped facts with provenance/as-of metadata. Internal helper contracts share an already-open transaction and lock context and cannot independently commit. External provider actions occur after commit through the outbox.

**Avoiding a dependency cycle:** Booking Core is the private structural kernel. It owns transition legality, parent/item relationships, commitments, occupancy and lifecycle-created Trip identity. Later domains provide the pricing, ledger, waiver and inspection facts. The workflow module composes these facts and the guarded kernel operations inside one database transaction. Core does not call a future UI, provider adapter, or orchestration module. The generic transition primitive is not callable by any external request role; business guards execute in the exposed named workflow functions, while structural constraints remain enforced regardless of caller.

Core publishes the record/reference contracts required by its relationships, including versioned policy and evidence identities. A later module may complete the explicitly declared foreign-key integration for its owned facts; it may not substitute an unvalidated UUID or a permissive “gate passed” placeholder. Until the relevant domain and workflow gates are installed, affected production transitions are unavailable. An early Core acceptance test establishes structural behavior, not a claim that an unfinished checkout workflow can serve customers.

### 4.2 Complete directed dependency graph

The table is the formal adjacency specification of the graph: each listed dependency has a directed edge **dependency → module**. Transitive dependencies are inherited. No edges point backward in the numbered build order, and unlisted reverse calls are prohibited. The final row is a release gate, not another business subsystem.

| Order / module | Direct dependencies | Responsibility |
| --- | --- | --- |
| M01 — Foundation and API perimeter | None | Tenant identity, request context, RLS/privilege conventions, audit, idempotency, jobs, shared exact-value contracts and private file metadata/access. |
| M02 — Booking Core kernel | M01 | Minimal booking/customer/catalog/fleet identity contracts; booking/item states; commitments; availability/feasibility; occupancy; checkout occurrence and sealed Trip core. |
| M03 — Tenant configuration, catalog and fleet administration | M01, M02 | Immutable policy/rate/limit definitions, tenant/location/category/add-on configuration, fleet/device installation management and explicit state/transfer commands. |
| M04 — Pricing and promotions | M02, M03 | Exact quotes, calendar-day pricing, snapshot/revision calculation, promo eligibility/redemption and tax adapter boundary. |
| M05 — Ledger and financial operations | M01, M02, M04 | Obligations, installments, settlements, deposits, refunds, balanced journals and payment-operation/reconciliation contracts. |
| M06 — Assignment and maintenance | M02, M03 | Scheduled assignment, overrides/swaps, maintenance rules/tasks/completions/blocks and assignment-attention view/events. |
| M07 — Waivers and customer history | M01, M02, M03 | Versioned waiver flows/participants/signatures, customer notes/flags and scoped history. |
| M08 — Inspections, equipment and incidents | M01, M02, M03 | Boundary observations, pre/post inspections, evidence objects, quantity movements and manual incident history. |
| M09 — Device ingest and raw evidence | M01, M02, M03 | Device-scoped ingest, deduplication, clock/installation/Trip attribution, raw frames/positions/signals and provenance. |
| M10 — Trip summaries, geofences and operating-limit episodes | M02, M03, M08, M09 | Versioned summaries/coverage, boundary reconciliation, three limit types, episode/alert deduplication and indexed recall. |
| M11 — Customer communications | M01, M02, M03, M07 | Booking email/SMS, waiver links, sending identities, consent/STOP, outbox/provider delivery evidence and inbound routing. |
| M12 — Selected payment provider adapter | M01, M03, M05 | Provider onboarding/account mapping, payment attempts, callback verification, reconciliation and application-fee/refund integration. |
| M13 — Authoritative booking workflows | M02, M03, M04, M05, M06, M07, M08, M10, M11, M12 | The public create/confirm/modify/extend/ready/checkout/return/cancel/no-show/close functions; composes every required guard atomically. |
| M14 — Affiliates | M03, M05, M13 | Referral attribution, snapshotted commission terms, completion-triggered earning, adjustments and manual payout recording. |
| M15 — Shared customer booking experience | M02, M03, M04, M07, M11, M12, M13 | One customer application and contract client for the widget and standalone site, including catalog, quote, payment, waiver and message status. |
| M16 — Operator app and operational reports | M02, M03, M04, M05, M06, M07, M08, M09, M10, M11, M12, M13, M14 | Role-gated Today, bookings, calendar, fleet, history, financial, inspection/incident/SMS, live telemetry, Trip search, assignment queue, configuration and utilization surfaces. |
| M17 — Retention and recovery operations | M01, M03, M08, M09, M10 | Tenant-scoped raw retention, evidence preservation holds, purge manifests, partition maintenance and restore checks. |
| G18 — Integrated production acceptance | All M01–M17 | Full real-database security/concurrency and end-to-end conformance; no production activation before this gate passes. |

**Strict Phase 2 sequence:** M01, M02, M03, M04, M05, M06, M07, M08, M09, M10, M11, M12, M13, M14, M15, M16, M17, then G18. Some graph nodes are logically independent, but this proposed execution order is deliberately serial as requested. Foundation and Booking Core come first. No module starts before its predecessors' required contracts and acceptance results are available.

Interface dependencies identify the API contract families they consume; they do not authorize an interface to import database modules or query their tables. All those calls still enter through the one public Talus API and carry the interface caller's identity to the data layer.

For each module, write acceptance tests first, implement only that module and its declared integration seams, execute its gates, and present its result before proceeding under the authorized Phase 2 workflow. This document neither starts those tests nor authorizes implementation before the requested architecture review.

### 4.3 Module contracts and acceptance criteria

Every module inherits the common gate in §4.4. The following specify additional ownership and observable contract outcomes; test fixtures may seed real prerequisite records in a dedicated database, but cannot replace RLS, constraints or transactions with mocks.

**M01 — Foundation and API perimeter.** Owns Principal/session/job authentication, verified transaction context, immutable audit, operation claims/results, secret references, evidence metadata, and role/function grants. Exports AuthorizeRequest, ResolveScope, Begin/CompleteOperation, AppendAudit, Claim/FenceJob and AuthorizeEvidenceAccess contracts. Acceptance: all four caller classes exercise real RLS; altered tenant/audience/class claims fail; pooled connections never reuse prior identity; request roles cannot write tables or execute an owner-only function; duplicate operation claims serialize; audit failure aborts a domain transaction; a stale worker fencing token fails.

**M02 — Booking Core.** Owns booking/item structural records, canonical commitment/occupancy, transition definitions, parent locks/revisions and Trip opening/closing identity. Exports ReadAvailability, CheckWholeIntervalFeasibility, Acquire/ReleaseCommitment, Reserve/ReleaseOccupancy and private ApplyTransition/OpenTrip/SealTrip contracts. Acceptance: last-category-unit races, fragmented interval capacity, maintenance/rental overlap and adjacent boundaries; the full closure race suite in §1.4; terminal-parent insert/reparent attempts fail; no customer can execute the private transition primitive; no simulated motion can open a Trip. Future business gates fail closed until integrated, and are not certified here by fake financial/waiver success.

**M03 — Configuration/catalog/fleet.** Owns the concrete policy versions, catalog terms and administrative change history while using Core's machine/location identity and occupancy authority. Exports PublishConfiguration, PublishRate/LimitVersion, RegisterDeviceInstallation and Propose/ApplyFleetChange contracts. Acceptance: tenant managers cannot publish another tenant's policy; staff cannot change rates/state; prior snapshots survive config edits; simultaneous reclassification/transfer and assignment cannot leave a wrong-location/category assignment; one device cannot be installed on overlapping machines. A fleet change with affected assignments requires the declared transactional resolution plan.

**M04 — Pricing/promotions.** Owns exact calculation methods, quote/snapshot lines, allocation and promo redemption. Exports Quote, ValidateQuote, PriceRevision and Reserve/Consume/ReleasePromo contracts, with cents, basis points, revision/hash and rounding provenance. Acceptance: no floating-point path even at large integer amounts; calendar-day/DST boundaries; component sums and remainder allocation; rate changes do not reprice history; parallel use of the last promo entitlement yields one normal redemption; foreign-tenant promo/rate references fail. Tax is a replaceable exact-value contract, with no fabricated tax result if configuration/provider is unavailable.

**M05 — Ledger/financial operations.** Owns financial journals, payment operations/attempts, refund reservations and derived balances. Exports AssessAgreementAdjustment, PlanCollection, ApplyVerifiedPaymentOutcome, ReserveRefund, SettleDeposit and ReadFinancialReadiness. Acceptance: balanced journals under real deferred checks; one provider/business source cannot post twice; simultaneous refunds cannot exceed eligible settled funds after existing pending refunds; tenant/account/currency/item cross-allocation fails; security deposits remain distinct from rental funds; an unknown provider outcome cannot satisfy G3/G5/G8.

**M06 — Assignment/maintenance.** Owns scheduling attempts, override coordination, attention events and maintenance operational records, using Core occupancy rather than a separate calendar. Exports Plan/CommitAssignments, OverrideAssignment, SwapAssignments, ReadAssignmentNeeds, BlockMaintenance and RecordMaintenanceCompletion. Acceptance: two workers competing for one machine; atomic two-item swap and rollback; contention is not labelled zero capacity; deterministic tie-breaks; ready evidence invalidates after swap; rental-versus-maintenance and transfer races; due maintenance with missing hours remains honest; manager override cannot bypass occupancy or tenant boundaries.

**M07 — Waivers/customer history.** Owns immutable agreement text/signatures, waiver-scoped participants, customer notes/flags. Exports CreateWaiverRequest, SignWaiver, ReadWaiverReadiness and AmendCustomerFlag/Note. Acceptance: signatures bind exact version/hash and configured scope; duplicated signing creates one signature; party and individual modes cannot silently substitute for each other; concurrent waiver publication does not rewrite a request; a customer/waiver token cannot see staff notes or another booking; customer contacts still exist without any waiver.

**M08 — Inspections/equipment/incidents.** Owns immutable observations/evidence links and quantity movements. Exports Prepare/SealBoundaryEvidence, Submit/AmendInspection, Issue/ReturnEquipment, Record/ResolveIncident and ReadCloseEvidence. Acceptance: pre-inspection before Trip creation later shares the exact checkout boundary; automatic/manual/unsupported/stale values stay distinct; concurrent duplicate returns cannot make equipment balances negative; same-tenant but wrong-item evidence associations fail; a manual incident needs no telemetry; estimate entry creates no automatic charge; amended evidence preserves prior content.

**M09 — Device ingest.** Owns accepted raw-event identity, frame storage/decoding and attribution evidence. Exports IngestFrames, ReadLatestMeasuredSignals and ReadTripFrames under device/staff scopes. Acceptance: forged device/tenant/machine inputs fail; duplicate frames across reconnects/partitions yield one event; same identity/different payload is quarantined; checkout/return and ingest races preserve exact attribution; late frames follow the recorded installation and lifecycle intervals; corrupt clocks remain unresolved rather than guessed; rate limiting isolates devices/tenants; simulator credentials cannot produce real evidence.

**M10 — Trip summaries/limits.** Owns summary/metric/coverage revisions and the shared Violation/Geofence Breach episode identity. Exports SettleTripEvidence, ReadTripSummary/Route, EvaluateLimitEpisodes and SearchTrips. Acceptance: out-of-order replay gives equivalent effective results; threshold jitter generates one episode; backfill merges preserve revision history and avoid duplicate alerts; gap/unsupported speed never appears clean or zero; changed thresholds/geometry do not reinterpret old Trips; no crash/rollover labels arise; all required tenant/date/location/category/machine/customer/violation searches use the real database and cannot disclose another tenant's route.

**M11 — Communications.** Owns message/outbox/delivery/consent and tenant sending-identity routing. Exports QueueBookingMessage, QueueWaiverLink, ApplyDeliveryEvidence, RecordConsent/Stop and RouteInboundMessage. Acceptance: booking confirmation remains independent of delivery; duplicate/out-of-order callbacks do not duplicate messages or regress proven delivery; uncertain send results are reconciled; STOP prevents subsequent consent-requiring sends; identical customer numbers in different tenants route correctly; an ambiguous booking association remains unresolved; no provider acceptance is shown as confirmed delivery.

**M12 — Provider adapter.** Owns provider-specific transport and event normalization, never booking/ledger authority. Exports Create/Inspect/CancelPaymentAttempt, Capture/ReleaseAuthorization, Request/InspectRefund and NormalizeVerifiedProviderEvent. Acceptance uses a real local PostgreSQL database plus the selected provider's test environment: incorrect account/signature fails; duplicate events/financial object notifications post once; response loss before/after local persistence remains reconcilable; retries outside the provider key-retention window do not generate a blind new charge; authorization expiry, required customer authentication and pending refunds are explicit; application-fee refunds follow the chosen policy.

**M13 — Booking workflows.** Owns cross-domain orchestration and the concrete public mutation contracts in §3.3. Each named function invokes domain guards and Core operations within one database transaction, returning the standard receipt. Acceptance: every listed transition succeeds only with its complete guards; every unlisted edge fails; omitted/expired waiver, financial or inspection proof blocks departure; confirmed booking/notification enqueue are atomic; expired holds plus payment callbacks cannot overbook silently; cancellation-versus-payment, return-versus-close, modification-versus-assignment, active extension and partial return races produce consistent history; audit/occupancy/pricing/ledger effects roll back together.

**M14 — Affiliates.** Owns referral and commission evidence. Exports AttributeReferral, EarnOnBookingClosure, AdjustCommission and RecordManualPayout. Acceptance: source closure event earns at most once; cancelled/no-show portions never earn; partial-completion bookings allocate only qualifying completed amounts; refund-after-earning adds a compensating entry; paid is supported by actual operator-recorded payment; concurrent payout recording cannot exceed earned outstanding amounts; attribution and promo discounts remain independent and tenant-scoped.

**M15 — Shared customer experience.** Owns presentation/session handling for one shared widget/site package; it owns no financial or availability rules. Acceptance: identical sessions/inputs reach identical API versions/functions and render the same totals; stale quotes and holds require revalidation; no browser database credential or direct database path exists; API rule/permission failures remain understandable; unsupported/out-of-window/unknown states are rendered honestly; retries retain the original key; embedded context cannot select a private resource in another tenant.

**M16 — Operator app/reports.** Owns presentation and read models for required operator surfaces, not alternative state or balance stores. Acceptance: real staff/manager/owner sessions see the correct actions and still receive database denial for forbidden calls; Today shows one returned/two checked-out units correctly; queue acknowledgement does not resolve assignment; overdue units retain custody; calendar edits invoke normal mutation contracts; reports reconcile to source records and tenant-local calendar conventions; customer, Trip and incident histories remain scoped; a stale browser tab cannot overwrite another operator's change.

**M17 — Retention/recovery.** Owns preservation holds and purge manifests/procedures under the policy in §5.5. Acceptance: a hold and purge racing for the same evidence serialize safely; one tenant's short retention never deletes another tenant's frames; mixed-policy partitions are not dropped wholesale; raw deletion leaves event identities, boundary/peak evidence, summaries, violations and audit intact; late legitimate frames receive their own retention window; expired source evidence is labelled; restore replays purge manifests before reopening tenant access.

### 4.4 Common real-database gate and G18

Every module's acceptance uses a real PostgreSQL instance with the actual extensions, RLS policies, constraints, function owners, request roles and connection pooling behavior. Fixtures are intentionally labelled test data. A mocked database or an all-powerful test connection cannot establish module acceptance. Trusted fixture creation is separated from the identities performing the tests.

Required dimensions are: two tenants with similarly named records; customers with different booking grants in the same tenant; all staff roles; a device and internal worker; absent/forged/stale context; same-tenant wrong-parent FKs; immutable history mutation attempts; duplicate and concurrent commands using independent database sessions; and failure immediately before/after durable commit. Concurrency tests use explicit synchronization barriers to force contested execution, not timing-dependent sleeps or merely sequential retries. A system error must not be counted as proof of a correct business rejection.

G18 reruns the composed critical races against the complete system, including third-party adapter uncertainty, live custody conflicts with future maintenance/assignments, partial returns, old widget compatibility, large exact monetary values, DST dates, tenant-specific policy changes, telemetry gaps/backfill, retention and recovery. It also verifies that no interface has a privileged database credential, no public request role has table-write rights, and no unaudited material path exists. Real provider sandbox results establish adapter behavior; they do not replace the database security tests.

Production activation requires all required contracts and guards to be installed and enabled, every relevant module gate to pass, and the adopted commercial/operational policies to be explicit. No early module is allowed to label missing behavior “temporarily successful.”

## 5. Concrete proposals for §35 open decisions

### 5.0 Policy adoption and placeholder structure

These are **proposed defaults for review**, not policies already approved by the founder or accepted by customers. Each has a typed production structure and an explicit unadopted state. An absent decision is not converted to a zero fee, an assumed refund rule, or a clean telemetry verdict.

Each policy version records: tenant and policy identity; version; decision state (proposed, adopted, superseded); effective-from time; exact typed parameters; applicable category/location scope; approving Principal and time; human-readable terms/version; and the audit reference. Adopted versions are immutable. Current configuration points to adopted versions, and bookings snapshot the applicable versions. A change creates a new version, not an edit to historic agreements.

The proposals below replace the unresolved Part 1 choices only if approved and explicitly adopted in configuration. Required parameters that remain unconfigured block only their affected flow, with a precise configuration error. No live provider account, policy, charge, limit or retention task is created by this document.

### 5.1 §35.1 — Processor and payment timing

**Recommend Stripe Connect direct charges to each tenant's connected account**, using Stripe-hosted merchant onboarding and a tenant dashboard arrangement suitable for its own account. This aligns the integration with the requirement that each operator has its own payment account. Direct charges and payment objects live on the connected account, and an application fee can be collected for the platform. This is an architectural recommendation, not a representation that an account has been approved or activated. [Stripe direct charges](https://docs.stripe.com/connect/direct-charges).

Talus's adapter always resolves the connected account from the validated TenantPaymentAccount for the local PaymentOperation. A client-provided account header is never used as authority. Provider secrets reside only in the adapter's protected environment; responses/events are checked against the expected account, operation, currency and amount. Country/account capabilities and the connected-account responsibility configuration must be resolved by actual onboarding before that tenant's payment path is enabled. The processor-neutral ledger remains authoritative if a different adapter is selected later.

**Default timing proposal: collect the full rental-related amount at confirmation.** The separate refundable security deposit is not rental revenue and is not the booking's installment “deposit.” The alternative basic split schedule is fully representable without changing the ledger.

| Structure / field | Proposed value and constraint |
| --- | --- |
| payment_processor | stripe_connect_direct proposed; unavailable/unconfigured until an enabled tenant account exists. |
| rental_collection_mode | full_at_confirmation by default; alternative split_prepaid. Only these two basic schedules in V1. |
| initial_rental_payment_bps | 10,000 for full; proposed 3,000 for split (30%). Split must be greater than zero and less than 10,000. |
| remainder_due_milestone | none for full; before_first_checkout for split. The remainder equals the exact rental obligation minus the first scheduled collection. |
| confirmation_condition | Initial scheduled amount is successfully collected and ledger-posted, or explicitly zero. An authorization alone is not a rental payment. |
| checkout_condition | Entire rental amount due before departure is settled; security-deposit condition separately satisfied. |
| payment_hold_minutes | 15 from accepted checkout start. Expiry releases category hold eligibility, but does not discard a payment attempt or its possible late success. |
| automatic_off_session_collection | Disabled by default. A due balance creates a collection action; the system does not assume consent or a usable payment method. |
| security_deposit_amount | Tenant/category-configured integer cents; no invented global amount. Explicit not_offered is a valid chosen policy. |
| security_deposit_method | When offered, propose authorization_at_pickup; support explicit collect_refundable_deposit_at_pickup where the adopted policy requires it. Neither method is inferred from rental installments. |

A PaymentScheduleRevision has key (tenant, schedule_revision_id), references the same booking's PriceSnapshot, and contains the fixed confirmation and, if applicable, pre-checkout installments. A PaymentInstallment has a stable installment ID, a same-tenant schedule reference, a unique milestone within that revision, integer amount, due condition, and linked allocations. Amounts sum exactly to the non-security-deposit rental obligation. Confirmation rounding uses the recorded integer-cent rule; if a positive split obligation would otherwise round its initial installment to zero, require one cent, capped at the total. The remainder receives the residual cents. Later price changes append schedule/obligation revisions and never overwrite settled installments or repeat already paid amounts.

Illustrative configured split: a 100,000-cent rental obligation yields 30,000 cents at confirmation and 70,000 before first checkout. A separately configured 50,000-cent refundable security deposit remains a different liability/authorization. These are examples of the representation, not platform-wide rental/deposit amounts.

For authorization-at-pickup, read the provider's actual authorization expiry. Proposed readiness requirement: it must cover the scheduled return plus a 24-hour processing margin. If that cannot be achieved, use an explicitly adopted alternative collection/authorization arrangement or block departure with a clear action. Monitor expiry during an overdue rental and never describe an expired authorization as held funds. Extensions re-evaluate the deposit condition. Do not assume every card/payment method supports the same hold duration or automatic reauthorization. Capturing a security-deposit authorization requires an explicit manager-authorized action; automatic capture merely to avoid expiry is not enabled. [Stripe authorization expiry and method limits](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method).

If payment arrives after the category hold expired, record the real collection, then revalidate commitment acceptance. If capacity no longer fits, leave confirmation unresolved and seek an authorized staff decision or refund; never use the successful charge as an occupancy/capacity bypass. A previously cancelled checkout is refunded/reconciled rather than resurrected. Operational Booking state and financial outcome remain separate throughout.

### 5.2 §35.2 — Platform fee model

**Recommend a proposed operator-paid cut of 200 basis points (2%) of net eligible rental/add-on charges.** This is a founder pricing proposal, not a researched market norm or an approved charge. A flat fee remains an alternative, and explicit none is supported. The customer pays the already quoted rental total; the proposed operator-paid cut is an allocation of proceeds, not an undisclosed customer surcharge.

| Field | Representation and default |
| --- | --- |
| mode | Exactly one of none, flat, basis_points. Proposed adopted default: basis_points. Unadopted remains a separate decision state. |
| rate_bps | 200 in the proposed percentage mode; integer within 1–10,000. Null outside that mode. |
| flat_fee_cents | Positive integer cents in flat mode; illustrative alternative 500 cents per booking. Null outside flat mode. |
| payer | tenant for the proposed V1 policy. A future customer fee requires separately explicit quoted terms, not reinterpretation of this cut. |
| basis | Rental plus eligible add-ons after multi-day/promo discounts; exclude taxes, mandatory pass-through fees, refundable security deposits, and the platform fee itself. |
| assessment_scope | Once per booking agreement/revision, with explicit adjustment differences; never once per item, provider retry or payment installment. |
| collection_allocation | Allocate the agreed fee across actual eligible collections using exact integer remainders. No installment can collect a fee larger than its eligible captured proceeds. |
| refund_treatment | Proportionally reverse the cut attributable to refunded eligible charges. An operator-cancelled unfulfilled rental receives the full corresponding fee reversal. |

Percentage calculation uses exact cents multiplied by basis points and the recorded rounding rule. A flat fee is capped at the eligible basis; a zero eligible basis has zero fee. Journals distinguish the agreed total fee, amount already collected, new adjustment, and amount refunded. Settling a second installment must not assess a second full flat fee.

The tenant-facing financial breakdown shows the cut and net proceeds. A customer-facing total includes only customer-payable components. The snapshot records payer and basis, so showing an operator-paid fee cannot accidentally add it to the customer's amount due.

The Stripe adapter maps approved fee allocations to application-fee operations and records their results. Application-fee refunds are an explicit adapter action; they are not assumed to happen automatically with the customer refund. Pending fee reversals remain visible in reconciliation. [Stripe application-fee refunds](https://docs.stripe.com/connect/direct-charges?client=react&platform=web&ui=elements).

### 5.3 §35.3 — Cancellation refund tiers

**Propose the following initial commercial schedule**, subject to adoption in the tenant's customer-facing policy. The percentage applies to the **eligible rental/add-on amount actually collected and allocated to the cancelled item(s)**. The proposed policy waives any uncollected remainder for cancelled units and performs no new automatic cancellation collection. This defines split-payment behavior explicitly rather than ambiguously referring to a “deposit refund.”

| Time before the affected item's scheduled pickup | Refund basis points on eligible collected amount | Equivalent |
| --- | --- | --- |
| At least 10,080 minutes | 10,000 | 100% at least 168 hours before pickup |
| At least 2,880 but less than 10,080 minutes | 5,000 | 50% from 48 hours up to 168 hours |
| Less than 2,880 minutes, including at/after pickup for an unstarted unit | 0 | No ordinary rental/add-on refund |
| Operator cancels because it cannot supply the promised rental | 10,000, with full reversal of applicable unfulfilled-order charges | Full refund of the unfulfilled portion; separate reason/override record |

These cutoffs are elapsed advance minutes, evaluated against the authenticated server receipt time of the accepted cancellation request, with explicit UTC cutoff instants displayed in tenant-local time. This is distinct from calendar-day rental pricing. Client timestamps cannot move a request into a more favorable tier. Exactly 168 hours belongs to the full-refund tier; exactly 48 hours belongs to the 50% tier.

CancellationPolicyVersion includes: the non-overlapping ordered tiers; basis definition; policy text/hash; effective version; per-component refund treatment; uncollected-remainder treatment; no-show treatment; operator-cancellation treatment; rounding/allocation method; and manager exception rights. No tier gaps or overlapping boundaries are allowed. The version accepted with the booking is used even if the tenant edits its current cancellation policy later.

The rental/add-on refund is calculated against its original ledger allocation. Related tax and mandatory-fee reversals follow their explicitly recorded refundability/tax treatment; these component rules must be configured before policy publication. All unapplied refundable security-deposit collections are returned, and unused authorizations are released. Security deposits are never retained simply because the rental-refund tier is zero. An existing separately authorized damage/deposit disposition must be represented as its own ledger action, not hidden in cancellation arithmetic.

For partial cancellation, calculate the tier for each affected item's pickup and original allocation, then combine the cent amounts. Shared discounts/fees use the recorded allocation method, not a fresh rate applied to current catalog values. Concurrent refund requests reserve refundable amounts under ledger locks before provider submission. Cancelling the reservation may complete while its refund remains pending; financially closing a mixed fulfilled/cancelled booking waits for reconciliation.

A manager can grant a more favorable explicit exception with a reason and new adjustment/audit record. A do-not-rent flag or an assignment failure cannot silently select a worse refund tier. These proposed terms are commercial defaults; they do not determine jurisdiction-specific mandatory refund or tax requirements.

### 5.4 §35.4 — Affiliate earning trigger

**Recommend earning on the authoritative `booking.closed` event.** Confirmation, payment receipt, assignment and checkout do not earn a commission. Booking close provides the clearest V1 point at which the rental has actually been performed and its operational/financial wrap-up has passed the defined guards.

AffiliateCommissionPolicyVersion records trigger = booking.closed; fixed-cents or basis-point amount mode; eligible basis; cancellation/no-show exclusion; refund-adjustment behavior; and effective version. Each referral snapshots these terms. The commission rate/flat amount is explicitly configured for the partner; this proposal does not invent a universal partner commission amount.

Eligible basis consists only of net collected rental/add-on allocations for items that actually had a Trip and reached closed. Taxes, security deposits, cancelled/no-show items, and excluded pass-through charges do not earn commission. For a fixed booking commission with partial fulfilment, allocate the originally agreed fixed amount across the original eligible item bases by the recorded integer-remainder method; earn only the fulfilled allocations. A zero original eligible basis earns zero. Do not pay the full fixed commission on a mostly cancelled booking by accident.

The earning operation has a unique source key containing commission identity and the Booking closure audit-event ID. Its transaction confirms the qualifying facts, appends the earned event and audit, and cannot execute twice. A delayed or duplicate closure job therefore cannot double the payable balance. No-show or wholly cancelled parent states have no eligible closure event.

Paid is recorded only when the operator actually pays, with date, amount, staff actor and payment/reference evidence. This is manual payout tracking. A later refund or correction adds a negative earning adjustment; if the commission was already paid, the system exposes the resulting overpaid/adjustment balance. It does not automatically debit the partner or rewrite the prior paid event. No portal, automated payout or tax-onboarding system is introduced.

### 5.5 §35.5 — Raw telemetry retention and purge lifecycle

**Recommend 90 days of full-fidelity raw frames from server receipt time**, configurable per tenant. Receipt time avoids immediately expiring legitimate offline data just because its measurement timestamp is old or its clock was wrong. Event ordering/Trip attribution still uses accepted event time, not receipt time.

| Policy element | Proposed definition |
| --- | --- |
| raw_retention_days | 90 elapsed 24-hour periods; positive integer; version recorded at first accepted receipt. |
| policy changes | Prospective for new receipts by default. Shortening retention for existing evidence requires a separate explicit, audited adoption; no silent retroactive purge. |
| retained raw scope | Raw payloads and their full-fidelity decoded positions/signals. No deletion of booking, Trip, audit, financial, waiver, inspection or incident records through this policy. |
| deduplication identity | Retain the minimal TelemetryEvent identity/hash/attribution and replay tombstone without expiry in V1, as approved in Part 1. |
| retained derived evidence | Summary and violation revisions, threshold/geometry snapshots, boundary/peak facts, method/input provenance and coverage gaps remain with booking history. |
| settlement grace | Begin final settlement after 24 hours following return and the latest relevant late receipt, if available device watermarks/coverage support it. Unresolved coverage is finalized with explicit gaps, never clean by timeout. |
| preservation hold | Manager-authorized hold for a specified Trip/incident or machine/time interval; reason, actor, created time, scope and release/expiry policy required. Applies before purge and is audited. |
| scheduled purge | Daily bounded batches; seven-day advance eligibility notice/manifest, then deletion no earlier than actual retention expiry and only after preservation/processing guards pass. |

The logical RetentionRun/PurgeManifest identifies tenant, policy version, cutoff, exact batch/object/partition scope, evaluated hold version, evidence counts/hashes, start/completion times, actor/job and outcome. EvidencePreservationHold has a same-tenant target reference or explicitly bounded machine/time interval and a reason. RawEvidenceDisposition is append-only evidence that a source batch was purged, retained by hold, or failed; an API can explain absence without inventing a missing route.

**Purge lifecycle:** planned → eligible → executing → completed, with retained-by-hold and failed/retry outcomes. Planning does not hide existing evidence. At execution, lock the retention scope, re-evaluate current policy and preservation holds, ensure the relevant Trips are not open and required decoding/summary/episode processing is complete, then delete only the eligible raw facts in a bounded transaction. Record the disposition and audit atomically. A concurrent hold acquisition uses the same scope lock: whichever operation wins establishes the boundary, and a hold requested after deletion reports that the detailed evidence is already expired rather than pretending it restored it.

An unresolved processing failure blocks purge of its evidence and raises an internal storage/processing issue; it does not silently destroy the input required to finish the summary. A closed Trip with genuine missing coverage may be finalized-with-gaps and later purged on schedule after its available evidence has been processed. Late legitimate arrivals append new evidence and summary revisions under their own receipt-based retention window, without rewriting the closed Trip.

If new late data arrives after earlier raw inputs have expired, the revision distinguishes metrics recomputed from complete available inputs, retained earlier metrics with their original provenance, and values that can no longer be recomputed reliably. A retained earlier total is not relabelled as an updated complete result. Routes show only surviving measured segments with an explicit source-expired gap; no reconstruction or smoothing invents the purged evidence. Episode amendments likewise state any uncertainty caused by expired inputs.

**Mixed-tenant partitions:** a shared date partition cannot be dropped because one tenant's 90 days elapsed. Use tenant-scoped row/batch deletion under RLS when policies/holds differ. Physical partition removal is an internal maintenance operation only after the entire partition is proven free of retained/protected rows. Retention jobs have no authority to cascade into persistent event identities or booking history.

The active application store ceases to serve purged raw data. Recovery copies have a separately bounded retention; propose 14 days for encrypted recovery copies. A restored database is isolated until purge manifests and current preservation policies have been reapplied, so restoring an older backup cannot re-expose expired raw evidence. This distinguishes active-store expiry from instantaneous removal of every recovery copy.

Capacity planning must include raw frame bytes, decoded rows, indexes, write-ahead logs, backups and the continuing per-event deduplication metadata. Measure actual device cadence and stored size during the pilot; the 90-day policy is an explicit storage budget choice, not a promise that high-frequency frames are free. Per-device rate limits and tenant quotas cannot silently discard evidence while reporting complete coverage.

### 5.6 §35.6 — Operating limits and unmonitored handling

**Recommend no universal enabled numerical speed or tilt threshold.** Initial mode is unconfigured with a null entry threshold until the operator explicitly enables or disables a category/location-specific limit. Geofencing is likewise unconfigured until a real valid boundary is adopted or the operator explicitly disables it. This is the concrete choice of operator-defined limits with no platform numeric safety default, one of the options explicitly contemplated in §35. It is appropriate for a fleet spanning boats, motorcycles, snowmobiles and UTVs; a single invented value would not be an honest operating rule.

| Limit configuration | Proposed initial value / contract |
| --- | --- |
| speed.mode / entry_threshold_mm_per_second | unconfigured / null initially; modes are unconfigured, explicitly_disabled, enabled. When enabled: positive integer measured-speed threshold and a supported measured-speed capability are required. GPS position alone is not speed support. |
| tilt.mode / entry_threshold_centidegrees | unconfigured / null initially; same three modes. When enabled: valid positive angle within the configured axis domain, explicit roll/pitch/absolute-angle convention and device calibration/capability version are required. |
| geofence.mode / geofence_version_id | unconfigured / null initially; same three modes. Enabling requires a valid category/location boundary version. A point on the configured boundary counts as inside. |
| speed hysteresis proposal | Re-enter below the configured entry threshold minus 500 mm/second; entry must exceed that band or the operator must explicitly choose a smaller valid band. |
| tilt hysteresis proposal | Re-enter below the configured entry threshold minus 200 centidegrees (2 degrees); validate a positive remaining threshold or require a smaller explicit band. |
| geofence hysteresis proposal | Exit on supported valid outside observations; clear only after valid observations at least 10 metres inside the configured geometry. Geometry and re-entry band are snapshotted. |
| signal dwell proposal | 1,000 milliseconds of adequately sampled exceedance before confirming an episode; 2,000 milliseconds of re-entry before closing it. The first observed crossing time is retained. |
| coverage requirement | Evaluate continuity against the registered signal's expected sampling cadence/quality. A gap longer than three expected sample intervals breaks evidence continuity; no interpolation across it. |

The hysteresis/dwell figures are technical episode-coalescing proposals, not declarations of safe speed, safe tilt, or hardware accuracy. They are versioned with each adopted rule. Expected cadence and capability come from a platform-approved immutable device/capability version, not a tenant-editable value that could be lowered to manufacture a clean verdict. No signal is assumed supported merely to make the default parameters usable. Invalid/missing device cadence or quality prevents a clean verdict rather than inventing precision.

Default visible assessment states are:

- **Not configured:** the tenant has not enabled that limit; no verdict is made.
- **Not monitorable:** the configured limit requires a signal the installed hardware cannot supply.
- **Insufficient data:** the capability exists but readings are stale, invalid, missing or insufficiently sampled.
- **Monitored — no crossing observed:** supported evidence meets the configured coverage requirement and no episode was observed; coverage/window are displayed.
- **Monitored — threshold crossed:** one or more evidenced episodes exist, with threshold, observed peak, time/observed duration, provenance and any concurrent gaps.

An episode means only that a configured threshold was crossed. It never becomes an automated accusation of reckless driving or a crash/rollover/donut diagnosis. Each crossing episode has one stable identity and append-only revisions; repeated frames and reconnects cannot create duplicate real alerts. Simulated data remains explicitly simulated and cannot affect a real rental verdict. Policy changes are prospective through new booking terms/Trip snapshots, as approved in Part 1.

### 5.7 Other concrete defaults and Part 1 clarifications

The earlier open return-date billing convention is proposed as **return-date-exclusive calendar-day pricing with a minimum of one chargeable day**: calculate the difference between the accepted local return and pickup dates, never timestamp hours; same-day rentals charge one day. For example, Monday pickup/Wednesday return charges two calendar-day units. This must be shown as an adopted pricing convention; changing it creates a new policy version and does not reprice prior agreements.

The technical defaults introduced in this part are: 24-hour assignment lead; a 60-second recovery/retry sweep; 30-second fenced assignment job lease; three bounded transaction retries; two-second assignment planning budget per attempt; five-minute quote/review-challenge validity; 15-minute checkout hold; 60-minute manager-classified no-show grace; queue urgency within 120 minutes of pickup; 24-hour serialized operation-response cache with durable replay identity; and 90-day receipt-based raw retention. Timeouts that expire cannot override an invariant or manufacture a success.

Additional logical support structures refine Part 1 without adding a new product subsystem: payment-schedule revisions/installments, assignment-cycle/attention records, readiness receipts tied to immutable evidence, explicit replacement requests, evidence-preservation holds, purge manifests and raw-evidence dispositions. They follow the same tenant-scoped keys, ownership validation, immutable history and function-only mutation rules. None stores authoritative available inventory.

## Review boundary

Part 2 is delivered for review. Its proposed defaults and exact contracts are not yet activated. No application code, DDL, migration, HTML, setup command or test implementation has been written. **Phase 2 remains stopped pending your review and approval.**
