/** Probe NUT-06 directly for capability fields not typed by cashu-ts loadMint. */

import { DvmError } from "../errors";

/**
 * NUT capabilities dvmkit requires every mint to advertise at the dict level
 * in `/v1/info.nuts`. Used by `assertNutSupport` at SDK boot and CLI wallet
 * creation.
 *
 * These are the NUTs a mint must explicitly enumerate — i.e. its own
 * server-side capabilities. Three NUTs that are commonly confused with this
 * group are deliberately absent:
 *
 * - **NUT-3 (swap)** — baseline mint operation. Every compliant mint implements
 * `/swap`; it is never enumerated in `/v1/info.nuts`.
 * - **NUT-13 (deterministic secrets)** — client-side wallet spec. The mint only
 * needs to support NUT-9 (`/v1/restore`) for client-side derivation to work;
 * NUT-13 itself has no mint-side advertisement surface.
 * - **NUT-23 (BOLT11 method)** — method-level capability nested inside NUT-4 /
 * NUT-5 `methods` arrays. Checked separately by `assertNutSupport` via
 * `hasBolt11Sat`.
 *
 * NUTs in this list:
 * - NUT-4: mint quotes (bolt11 → ecash)
 * - NUT-5: melt quotes (ecash → bolt11)
 * - NUT-7: checkstate (spent/unspent verification)
 * - NUT-9: restore endpoint (needed for NUT-13 client-side deterministic restore)
 * - NUT-10: well-known secret format (prerequisite for NUT-11 P2PK)
 * - NUT-11: P2PK lock — the entire lock-target design depends on this
 * - NUT-20: signed mint quotes (prevents third-party quote-ID hijack)
 */
export const DEFAULT_REQUIRED_NUTS = [4, 5, 7, 9, 10, 11, 20] as const;

/**
 * Per-method amount limits a mint advertises on its NUT-4 / NUT-5 bolt11/sat
 * entry. Both values are in the method's own unit — `sat` here,
 * never msats.
 *
 * `null` means the mint advertised nothing in that direction, which reads as
 * unbounded. A mint saying nothing is not a mint saying zero, so silence never
 * narrows what we'll attempt — same defensive posture as the absent-`disabled`
 * rule in {@link canMintBolt11Sat}.
 */
export interface MintAmountBounds {
  /** Smallest amount the mint will quote, or `null` when unadvertised. */
  minSats: number | null;
  /** Largest amount the mint will quote, or `null` when unadvertised. */
  maxSats: number | null;
}

export type HealthErrorCode =
  | "timeout"
  | "http_error"
  | "network"
  | "parse_error"
  | "missing_fields";

export interface MintHealthCheckResult {
  /** Mint URL exactly as passed in (not normalised). */
  mintUrl: string;
  /** True iff `/v1/info` returned 200, parsed as JSON, and had `pubkey` + `version`. */
  ok: boolean;
  /** Wall-clock duration of the successful (or final failed) attempt in ms. */
  latencyMs: number;
  pubkey?: string;
  version?: string;
  /** Sorted list of NUT keys the mint declares support for. */
  supportedNuts?: string[];
  /** Subset of `DEFAULT_REQUIRED_NUTS` the mint does not declare. Empty array when fully supported. */
  missingRequiredNuts?: string[];
  /** True when the mint advertises NUT-04 with method `bolt11` and unit `sat`. */
  bolt11SatMintSupported?: boolean;
  /** True when the mint advertises NUT-05 with method `bolt11` and unit `sat`. */
  bolt11SatMeltSupported?: boolean;
  /**
   * True when the mint can currently *issue* — NUT-04 advertises bolt11/sat and
   * is not switched off (`disabled: true`). Distinct from
   * {@link bolt11SatMintSupported}, which only asks whether the method exists:
   * a mint in melt-only recovery keeps advertising the method and turns the
   * flag on. Consulted when picking a funding default.
   */
  mintingEnabled?: boolean;
  /** Same question for NUT-05 (melt) — whether the mint can currently pay out. */
  meltingEnabled?: boolean;
  /**
   * True when the mint can currently serve `/v1/swap` — see {@link canSwap} for
   * why an unadvertised NUT-3 reads as `true`. This is what a per-call spend
   * needs, so a `false` here is the reason a spend routes around this mint
   */
  swapEnabled?: boolean;
  /**
   * Amount limits the mint advertises for issuing (NUT-04 bolt11/sat), in sats
   * Consulted when picking a funding default and when refusing an
   * amount locally, so a fund outside the range never opens a Lightning quote.
   */
  mintAmountBounds?: MintAmountBounds;
  /** The NUT-05 twin — limits on a single payout, which `dvm wallet cash-out` sizes against. */
  meltAmountBounds?: MintAmountBounds;
  /**
   * True when the mint passes the full {@link assertNutSupport} gate — every
   * required NUT present (not `supported: false`) and bolt11/sat on NUT-4 +
   * NUT-5. The runtime `MintHealthTracker` treats a mint as healthy only when
   * this is true, reproducing the boot-time NUT gate post-`listen`.
   */
  nutCompliant?: boolean;
  /** Raw `nuts` object from the `/v1/info` response. Used by `assertNutSupport`. */
  nutsRaw?: Record<string, unknown>;
  /** Populated when `ok` is false. */
  error?: { code: HealthErrorCode; message: string };
}

