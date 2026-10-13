import { configureDVM, z } from "@dvmkit/sdk";

export const lifecycle = { boots: 0, shutdowns: 0 };
const inputSchema = z.object({ units: z.number().int().positive() });

export default configureDVM({
  name: "metered-work",
  capability: "process",
  input: inputSchema,
  price: "$0.01",
  onBoot(env) {
    if (env.PROVIDER_MODE !== "example") throw new Error("Set PROVIDER_MODE=example");
    lifecycle.boots += 1;
  },
  async onJob(ctx) {
    await ctx.requestPayment(
      { amount: ctx.input.units * 0.002, currency: "usd" },
      "Usage above the upfront allowance"
    );
    ctx.cost({ amount: ctx.input.units * 0.0005, currency: "usd" });
    ctx.complete(`Processed ${ctx.input.units} units`);
  },
  onShutdown() {
    lifecycle.shutdowns += 1;
  },
});
