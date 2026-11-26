// Which CI experiment, if any, a workflow run belongs to.
//
// A run's bucket is the last digit of its run id: ids are large, increasing
// integers, so the digit is close to uniform, and a re-run keeps its id, so it
// keeps its bucket. The consumer's registry names, per experiment, the digits
// it holds from a given moment on. A run that holds no live experiment's digit
// is control. Everything here fails OPEN: a registry this code cannot read puts
// the run in control, with a reason, and never fails the pipeline.

/** The run's bucket: the last decimal digit of its id. */
export function digitOf(runId) {
  const s = String(runId ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s[s.length - 1]);
}

const time = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

/** The digits an experiment holds at `at` (ms), or [] when it is not live. */
export function digitsAt(experiment, at) {
  const start = time(experiment?.start);
  const end = time(experiment?.end);
  if (start === null || start === undefined || end === undefined || at < start) return [];
  if (end !== null && at >= end) return [];
  let current = [];
  const steps = Array.isArray(experiment.allocation) ? experiment.allocation : [];
  for (const step of steps) {
    const from = time(step?.from);
    if (from === null || from === undefined || from > at) continue;
    current = Array.isArray(step.digits) ? step.digits : [];
  }
  return current.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
}

/**
 * @param {object} p
 * @param {string|number} p.runId
 * @param {string} p.event          github.event_name
 * @param {string} p.createdAt      the run's created_at (ISO)
 * @param {object|null} p.registry  the parsed registry, or null when unreadable
 * @param {string} [p.off]          names switched off, separated by spaces or commas
 * @returns {{digit: number|null, experiment: string, reason: string}}
 */
export function assign({ runId, event, createdAt, registry, off = "" }) {
  const digit = digitOf(runId);
  const control = (reason) => ({ digit, experiment: "", reason });
  if (digit === null) return control("no run id");
  if (event !== "pull_request") return control(`event ${event} is always control`);
  if (!registry || typeof registry !== "object") return control("no registry");
  const at = time(createdAt);
  if (at === null || at === undefined) return control("no run creation time");
  const controlDigits = Array.isArray(registry.control) ? registry.control : [0, 1];
  if (controlDigits.includes(digit)) return control("control digit");
  const offSet = new Set(String(off).split(/[\s,]+/).filter(Boolean));
  const holders = [];
  for (const e of Array.isArray(registry.experiments) ? registry.experiments : []) {
    if (!e || typeof e.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e.name)) continue;
    if (!digitsAt(e, at).includes(digit)) continue;
    if (offSet.has(e.name)) return control(`${e.name} is switched off`);
    holders.push(e.name);
  }
  if (holders.length > 1) return control(`digit ${digit} is held by ${holders.join(" and ")}; registry invalid`);
  if (holders.length === 0) return control("no live experiment holds this digit");
  return { digit, experiment: holders[0], reason: "assigned" };
}