export interface CheckMintHealthOptions {
  /** Per-attempt timeout in ms. Default: 5000. */
  timeoutMs?: number;
  /** Total attempts including the first. Default: 3. */
  retries?: number;
  /** Inter-attempt backoff schedule in ms. Default: [200, 500, 1000]. */
  backoffMs?: number[];
  /** Injected `fetch` for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Probe a Cashu mint's `/v1/info` endpoint with timeout + retries, and
 * report whether it serves the NUT-04 + NUT-05 capabilities first-party DVMs
 * depend on. Never throws — failures are returned as `{ ok: false, error }`.
 */
export async function checkMintHealth(
  mintUrl: string,
  opts?: CheckMintHealthOptions
): Promise<MintHealthCheckResult> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const retries = opts?.retries ?? 3;
  const backoff = opts?.backoffMs ?? [200, 500, 1000];
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const url = mintUrl.replace(/\/+$/, "") + "/v1/info";
  let lastError: { code: HealthErrorCode; message: string } | undefined;
  let lastLatency = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
      await sleep(delay);
    }
    const startedAt = Date.now();
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      lastLatency = Date.now() - startedAt;
      if (!res.ok) {
        lastError = { code: "http_error", message: `HTTP ${res.status}` };
        continue;
      }
      let info: unknown;
      try {
        info = await res.json();
      } catch (err) {
        lastError = {
          code: "parse_error",
          message: err instanceof Error ? err.message : String(err),
        };
        continue;
      }
      return parseInfo(mintUrl, info, lastLatency);
    } catch (err) {
      lastLatency = Date.now() - startedAt;
      lastError = classifyFetchError(err);
    }
  }

  return {
    mintUrl,
    ok: false,
    latencyMs: lastLatency,
    error: lastError ?? { code: "network", message: "no attempts recorded" },
  };
}

function parseInfo(mintUrl: string, info: unknown, latencyMs: number): MintHealthCheckResult {
  if (!isRecord(info)) {
    return {
      mintUrl,
      ok: false,
      latencyMs,
      error: { code: "parse_error", message: "/v1/info response is not an object" },
    };
  }
  const pubkey = typeof info.pubkey === "string" ? info.pubkey : undefined;
  const version = typeof info.version === "string" ? info.version : undefined;
  if (!pubkey || !version) {
    const missing: string[] = [];
    if (!pubkey) missing.push("pubkey");
    if (!version) missing.push("version");
    return {
      mintUrl,
      ok: false,
      latencyMs,
      pubkey,
      version,
      error: {
        code: "missing_fields",
        message: `NUT-06 missing required fields: ${missing.join(", ")}`,
      },
    };
  }

  const nutsRaw = isRecord(info.nuts) ? info.nuts : {};
  const supportedNuts = Object.keys(nutsRaw).sort(byNutKey);
  const missingRequiredNuts = DEFAULT_REQUIRED_NUTS.map(String).filter((n) => !(n in nutsRaw));
  const bolt11SatMintSupported = hasBolt11Sat(nutsRaw["4"]);
  const bolt11SatMeltSupported = hasBolt11Sat(nutsRaw["5"]);

  return {
    mintUrl,
    ok: true,
    latencyMs,
    pubkey,
    version,
    supportedNuts,
    missingRequiredNuts,
    bolt11SatMintSupported,
    bolt11SatMeltSupported,
    mintingEnabled: canMintBolt11Sat(nutsRaw),
    meltingEnabled: canMeltBolt11Sat(nutsRaw),
    swapEnabled: canSwap(nutsRaw),
    mintAmountBounds: mintAmountBounds(nutsRaw),
    meltAmountBounds: meltAmountBounds(nutsRaw),
    nutCompliant: evaluateNutSupport(nutsRaw).ok,
    nutsRaw: nutsRaw,
  };
}

