/**
 * The subset of Hono's request object these helpers need. Structural rather
 * than `HonoRequest` so both runtimes' `Context` generics pass without either
 * side importing the other's env type.
 */
export interface JobCredentialRequest {
  header(name: string): string | undefined;
}

/**
 * the credential gate on a runtime's `/v1/job/:id/*` routes — the
 * "did this request present anything?" predicate and the 401 body that answers
 * when it didn't, built together so the copy can never describe a credential
 * the predicate doesn't accept.
 */
export interface JobCredentialGate {
  /** Did this request present *any* credential this runtime accepts? */
  presents(req: JobCredentialRequest): boolean;
  /** The flat 401 body for a request that presented none. */
  body(): Record<string, unknown>;
}

/**
 * build the credential gate for one runtime.
 *
 * `acceptsBearer` is what separates them. The isolate tier derives
 * `requesterId` from `Authorization: Bearer`, so a Bearer token really is a
 * job credential there. The SDK server does not — its auth middleware pins
 * `requesterId` to `anonymous`/`dev-anonymous`, so every SDK job is gated on
 * the `X-Job-Token` and a Bearer header proves nothing. Counting it
 * anyway would send a stale client that happens to send one back to the
 * opaque 404 this exists to eliminate.
 *
 * A request carrying no accepted credential can be refused before the job is
 * ever looked up, which is what makes {@link JobCredentialGate.body} safe to
 * be specific about — the 404-not-403 choice on a *failed* ownership check is
 * deliberate (a wrong credential must never confirm a job id exists),
 * and that property is untouched here because this body is returned before any
 * store lookup, identical whether or not the job exists.
 *
 * Shared by `src/sdk/server/app.ts` and the isolate routes so the two runtimes
 * answer identically by construction rather than by comment.
 */
export function jobCredentialGate(opts: { acceptsBearer: boolean }): JobCredentialGate {
  const alternative = opts.acceptsBearer
    ? ", or the Authorization: Bearer token the job was submitted with"
    : "";
  return {
    presents(req) {
      if (req.header("X-Job-Token")) return true;
      if (!opts.acceptsBearer) return false;
      return req.header("Authorization")?.startsWith("Bearer ") === true;
    },
    body() {
      return {
        error: "job_credential_required",
        message: `This job requires the X-Job-Token returned by POST /v1/job${alternative}.`,
        // Cause-neutral on purpose: the stale client that motivated this
        // (2026-06-29, paid jobs whose results were unretrievable behind an
        // opaque 404) is only one of two ways to get here — a current client
        // reading a job whose local state has no token gets the same refusal,
        // and an upgrade alone would be a dead end for them. `display` is relayed
        // to a human verbatim, so the conditional advice lives in `hint`, which
        // is what the agent acts on.
        display: "Couldn't retrieve your result — the request was missing its job credential.",
        hint: `Send the job_token from the POST /v1/job response as the X-Job-Token header${alternative}. The token is minted once, at submit, and the DVM cannot reissue it — a job submitted from another machine, or by a caller that never stored it, can't be read here. If your caller never sends X-Job-Token at all, upgrade: npm i -g @dvmkit/dvm-cli@0.2.0, then retry the same command with --endpoint <url> --job-token <hex> (or set DVM_JOB_ENDPOINT and DVM_JOB_TOKEN).`,
      };
    },
  };
}
