# Runnable examples

These examples import only the three supported public entry points. From a clone of this repository, run `npm ci`, `npm run build`, then `npm run test:examples`.

- [`quickstart`](./quickstart) is the smallest free DVM, its local server, and a handler unit test.
- [`authenticated-route`](./authenticated-route) uses descriptor-level signed-request auth and verifies a signed custom HTTP route.
- [`payments-and-lifecycle`](./payments-and-lifecycle) covers static upfront pricing, a mid-job payment request, startup validation, and shutdown cleanup without real credentials or money.

All secrets and payments in these examples are deterministic test values. Production deployments need Postgres, durable replay protection, monitored payment rails, and the reclaim operations described in the [public SDK guide](https://dvmkit.com/docs/sdk).