/**
 * Whether the mint can currently issue ecash against a bolt11/sat quote —
 * NUT-04 carries the method **and** is not switched off.
 *
 * Deliberately separate from {@link evaluateNutSupport}: a mint in melt-only
 * recovery (NUT-04 `disabled: true`, NUT-05 live) must still load through
 * `getWallet`, or the one operation it can still serve — melting the balance
 * back out — becomes unreachable. So `disabled` informs mint *selection*, never
 * the boot-time gate.
 *
 * An absent `disabled` key reads as enabled. Nutshell emits `disabled: false`
 * explicitly, but the field is optional in NUT-04 and a mint omitting it is
 * saying nothing about being switched off — reading silence as "incapable"
 * would rule out working mints.
 */
export function canMintBolt11Sat(nuts: Record<string, unknown>): boolean {
  return isMethodEnabled(nuts["4"]);
}

/** Whether the mint can currently pay a bolt11/sat invoice — the NUT-05 twin of {@link canMintBolt11Sat}. */
export function canMeltBolt11Sat(nuts: Record<string, unknown>): boolean {
  return isMethodEnabled(nuts["5"]);
}

/**
 * Whether the mint can currently serve `/v1/swap` — the operation every
 * per-call Cashu payment depends on.
 *
 * **An absent NUT-3 means yes.** Swap is a baseline mint operation and healthy
 * mints do not enumerate it — neither coinos nor lnvoltz advertises a `"3"` key.
 * Reading silence as "incapable" would rule out every working mint.
 *
 * A mint that has *switched swaps off* does say so: a mint in melt-only
 * recovery publishes a `"3"` entry flagged `disabled` / `supported: false`
 * alongside its live NUT-5. Both spellings are honoured because this is the
 * only signal distinguishing "can't swap" from "swap failed for some other
 * reason", and it costs nothing to accept either.
 *
 * Never a boot-time gate — like {@link canMintBolt11Sat}, this informs mint
 * *selection* only, so a mint that can still melt stays loadable for cash-out.
 */
export function canSwap(nuts: Record<string, unknown>): boolean {
  const node = nuts["3"];
  if (!isRecord(node)) return true;
  if (node.disabled === true) return false;
  return node.supported !== false;
}

function isMethodEnabled(node: unknown): boolean {
  if (!hasBolt11Sat(node)) return false;
  return (node as Record<string, unknown>).disabled !== true;
}

/**
 * Amount limits the mint advertises for issuing against a bolt11/sat quote —
 * NUT-04's `min_amount` / `max_amount` on the matching method entry.
 *
 * Kept out of {@link evaluateNutSupport} for the same reason `disabled` is: an
 * amount-dependent question has no business in the per-mint boot gate
 * `getWallet` runs, and folding it in would make the balance already sitting at
 * a narrowly-bounded mint unreachable. Bounds inform mint *selection* and a
 * pre-quote refusal, never whether a mint loads.
 *
 * An unreadable or negative value reads as unadvertised, i.e. unbounded — the
 * mint may still refuse, which is the failure we had before. An explicit `0` is
 * honoured as written: `min_amount: 0` is what real mints emit.
 */
export function mintAmountBounds(nuts: Record<string, unknown>): MintAmountBounds {
  return boundsOf(nuts["4"]);
}

/** The NUT-05 (melt) twin of {@link mintAmountBounds} — limits on one payout. */
export function meltAmountBounds(nuts: Record<string, unknown>): MintAmountBounds {
  return boundsOf(nuts["5"]);
}

/** Whether `sats` falls inside a mint's advertised limits, and which end it broke. */
export type AmountBoundsVerdict = "ok" | "below_min" | "above_max";

/**
 * Judge one amount against one direction's limits. The single predicate both
 * `dvm wallet fund` (mint selection, pre-quote refusal) and
 * `dvm wallet cash-out` (per-leg sizing) ask, so the two commands can't drift
 * on what "out of range" means.
 */
export function amountBoundsVerdict(sats: number, bounds?: MintAmountBounds): AmountBoundsVerdict {
  if (!bounds) return "ok";
  if (bounds.minSats !== null && sats < bounds.minSats) return "below_min";
  if (bounds.maxSats !== null && sats > bounds.maxSats) return "above_max";
  return "ok";
}

function boundsOf(node: unknown): MintAmountBounds {
  const method = findBolt11Sat(node);
  return {
    minSats: method ? toBoundSats(method.min_amount) : null,
    maxSats: method ? toBoundSats(method.max_amount) : null,
  };
}

/**
 * Coerce an advertised bound to whole sats, or `null` when the mint said
 * nothing usable. cashu-ts types these as `number | bigint | string`, so accept
 * all three rather than reading a large `max_amount` sent as a string as absent.
 */
