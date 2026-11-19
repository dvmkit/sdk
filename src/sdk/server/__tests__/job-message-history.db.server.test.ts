import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "../../../lib/messages/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { PostgresJobStore } from "../postgres-job-store";
import { contentJob, TOKEN } from "./__helpers__/content-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const run = !!databaseUrl && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(databaseUrl);
const sampleCount = 7;

interface ReadTiming {
  queryMs: number;
  headersMs: number;
  bodyMs: number;
  bytes: number;
}

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function summarize(runs: ReadTiming[][]) {
  return {
    responses: runs[0].length,
    queryMs: median(runs.map(run => run.reduce((sum, read) => sum + read.queryMs, 0))),
    headersMs: median(runs.map(run => run.reduce((sum, read) => sum + read.headersMs, 0))),
    bodyMs: median(runs.map(run => run.reduce((sum, read) => sum + read.bodyMs, 0))),
    maxBodyBytes: Math.max(...runs.flat().map(read => read.bytes)),
  };
}

describe.skipIf(!run)("artifact-heavy job history over HTTP and Postgres", () => {
  const schema = `messages_${randomUUID().replaceAll("-", "")}`;
  const servers = servedApps();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("delivers the complete archived transcript in bounded pages", async () => {
    const job = contentJob("message-history");
    const history: Message[] = Array.from({ length: 566 }, (_, index) => {
      const base = { seq: index + 1, from: "provider" as const, timestamp: 1_700_000_000 + index };
      if (index === 565) return { ...base, type: "complete", content: { summary: "Done" } };
      // Interleave 340 artifacts throughout the transcript. Repeated bytes would compress away the payload.
      if ((index * 340) % 565 < 340) {
        return { ...base, type: "artifact", content: {
          mime_type: "image/jpeg", encoding: "base64", data: randomBytes(17_350).toString("base64"),
        } };
      }
      return { ...base, type: "text", content: { text: "Progress" } };
    });
    await store.save({ ...job, messages: history, seq: history.length });
    const runtime = await createDVMServer(configureDVM({
      name: "example", capability: "work", jobRetentionDays: 0, onJob() {},
    }), { env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true });
    try {
      const url = await servers.serve(runtime.app);
      let queryMs = 0;
      const select = store.getMessages.bind(store);
      vi.spyOn(store, "getMessages").mockImplementation(async (...args) => {
        const start = performance.now();
        try {
          return await select(...args);
        } finally {
          queryMs += performance.now() - start;
        }
      });

      async function readHistory(limit?: number): Promise<ReadTiming[]> {
        const times: ReadTiming[] = [];
        const received: Message[] = [];
        let after = 0;
        const requests = limit === undefined ? 1 : Math.ceil(history.length / limit);
        for (let page = 0; page < requests; page++) {
          const query = limit === undefined ? "" : `?limit=${limit}&after=${after}`;
          queryMs = 0;
          const start = performance.now();
          const response = await fetch(`${url}/v1/job/${job.id}/messages${query}`, { headers: { "X-Job-Token": TOKEN } });
          const headers = performance.now();
          const bytes = await response.arrayBuffer();
          times.push({ queryMs, headersMs: headers - start, bodyMs: performance.now() - headers, bytes: bytes.byteLength });
          expect(response.status).toBe(200);
          const result = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
            messages: Message[]; next_after?: number; has_more?: boolean;
          };
          if (limit !== undefined) {
            expect(result.messages.length).toBeLessThanOrEqual(limit);
            expect(result.has_more).toBe(page + 1 < requests);
            expect(result.next_after).toBe(result.messages.at(-1)?.seq);
            after = result.next_after!;
          }
          received.push(...result.messages);
        }
        expect(received).toEqual(history);
        return times;
      }

      await readHistory();
      await readHistory(50);
      const full: ReadTiming[][] = [];
      const paged: ReadTiming[][] = [];
      for (let i = 0; i < sampleCount; i++) {
        full.push(await readHistory());
        paged.push(await readHistory(50));
      }
      const report = JSON.stringify({
        samples: sampleCount,
        full: summarize(full),
        firstPage: summarize(paged.map(run => run.slice(0, 1))),
        allPages: summarize(paged),
      });
      const label = process.env.GITHUB_ACTIONS === "true"
        ? "::notice title=Message history benchmark::"
        : "Message history benchmark ";
      process.stdout.write(`${label}${report}\n`);
    } finally {
      await runtime.shutdown();
    }
  }, 60_000);
});
