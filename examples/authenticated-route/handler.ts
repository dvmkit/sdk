import { configureDVM, createSignedRequestVerifier, SignedRequestError, z } from "@dvmkit/sdk";
import { secp256k1Auth } from "@dvmkit/sdk/server";

export const signedEchoSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

export default configureDVM({
  name: "signed-echo",
  capability: "echo",
  input: signedEchoSchema,
  auth: secp256k1Auth(),
  onJob(ctx) {
    ctx.complete(`Authenticated ${ctx.auth?.pubkey.slice(0, 8) ?? "unknown"}`);
  },
  routes(app, { authAudience }) {
    if (!authAudience) throw new Error("signed custom route requires an auth audience");
    const verifier = createSignedRequestVerifier(signedEchoSchema);
    app.post("/private/echo", async (c) => {
      try {
        const verified = verifier.checkAuth(await c.req.json(), {
          audience: authAudience,
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          capability: null,
        });
        await verifier.recordReplay(verified);
        return c.json({ text: verified.text, caller: verified.pubkey });
      } catch (error) {
        if (error instanceof SignedRequestError) {
          return c.json({ error: error.code, sub_reason: error.sub_reason }, 401);
        }
        throw error;
      }
    });
  },
});