function toBoundSats(value: unknown): number | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  // `Number("")` is 0 — an empty string is a mint saying nothing, not zero.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export interface NutSupportResult {
  /** True when every required NUT is present and NUT-4/NUT-5 carry bolt11/sat. */
  ok: boolean;
  /** Required NUTs absent or `supported: false`. Undefined when none missing. */
  missingNuts?: number[];
  /** NUT-4 (`mint`) / NUT-5 (`melt`) lacking a bolt11/sat method. Undefined when none. */
  missingBolt11?: ("mint" | "melt")[];
}

/**
 * Non-throwing form of {@link assertNutSupport}. Runs the same two-phase check
 * dict-level required NUTs (present and not `supported: false`) plus
 * method-level bolt11/sat on NUT-4 + NUT-5 — and returns a structured verdict.
 * The runtime `MintHealthTracker` uses this to gate mint health without
 * throwing for control flow; `assertNutSupport` builds on it.
 */
export function evaluateNutSupport(
  nuts: Record<string, unknown>,
  requiredNuts: readonly number[] = DEFAULT_REQUIRED_NUTS
): NutSupportResult {
  const missingNuts = requiredNuts.filter((n) => {
    const entry = nuts[String(n)];
    if (entry === undefined || entry === null) return true;
    return typeof entry === "object" && (entry as Record<string, unknown>).supported === false;
  });
  const missingBolt11: ("mint" | "melt")[] = [];
  if (!hasBolt11Sat(nuts["4"])) missingBolt11.push("mint");
  if (!hasBolt11Sat(nuts["5"])) missingBolt11.push("melt");
  return {
    ok: missingNuts.length === 0 && missingBolt11.length === 0,
    missingNuts: missingNuts.length > 0 ? [...missingNuts] : undefined,
    missingBolt11: missingBolt11.length > 0 ? missingBolt11 : undefined,
  };
}

/**
 * Assert that a mint's NUT-06 `nuts` object advertises all required capabilities.
 * Two-phase check:
 * 1. Dict-level — each NUT in `requiredNuts` must be present and not have
 * `supported: false`. Throws naming the missing NUT numbers and mint URL.
 * 2. Method-level — NUT-4 and NUT-5 must each advertise a `bolt11`/`sat`
 * entry in their `methods` array (covers NUT-23). Throws naming the
 * missing method.
 */
export function assertNutSupport(
  mintUrl: string,
  nuts: Record<string, unknown>,
  requiredNuts: readonly number[] = DEFAULT_REQUIRED_NUTS
): void {
  const verdict = evaluateNutSupport(nuts, requiredNuts);
  if (verdict.missingNuts && verdict.missingNuts.length > 0) {
    throw new DvmError(
      "cashu_nut_support_missing",
      `Mint ${mintUrl} does not support required NUTs: ${verdict.missingNuts.join(", ")}. ` +
        `Required: ${requiredNuts.join(", ")}.`,
      "Choose a mint that supports all required NUT capabilities for P2PK-locked Cashu payments."
    );
  }
  if (verdict.missingBolt11?.includes("mint")) {
    throw new DvmError(
      "cashu_nut_support_missing",
      `Mint ${mintUrl} does not advertise bolt11/sat method on NUT-4 (mint quotes).`,
      "Choose a mint that advertises bolt11/sat on NUT-4 mint quotes."
    );
  }
  if (verdict.missingBolt11?.includes("melt")) {
    throw new DvmError(
      "cashu_nut_support_missing",
      `Mint ${mintUrl} does not advertise bolt11/sat method on NUT-5 (melt quotes).`,
      "Choose a mint that advertises bolt11/sat on NUT-5 melt quotes."
    );
  }
}

function hasBolt11Sat(node: unknown): boolean {
  return findBolt11Sat(node) !== undefined;
}

/**
 * The bolt11/sat entry from a NUT-4 / NUT-5 `methods` array, or `undefined`.
 * The one place either NUT's method list is read, so the capability question
 * ("is it there?") and the limits question ("what will it take?") can never
 * disagree about which entry they're describing.
 */
function findBolt11Sat(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  const methods = node.methods;
  if (!Array.isArray(methods)) return undefined;
  return methods.find((m) => isRecord(m) && m.method === "bolt11" && m.unit === "sat") as
    | Record<string, unknown>
    | undefined;
}

function classifyFetchError(err: unknown): { code: HealthErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { code: "timeout", message };
    }
  }
  return { code: "network", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byNutKey(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.localeCompare(b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
