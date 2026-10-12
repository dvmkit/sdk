// A local npm registry for the SDK whose version listing carries the public registry's five-minute
// freshness lifetime. It runs as a child process so synchronous npm installs in a test can reach it.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const { REGISTRY_INTEGRITY, REGISTRY_REQUEST_LOG, REGISTRY_STATE, REGISTRY_TARBALLS } = process.env;
if (!REGISTRY_INTEGRITY || !REGISTRY_REQUEST_LOG || !REGISTRY_STATE || !REGISTRY_TARBALLS) {
  throw new Error("stale registry configuration is incomplete");
}
/** @type {Record<string, string>} */
const integrity = JSON.parse(REGISTRY_INTEGRITY);
const listingPaths = new Set(["/@dvmkit%2fsdk", "/@dvmkit%2Fsdk", "/@dvmkit/sdk"]);

const server = createServer((request, response) => {
  const origin = `http://${request.headers.host}`;
  if (listingPaths.has(request.url ?? "")) {
    appendFileSync(REGISTRY_REQUEST_LOG, ".");
    /** @type {string[]} */
    const published = JSON.parse(readFileSync(REGISTRY_STATE, "utf8"));
    const versions = Object.fromEntries(
      published.map((version) => [
        version,
        {
          name: "@dvmkit/sdk",
          version,
          dist: { tarball: `${origin}/@dvmkit/sdk/-/sdk-${version}.tgz`, integrity: integrity[version] },
        },
      ])
    );
    response.writeHead(200, {
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
      etag: `"${published.join(",")}"`,
    });
    response.end(JSON.stringify({ name: "@dvmkit/sdk", "dist-tags": { latest: published.at(-1) }, versions }));
    return;
  }
  const tarball = /^\/@dvmkit\/sdk\/-\/(sdk-[0-9a-z.-]+\.tgz)$/u.exec(request.url ?? "");
  if (tarball?.[1]) {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(readFileSync(join(REGISTRY_TARBALLS, tarball[1])));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stale registry did not bind a TCP port");
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
