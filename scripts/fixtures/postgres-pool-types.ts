import { createDVMHost, createPostgresStripeCheckoutStore, PostgresJobStore } from "@dvmkit/sdk/server";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type StorePool = ConstructorParameters<typeof PostgresJobStore>[0];
type HostPool = NonNullable<NonNullable<Parameters<typeof createDVMHost>[0]>["pool"]>;
type CheckoutPool = Parameters<typeof createPostgresStripeCheckoutStore>[0];

export type StorePoolIsChecked = AssertFalse<IsAny<StorePool>>;
export type HostPoolIsChecked = AssertFalse<IsAny<HostPool>>;
export type CheckoutPoolIsChecked = AssertFalse<IsAny<CheckoutPool>>;
export type PoolQueryIsChecked = AssertFalse<IsAny<StorePool["query"]>>;

declare const pool: StorePool;
export const store = new PostgresJobStore(pool);
export const checkout = createPostgresStripeCheckoutStore(pool);
export const hostPool: HostPool = pool;
const result = await pool.query<{ value: number }>("SELECT 1 AS value");
export const value: number | undefined = result.rows[0]?.value;

// @ts-expect-error A pool must provide PostgreSQL operations.
new PostgresJobStore({});
// @ts-expect-error Queries require SQL text or a query configuration.
pool.query(123);
// @ts-expect-error The declared query row has a numeric value.
export const text: string | undefined = result.rows[0]?.value;
