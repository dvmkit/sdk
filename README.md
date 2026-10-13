# @dvmkit/sdk

Build Digital Vending Machines: pay-per-use HTTPS services that AI agents can find, pay, and call with no account or API key.

Pre-1.0 alpha: breaking changes are announced in the [release notes](./CHANGELOG.md); pin the version you install.

## Requirements

Node.js 22.18 or later for the TypeScript quickstart.

## Install

Create a project and install the current release, recording its exact version:

```sh
mkdir hello-dvm && cd hello-dvm
npm init -y
npm pkg set type=module
npm install --save-exact @dvmkit/sdk
```

## Quickstart: a free DVM

Save this as `handler.ts`:

```ts
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
```

Save this as `server.ts`:

```ts
import { serve } from "@dvmkit/sdk/server";

import dvm from "./handler.ts";

const server = await serve(dvm, { devMode: true });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
```

Start the server:

```sh
node server.ts
```

Leave it running. In another terminal, submit a job:

```sh
curl -sS http://localhost:8080/v1/job \
  -H 'content-type: application/json' \
  --data '{"capability":"echo","data":{"text":"hello"}}'
```

The response includes a generated `job_id` and `job_token`, `"status":"completed"`, and `"summary":"Echoed the input"`. The server listens at `http://localhost:8080`; stop it with Ctrl-C. `devMode` lets this free example run without Postgres.

The files above are copied verbatim from [`examples/quickstart`](./examples/quickstart). See the runnable [authenticated custom route](./examples/authenticated-route) and [payments and lifecycle](./examples/payments-and-lifecycle) examples for the next step.

## What's in the package

| Import | Purpose |
| --- | --- |
| `@dvmkit/sdk` | DVM descriptors, handler context, bundled Zod, pricing, signing, and safe-fetch helpers |
| `@dvmkit/sdk/server` | Node hosting, Postgres stores, signed-request auth, and payment infrastructure |
| `@dvmkit/sdk/testing` | Deterministic handler contexts and in-memory stores |

`@dvmkit/sdk/internal` also exists for the dvmkit platform; it has no stability promise and can change in any release.

The generated [API reference](./docs/API.md) lists the supported declarations. Deep imports from `dist/` are unsupported.

## Next steps

- [SDK guide](https://dvmkit.com/docs/sdk): add authentication, custom routes, payments, and persistence.
- [Protocol guide](https://dvmkit.com/docs/protocol): understand the HTTP contract callers use.
- [Builder guide](https://dvmkit.com/docs/build): scaffold and deploy a service; install the builder CLI with `npm install --global @dvmkit/dvmctl`.

[Operating a DVM](./docs/OPERATING.md) covers production setup, verified development payments, credit liabilities, diagnostics, retention, content holds, and financial exports. [Protocol notes](./docs/PROTOCOL-NOTES.md) cover compatibility, job credentials, identity, terminal evidence, costs, and rate cards.

## Contributing

Issues and discussions are welcome. Unsolicited pull requests are closed; read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

## Security

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Support

Use [SUPPORT.md](./SUPPORT.md) to find the right place for questions and bug reports.

## Trademarks

The Apache License grants no rights in the dvmkit name or branding; identify your own products and forks without implying endorsement.
Permission requests go through [support](./SUPPORT.md#email); descriptive use of “digital vending machine” or “DVM” is not restricted.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
