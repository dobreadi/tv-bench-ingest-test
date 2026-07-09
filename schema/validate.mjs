/**
 * Port of tv-benchmark-deploy/worker.js `validateResult` — keep VERBATIM.
 * Zero runtime dependencies. Used by the ingest Action.
 *
 * Mirror of buildPublishPayload in tv-fps `fps/publish` — keep the two in sync.
 * THIRD mirror since the frame-analyser: analyser/publish.py posts display- and
 * content-domain rows here, so the payload schema now lives in THREE places
 * (fps/publish <-> this validateResult <-> frame-analyser publish.py). Change
 * all three (and the shared golden fixture) together.
 */

const DOMAINS = new Set(["raf", "display", "content"]);
// App-id charset — mirror of APP_IDS in tv-fps src/publish/index.ts, keep the
// two in sync. Registered 3rd-party ids share the charset, so the schema
// validates shape only (authorization is out of band on GHES).
const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SWEEP_TYPES = new Set(["full", "vertical", "horizontal"]);

export function validateResult(b) {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return { error: "not an object" };
  const allowed = new Set([
    "app", "sweepType", "flags", "sweep", "frames", "fps", "p50", "p95", "max",
    "stalls16", "stalls33", "deviceLabel", "build", "domain",
    // optional pacing/smoothness metrics (tv-fps SMOOTHNESS work)
    "cv", "hitches", "hitchMax", "hitchLostMs", "cluster33Max", "jumps", "jumpMaxPx",
    // pacing successors (cv-pacing-retune): raw cv-shaped controls stored to D1,
    // plus their derivable 0-100 twins (accepted, not persisted).
    "cvBase", "localPace", "cvRef", "cvPct", "cvBasePct", "localPacePct", "cvRefPct",
  ]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { error: `unknown field ${k}` };

  if (typeof b.app !== "string" || !APP_ID.test(b.app)) return { error: "bad app" };
  if (typeof b.sweepType !== "string" || !SWEEP_TYPES.has(b.sweepType)) return { error: "bad sweepType" };
  // domain: optional, defaults to the existing rAF behaviour so old clients
  // keep working; display/content come from the frame-analyser capture rig.
  if (b.domain !== undefined && (typeof b.domain !== "string" || !DOMAINS.has(b.domain)))
    return { error: "bad domain" };
  const domain = b.domain ?? "raf";

  const num = (x) => typeof x === "number" && Number.isFinite(x);
  const int = (x) => num(x) && Number.isInteger(x) && x >= 0;
  if (!int(b.frames) || b.frames > 100000) return { error: "bad frames" };
  if (!num(b.fps) || b.fps <= 0 || b.fps > 240) return { error: "bad fps" };
  if (!num(b.p50) || !num(b.p95) || !num(b.max)) return { error: "bad percentiles" };
  if (b.p50 < 0 || b.p50 > b.p95 || b.p95 > b.max || b.max > 60000) return { error: "bad percentiles" };
  if (!int(b.stalls16) || !int(b.stalls33)) return { error: "bad stalls" };
  if (b.stalls33 > b.stalls16 || b.stalls16 > Math.max(1, b.frames)) return { error: "bad stalls" };

  // Launch flags — the app's URL query, verbatim but bounded.
  const t = b.flags;
  if (t === null || typeof t !== "object" || Array.isArray(t)) return { error: "bad flags" };
  const keys = Object.keys(t);
  if (keys.length > 16) return { error: "bad flags" };
  for (const k of keys) {
    if (!/^[a-z][a-z0-9_-]{0,15}$/i.test(k)) return { error: "bad flags" };
    const x = t[k];
    if (!["string", "number", "boolean"].includes(typeof x)) return { error: "bad flags" };
    if (typeof x === "string" && x.length > 32) return { error: "bad flags" };
  }

  // Sweep parameters — optional fixed-shape object (fps/sweep SweepConfigSummary).
  let sweep;
  if (b.sweep !== undefined) {
    const s = b.sweep;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return { error: "bad sweep" };
    const SWEEP_KEYS = new Set(["rows", "cols", "verticalCycles", "rowReturn", "stepMs", "phases"]);
    for (const k of Object.keys(s)) if (!SWEEP_KEYS.has(k)) return { error: "bad sweep" };
    if (!int(s.rows) || s.rows > 10000) return { error: "bad sweep" };
    if (s.cols !== "variable" && (!int(s.cols) || s.cols > 10000)) return { error: "bad sweep" };
    if (!int(s.verticalCycles) || s.verticalCycles > 1000) return { error: "bad sweep" };
    if (!["rewind", "back", "none"].includes(s.rowReturn)) return { error: "bad sweep" };
    if (!num(s.stepMs) || s.stepMs <= 0 || s.stepMs > 10000) return { error: "bad sweep" };
    if (!Array.isArray(s.phases) || s.phases.length > 8) return { error: "bad sweep" };
    for (const p of s.phases) if (p !== "vertical" && p !== "horizontal") return { error: "bad sweep" };
    sweep = {
      rows: s.rows, cols: s.cols, verticalCycles: s.verticalCycles,
      rowReturn: s.rowReturn, stepMs: s.stepMs, phases: s.phases,
    };
  }

  // Optional smoothness metrics — bounded, null when absent.
  const opt = {};
  const optNum = (k, max) => {
    if (b[k] === undefined) return true;
    if (!num(b[k]) || b[k] < 0 || b[k] > max) return false;
    opt[k] = b[k];
    return true;
  };
  if (!optNum("cv", 100)) return { error: "bad cv" };
  // Pacing successors: raw ratios share cv's [0,100] bound; the Pct twins are
  // 0-100 (client rounds+clamps, but re-validate — never trust the wire).
  if (!optNum("cvBase", 100)) return { error: "bad cvBase" };
  if (!optNum("localPace", 100)) return { error: "bad localPace" };
  if (!optNum("cvRef", 100)) return { error: "bad cvRef" };
  if (!optNum("cvPct", 100)) return { error: "bad cvPct" };
  if (!optNum("cvBasePct", 100)) return { error: "bad cvBasePct" };
  if (!optNum("localPacePct", 100)) return { error: "bad localPacePct" };
  if (!optNum("cvRefPct", 100)) return { error: "bad cvRefPct" };
  if (!optNum("hitches", 100000)) return { error: "bad hitches" };
  if (!optNum("hitchMax", 60000)) return { error: "bad hitchMax" };
  if (!optNum("hitchLostMs", 600000)) return { error: "bad hitchLostMs" };
  if (!optNum("cluster33Max", 100000)) return { error: "bad cluster33Max" };
  if (!optNum("jumps", 100000)) return { error: "bad jumps" };
  if (!optNum("jumpMaxPx", 100000)) return { error: "bad jumpMaxPx" };

  let deviceLabel;
  if (b.deviceLabel !== undefined) {
    if (typeof b.deviceLabel !== "string" || b.deviceLabel.length > 64) return { error: "bad deviceLabel" };
    deviceLabel = b.deviceLabel.replace(/[\u0000-\u001f\u007f]/g, "").trim() || undefined;
  }

  // Build provenance — the publishing app's short commit SHA (optionally "-dirty").
  let build;
  if (b.build !== undefined) {
    if (typeof b.build !== "string" || !/^[0-9a-zA-Z._-]{1,40}$/.test(b.build)) return { error: "bad build" };
    build = b.build;
  }

  return {
    value: {
      app: b.app, sweepType: b.sweepType, domain, flags: t, sweep,
      frames: b.frames, fps: b.fps, p50: b.p50, p95: b.p95, max: b.max,
      stalls16: b.stalls16, stalls33: b.stalls33, deviceLabel, build, ...opt,
    },
  };
}
