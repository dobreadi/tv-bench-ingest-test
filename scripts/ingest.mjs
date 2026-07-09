#!/usr/bin/env node
/**
 * Ingest one repository_dispatch client_payload:
 *   validate → quota → write results/<ulid>.json → regenerate leaderboard.json
 *
 * Exit codes:
 *   0 — accepted OR rejected (reject ≠ workflow failure; reason logged)
 *   1 — unexpected I/O / programming error (should be rare)
 *
 * Env:
 *   CLIENT_PAYLOAD — JSON string of the publish payload (required)
 *   QUOTA_N        — per-app daily quota (default 50)
 *   REPO_ROOT      — repo root (default: cwd)
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateResult } from "../schema/validate.mjs";
import { gradeSmoothness } from "../vendor/grade.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT || path.resolve(here, "..");
const RESULTS = path.join(ROOT, "results");
const LEADERBOARD = path.join(ROOT, "leaderboard.json");
const QUOTA_N = Math.max(1, parseInt(process.env.QUOTA_N || "50", 10) || 50);

/** Crockford base32 (ULID alphabet). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms) {
  let t = ms;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  // 80 bits → 16 chars
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.slice(0, 16);
}

/** ULID — lexicographically sortable by time. */
export function ulid(now = Date.now()) {
  return encodeTime(now) + encodeRandom();
}

/** D1-style UTC timestamp: "YYYY-MM-DD HH:MM:SS" (lexicographically sortable). */
export function formatCreatedAt(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function todayUtcPrefix(d = new Date()) {
  return formatCreatedAt(d).slice(0, 10); // YYYY-MM-DD
}

function listResultFiles() {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS).filter((f) => f.endsWith(".json"));
}

function readResult(file) {
  return JSON.parse(readFileSync(path.join(RESULTS, file), "utf8"));
}

function countTodayForApp(app, dayPrefix) {
  let n = 0;
  for (const f of listResultFiles()) {
    try {
      const row = readResult(f);
      if (row.app === app && typeof row.createdAt === "string" && row.createdAt.startsWith(dayPrefix)) {
        n++;
      }
    } catch {
      /* skip corrupt */
    }
  }
  return n;
}

/** Persistable row — Pct twins dropped (derivable); grade computed server-side. */
function toStoredRow(id, createdAt, r) {
  const grade = gradeSmoothness({
    frames: r.frames,
    hitches: r.hitches,
    hitchMax: r.hitchMax,
    cv: r.cv,
    localPace: r.localPace,
  });
  return {
    id,
    createdAt,
    app: r.app,
    sweepType: r.sweepType,
    domain: r.domain,
    flags: r.flags,
    sweepConfig: r.sweep ?? null,
    frames: r.frames,
    fps: r.fps,
    p50: r.p50,
    p95: r.p95,
    max: r.max,
    stalls16: r.stalls16,
    stalls33: r.stalls33,
    cv: r.cv ?? null,
    hitches: r.hitches ?? null,
    hitchMax: r.hitchMax ?? null,
    hitchLostMs: r.hitchLostMs ?? null,
    cluster33Max: r.cluster33Max ?? null,
    jumps: r.jumps ?? null,
    jumpMaxPx: r.jumpMaxPx ?? null,
    localPace: r.localPace ?? null,
    cvBase: r.cvBase ?? null,
    cvRef: r.cvRef ?? null,
    device: null,
    browser: null,
    deviceLabel: r.deviceLabel ?? null,
    build: r.build ?? null,
    hidden: 0,
    grade: grade ? { tier: grade.tier, label: grade.label } : null,
  };
}

/** Board-facing row — fields source.ts / BoardRow consume. */
function toBoardRow(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    app: row.app,
    sweepType: row.sweepType,
    domain: row.domain ?? "raf",
    flags: row.flags ?? null,
    sweepConfig: row.sweepConfig ?? null,
    frames: row.frames,
    fps: row.fps,
    p50: row.p50,
    p95: row.p95,
    max: row.max,
    stalls16: row.stalls16,
    stalls33: row.stalls33,
    cv: row.cv ?? null,
    hitches: row.hitches ?? null,
    hitchMax: row.hitchMax ?? null,
    hitchLostMs: row.hitchLostMs ?? null,
    cluster33Max: row.cluster33Max ?? null,
    jumps: row.jumps ?? null,
    jumpMaxPx: row.jumpMaxPx ?? null,
    localPace: row.localPace ?? null,
    build: row.build ?? null,
    device: row.device ?? null,
    browser: row.browser ?? null,
    deviceLabel: row.deviceLabel ?? null,
  };
}

export function regenerateLeaderboard(root = ROOT) {
  const resultsDir = path.join(root, "results");
  const out = path.join(root, "leaderboard.json");
  const rows = [];
  if (existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir).filter((x) => x.endsWith(".json"))) {
      try {
        const row = JSON.parse(readFileSync(path.join(resultsDir, f), "utf8"));
        if (row && row.hidden !== 1 && row.hidden !== true) rows.push(toBoardRow(row));
      } catch {
        /* skip */
      }
    }
  }
  writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
  return rows.length;
}

function reject(reason) {
  console.log(`REJECT: ${reason}`);
  process.exit(0);
}

function main() {
  const raw = process.env.CLIENT_PAYLOAD;
  if (raw === undefined || raw === "") reject("missing CLIENT_PAYLOAD");

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    reject("invalid json");
  }

  // Transport unwrap:
  //   1) Actions may pass the dispatch body as { client_payload: … }
  //   2) GitHub caps client_payload at 10 top-level keys, so the publisher
  //      nests the unchanged schema under { result: <publish payload> }.
  //   3) Flat payloads (≤10 keys, e.g. minimal fixtures) are also accepted.
  let payload = body;
  if (payload && typeof payload === "object" && payload.client_payload !== undefined) {
    payload = payload.client_payload;
  }
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.result !== undefined &&
    typeof payload.result === "object" &&
    !Array.isArray(payload.result) &&
    typeof payload.result.app === "string"
  ) {
    payload = payload.result;
  }

  const v = validateResult(payload);
  if (v.error) reject(v.error);
  const r = v.value;

  mkdirSync(RESULTS, { recursive: true });
  const day = todayUtcPrefix();
  const used = countTodayForApp(r.app, day);
  if (used >= QUOTA_N) reject(`daily quota reached (${used}/${QUOTA_N} for app=${r.app})`);

  const id = ulid();
  const createdAt = formatCreatedAt();
  const row = toStoredRow(id, createdAt, r);
  const file = path.join(RESULTS, `${id}.json`);
  writeFileSync(file, JSON.stringify(row, null, 2) + "\n");
  const n = regenerateLeaderboard();
  console.log(`ACCEPT: wrote results/${id}.json createdAt=${createdAt} leaderboard=${n} rows`);
  // Emit for the workflow commit step
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `id=${id}\nfile=results/${id}.json\n`, { flag: "a" });
  }
}

// Allow importing helpers from tests without running main.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error("INGEST ERROR:", err);
    process.exit(1);
  }
}
