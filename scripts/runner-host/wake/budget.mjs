// What the fleet has cost today, kept by the scaler itself.
//
// AWS's own billing data (Cost Explorer, Budgets) arrives hours late, which is
// no use for a guard that has to act the same day. So every evaluation sweeps
// the fleet and bills each host by the second at its hourly rate: the spot
// price of its pool (or on-demand), plus its disk and public address. The
// running total lives in one SSM parameter as
//
//   { day, spent, live: { instanceId: [accountedUntilMs, usdPerHour] }, alerted, at }
//
// `alerted` is false, or the budget the day's alert fired for.
//
// A host last seen at t and gone at the next sweep is charged up to
// `idleCapMs` past t: idle-stop powers a host off within five minutes of its
// last job, so the true end lies in that window and the charge errs high. A
// "day" is the local calendar day at `utcOffsetHours` (-3, Brasília), so the
// guard resets at local midnight.
//
// Pure logic; index.mjs wires AWS in and the tests drive it with plain data.

const HOUR = 3_600_000;

export function localDay(nowMs, utcOffsetHours) {
  return new Date(nowMs + utcOffsetHours * HOUR).toISOString().slice(0, 10);
}

export function dayStart(day, utcOffsetHours) {
  return Date.parse(`${day}T00:00:00Z`) - utcOffsetHours * HOUR;
}

/**
 * @param {{ day: string, spent: number, live: Record<string, [number, number]>, alerted: false | number } | null} state
 * @param {{ id: string, launchedAt: number, rate: number }[]} hosts alive now (pending, running, stopping)
 * @returns the new state, with `spent` in USD for the local day of `now`
 */
export function accrue(state, hosts, now, { utcOffsetHours = -3, idleCapMs = 10 * 60_000 } = {}) {
  const day = localDay(now, utcOffsetHours);
  const start = dayStart(day, utcOffsetHours);
  const next = { day, spent: 0, live: {}, alerted: false, at: now };
  if (state?.day === day) {
    Object.assign(next, { spent: state.spent, alerted: state.alerted, live: { ...state.live } });
  } else if (state) {
    // A new day: hosts still up carry over, billed to today from midnight.
    for (const h of hosts) if (state.live?.[h.id]) next.live[h.id] = [start, state.live[h.id][1]];
  }
  const alive = new Set(hosts.map((h) => h.id));
  for (const [id, [t, rate]] of Object.entries(next.live)) {
    if (alive.has(id)) continue;
    next.spent += (Math.min(now - t, idleCapMs) * rate) / HOUR;
    delete next.live[id];
  }
  for (const h of hosts) {
    const [t, rate] = next.live[h.id] ?? [Math.max(h.launchedAt, start), h.rate];
    next.spent += (Math.max(0, now - t) * rate) / HOUR;
    next.live[h.id] = [now, rate];
  }
  return next;
}

/**
 * The fleet's ceiling for the rest of the day: the full cap while spending is
 * under the budget, a trickle once it is over. Jobs still run, slowly, until
 * the budget resets at local midnight.
 */
export function hostCap(state, { budget, maxHosts, degradedMaxHosts }) {
  return budget > 0 && (state?.spent ?? 0) >= budget ? Math.min(degradedMaxHosts, maxHosts) : maxHosts;
}

/**
 * A log line for a host that AWS took back, or null for one that ended any
 * other way (idle-stop's own poweroff is `Client.InstanceInitiatedShutdown`).
 * The line carries the pool and the host's age, so the reclaim rate of each
 * pool can be read back out of the logs: on 2026-09-24 the median reclaim hit
 * a host 7 minutes after launch, which is why the age is worth recording.
 * @param {{ InstanceId: string, InstanceType?: string, LaunchTime: string | Date,
 *   Placement?: { AvailabilityZone?: string }, StateReason?: { Code?: string }, StateTransitionReason?: string }} i
 * @param {string} region
 */
export function reclaimLine(i, region) {
  if (i.StateReason?.Code !== "Server.SpotInstanceTermination") return null;
  const at = /\((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) GMT\)/.exec(i.StateTransitionReason ?? "");
  const ended = at ? Date.parse(`${at[1].replace(" ", "T")}Z`) : NaN;
  const age = Number.isNaN(ended) ? "?" : Math.round((ended - new Date(i.LaunchTime).getTime()) / 60_000);
  return `reclaimed: ${i.InstanceId} ${i.InstanceType}@${i.Placement?.AvailabilityZone} (${region}) after ${age} min`;
}
