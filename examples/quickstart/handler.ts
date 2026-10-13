import { configureDVM, z } from "@dvmkit/sdk";

export const inputSchema = z.object({ text: z.string().min(1) });

export default configureDVM({
  name: "hello",
  description: "Return the supplied text",
  capability: "echo",
  input: inputSchema,
  example: { text: "hello" },
  async onJob(ctx) {
    ctx.artifact({ mime_type: "text/plain", data: ctx.input.text });
    ctx.complete("Echoed the input");
  },
});
