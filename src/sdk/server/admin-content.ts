import type { Context, Hono } from "hono";
import type { BlankSchema, Env } from "hono/types";
import { loadAdminLockPubkeyState } from "./admin-auth-state";
import { verifyAdminAuth } from "./admin-cashu";
import type { ConsumedCredentialStore } from "./consumed-credential-store";
import { baselineContentExpiry, contentMetadata, ContentHoldError, isContentHoldStore, type ContentHoldMutation } from "./content-retention";
import type { JobStore } from "./job-store";
import type { LockPubkeyStateLoader } from "./lock-pubkey-store";

export interface InstallAdminContentRoutesOpts {
  dvmId: string;
  store: JobStore;
  retentionDays: number;
  getLockPubkeyState: LockPubkeyStateLoader;
  nonceStore: ConsumedCredentialStore;
  now?: () => number;
}

export function installAdminContentRoutes<E extends Env = Env, S extends BlankSchema = BlankSchema>(app: Hono<E, S>, opts: InstallAdminContentRoutesOpts): void {
  app.get("/admin/jobs/:jobId/content-holds", (c) => handle(c, opts));
  app.post("/admin/jobs/:jobId/content-holds", (c) => handle(c, opts, "placed"));
  app.post("/admin/jobs/:jobId/content-holds/:holdId/renew", (c) => handle(c, opts, "renewed"));
  app.post("/admin/jobs/:jobId/content-holds/:holdId/clear", (c) => handle(c, opts, "cleared"));
}

async function handle(c: Context, opts: InstallAdminContentRoutesOpts, action?: ContentHoldMutation["action"]): Promise<Response> {
  const loaded = await loadAdminLockPubkeyState(c, opts);
  if ("response" in loaded) return loaded.response;
  const auth = await verifyAdminAuth({
    authHeader: c.req.header("Authorization"), method: c.req.method, path: c.req.path,
    dvmId: opts.dvmId, acceptedPubkeys: [loaded.state.current, ...loaded.state.retired.map((item) => item.pubkey)],
    nonceStore: opts.nonceStore, now: opts.now,
  });
  if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
  if (!isContentHoldStore(opts.store) || !opts.nonceStore.consume) {
    return c.json({ error: "content_holds_unavailable", message: "This service requires a content-hold store and atomic admin nonce store." }, 503);
  }
  const jobId = c.req.param("jobId") ?? "";
  const at = opts.now?.() ?? Date.now();
  try {
    if (action) {
      let body: Record<string, unknown>;
      try { body = await c.req.json(); } catch { return c.json({ error: "invalid_body", message: "Send a JSON object." }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
      const allowed = action === "placed" ? ["purpose", "reason", "review_due_at"] : action === "renewed" ? ["reason", "review_due_at"] : ["reason"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) return c.json({ error: "invalid_body", message: "Only purpose, reason and review_due_at are accepted as applicable; identity and times are server-derived." }, 400);
      if (typeof body.reason !== "string" || body.reason.trim().length === 0 || body.reason.length > 1000) return c.json({ error: "invalid_reason", message: "reason must contain 1..1000 characters." }, 400);
      if (action !== "cleared" && (!Number.isSafeInteger(body.review_due_at) || (body.review_due_at as number) <= at)) return c.json({ error: "invalid_review_due_at", message: "review_due_at must be a future epoch millisecond integer." }, 400);
      const base = { reason: body.reason.trim(), actor: auth.actor, at };
      let mutation: ContentHoldMutation;
      if (action === "placed") {
        if (body.purpose !== "support" && body.purpose !== "dispute") return c.json({ error: "invalid_purpose" }, 400);
        mutation = { ...base, action, purpose: body.purpose, review_due_at: body.review_due_at as number };
      } else if (action === "renewed") {
        mutation = { ...base, action, hold_id: c.req.param("holdId") ?? "", review_due_at: body.review_due_at as number };
      } else mutation = { ...base, action, hold_id: c.req.param("holdId") ?? "" };
      await opts.store.mutateContentHold(jobId, mutation, opts.dvmId);
    }
    const snapshot = await opts.store.getContentSnapshot(jobId, opts.dvmId);
    if (!snapshot) return c.json({ error: "job_not_found" }, 404);
    return c.json({
      job_id: jobId, ...contentMetadata(snapshot.job, opts.retentionDays, snapshot.history.holds),
      baseline_content_expires_at: baselineContentExpiry(snapshot.job, opts.retentionDays),
      holds: snapshot.history.holds.map((hold) => ({ ...hold, review_overdue: hold.cleared_at === null && hold.review_due_at <= at })),
      events: snapshot.history.events,
    }, action === "placed" ? 201 : 200);
  } catch (error) {
    if (error instanceof ContentHoldError) return c.json({ error: error.code }, error.code === "job_not_found" ? 404 : 409);
    throw error;
  }
}
