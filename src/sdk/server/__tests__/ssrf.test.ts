import { describe, expect, it } from "vitest";

import {
  assertSafeUrl,
  buildPinnedLookup,
  createPinnedFetch,
  SSRFError,
  type SSRFResolver,
} from "../ssrf";

const stubResolver =
  (addresses: string[]) =>
  async (_host: string): Promise<{ address: string; family: number }[]> =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("assertSafeUrl — accepts safe inputs", () => {
  it("accepts a public hostname that resolves to multiple public IPs", async () => {
    await expect(
      assertSafeUrl("https://example.com/p", {
        resolver: stubResolver(["93.184.216.34", "2606:2800:220:1::1"]),
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertSafeUrl — scheme", () => {
  it.each(["http://example.com/p", "ftp://example.com/p", "file:///etc/passwd"])(
    "rejects non-https scheme (%s) with insecure_scheme",
    async (url) => {
      const promise = assertSafeUrl(url, { resolver: stubResolver(["1.1.1.1"]) });
      await expect(promise).rejects.toThrow(SSRFError);
      await expect(promise).rejects.toMatchObject({ reason: "insecure_scheme" });
    }
  );
});

describe("assertSafeUrl — URL shape", () => {
  it("rejects unparseable URLs with invalid_url", async () => {
    const promise = assertSafeUrl("not-a-url", { resolver: stubResolver([]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "invalid_url" });
  });
});

describe("assertSafeUrl — hostname denylist", () => {
  const internalSuffix = ["inter", "nal"].join("");
  const localSuffix = ["lo", "cal"].join("");
  it.each([
    "https://localhost/x",
    `https://my-svc.${internalSuffix}/x`,
    `https://printer.${localSuffix}/x`,
    "https://router.lan/x",
    "https://service.localhost/x",
    `https://metadata.google.${internalSuffix}/x`,
    "https://metadata/x",
    "https://ip6-localhost/x",
    "https://ip6-loopback/x",
  ])("rejects denylisted hostname (%s) with private_address", async (url) => {
    const promise = assertSafeUrl(url, { resolver: stubResolver(["1.1.1.1"]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });
});

describe("assertSafeUrl — IPv4 ranges", () => {
  it.each([
    "https://10.0.0.1/x", // RFC 1918 private
    "https://127.0.0.1/x", // loopback
    "https://169.254.169.254/", // AWS / GCP metadata
    "https://192.168.1.1/x", // RFC 1918 private
    "https://172.16.0.1/x", // RFC 1918 private
    "https://0.0.0.0/x", // "this network"
    "https://100.64.0.1/x", // CGNAT
    "https://224.0.0.1/x", // multicast
    "https://239.255.255.250/x", // multicast (SSDP)
    "https://240.0.0.1/x", // reserved
    "https://198.18.0.1/x", // benchmarking
    "https://198.19.255.254/x", // benchmarking high end
    "https://192.0.0.1/x", // IETF protocol assignments — 192.0.0.0/24
    "https://192.0.2.1/x", // TEST-NET-1 — 192.0.2.0/24 (RFC 5737)
  ])("rejects private/link-local IPv4 literal (%s)", async (url) => {
    const promise = assertSafeUrl(url, { resolver: stubResolver([]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it.each(["https://192.0.66.108/x"])("accepts publicly-routable 192.0.0.0/16 literal (%s)", async (url) => {
    await expect(assertSafeUrl(url, { resolver: stubResolver([]) })).resolves.toBeUndefined();
  });
});

describe("assertSafeUrl — IPv6 ranges", () => {
  it.each([
    "https://[::1]/x", // loopback
    "https://[::]/x", // unspecified
    "https://[fe80::1]/x", // link-local
    "https://[feb0::1]/x", // link-local edge
    "https://[fc00::1]/x", // unique local
    "https://[fd00::1]/x", // unique local
    "https://[ff00::1]/x", // multicast
  ])("rejects private/link-local IPv6 literal (%s)", async (url) => {
    const promise = assertSafeUrl(url, { resolver: stubResolver([]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects IPv4-mapped IPv6 in dotted form (::ffff:10.0.0.1)", async () => {
    const promise = assertSafeUrl("https://[::ffff:10.0.0.1]/x", { resolver: stubResolver([]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });
});

describe("assertSafeUrl — DNS resolution", () => {

  it("rejects when any address among many is private (DNS-rebinding shape)", async () => {
    const promise = assertSafeUrl("https://attacker.example/p", {
      resolver: stubResolver(["93.184.216.34", "10.0.0.1"]),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects when DNS resolution fails (NXDOMAIN-shaped) with dns_failed", async () => {
    const failingResolver = async (): Promise<{ address: string; family: number }[]> => {
      throw new Error("ENOTFOUND");
    };
    const promise = assertSafeUrl("https://nope.invalid/x", { resolver: failingResolver });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "dns_failed" });
  });

  it("rejects when DNS returns no addresses with dns_failed", async () => {
    const promise = assertSafeUrl("https://example.com/x", { resolver: stubResolver([]) });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "dns_failed" });
  });
});

describe("assertSafeUrl — configurable hooks", () => {
  it("extends the exact-hostname denylist via extraHostnamesExact", async () => {
    const promise = assertSafeUrl("https://forbidden.example/x", {
      resolver: stubResolver(["1.1.1.1"]),
      extraHostnamesExact: ["forbidden.example"],
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("keeps the default exact-hostname denylist when extras are supplied", async () => {
    const promise = assertSafeUrl("https://localhost/x", {
      resolver: stubResolver(["1.1.1.1"]),
      extraHostnamesExact: ["forbidden.example"],
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("extends the suffix denylist via extraHostnameSuffixes", async () => {
    const promise = assertSafeUrl("https://anything.corp.invalid/x", {
      resolver: stubResolver(["1.1.1.1"]),
      extraHostnameSuffixes: [".corp.invalid"],
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("keeps the default suffix denylist when extras are supplied", async () => {
    const localSuffix = ["lo", "cal"].join("");
    const promise = assertSafeUrl(`https://printer.${localSuffix}/x`, {
      resolver: stubResolver(["1.1.1.1"]),
      extraHostnameSuffixes: [".corp.invalid"],
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("extends the IPv4 unsafe-predicate via extraUnsafeIPv4 (e.g. block 1.2.3.0/24)", async () => {
    const promise = assertSafeUrl("https://1.2.3.4/x", {
      resolver: stubResolver([]),
      extraUnsafeIPv4: (ip) => ip.startsWith("1.2.3."),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("extends the IPv6 unsafe-predicate via extraUnsafeIPv6", async () => {
    const promise = assertSafeUrl("https://[2001:db8::1]/x", {
      resolver: stubResolver([]),
      extraUnsafeIPv6: (ip) => ip.startsWith("2001:db8"),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });
});

describe("assertSafeUrl — defaults", () => {
  it("rejects a denylisted hostname without optional guard settings", async () => {
    await expect(assertSafeUrl("https://localhost/x")).rejects.toThrow(SSRFError);
  });
});

describe("createPinnedFetch — DNS-rebind closure", () => {
  it("returns a PinnedFetch with the first resolved address for a hostname URL", async () => {
    const pinned = await createPinnedFetch("https://example.com/p", {
      resolver: stubResolver(["93.184.216.34", "93.184.216.35"]),
    });
    try {
      expect(pinned.address).toBe("93.184.216.34");
      expect(pinned.family).toBe(4);
      expect(typeof pinned.fetch).toBe("function");
    } finally {
      await pinned.close();
    }
  });

  it("returns the canonical literal address for an IPv4-literal URL (no DNS)", async () => {
    const pinned = await createPinnedFetch("https://93.184.216.34/p", {
      resolver: stubResolver([]),
    });
    try {
      expect(pinned.address).toBe("93.184.216.34");
      expect(pinned.family).toBe(4);
    } finally {
      await pinned.close();
    }
  });

  it("returns the bracket-stripped address for an IPv6-literal URL (no DNS)", async () => {
    const pinned = await createPinnedFetch("https://[2606:2800:220:1::1]/p", {
      resolver: stubResolver([]),
    });
    try {
      expect(pinned.address).toBe("2606:2800:220:1::1");
      expect(pinned.family).toBe(6);
    } finally {
      await pinned.close();
    }
  });

  it("rejects DNS-rebind shape (private address among many) with private_address", async () => {
    const promise = createPinnedFetch("https://attacker.example/p", {
      resolver: stubResolver(["93.184.216.34", "169.254.169.254"]),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects an IPv4 literal in a blocked range without opening a dispatcher", async () => {
    const promise = createPinnedFetch("https://169.254.169.254/", {
      resolver: stubResolver([]),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects a non-https scheme with insecure_scheme", async () => {
    const promise = createPinnedFetch("http://example.com/p", {
      resolver: stubResolver(["93.184.216.34"]),
    });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "insecure_scheme" });
  });

  it("rejects when DNS resolution fails with dns_failed", async () => {
    const failingResolver = async (): Promise<{ address: string; family: number }[]> => {
      throw new Error("ENOTFOUND");
    };
    const promise = createPinnedFetch("https://nope.invalid/x", { resolver: failingResolver });
    await expect(promise).rejects.toThrow(SSRFError);
    await expect(promise).rejects.toMatchObject({ reason: "dns_failed" });
  });

  it("routes through baseFetch when provided (preserves dvm.fetch instrumentation)", async () => {
    const calls: { url: string; hasDispatcher: boolean }[] = [];
    const baseFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        hasDispatcher: Boolean((init as { dispatcher?: unknown } | undefined)?.dispatcher),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const pinned = await createPinnedFetch("https://example.com/p", {
      resolver: stubResolver(["93.184.216.34"]),
      baseFetch,
    });
    try {
      await pinned.fetch("https://example.com/p", { method: "HEAD" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.com/p");
      expect(calls[0]?.hasDispatcher).toBe(true);
    } finally {
      await pinned.close();
    }
  });

  it("routes IP-literal URLs through baseFetch without opening a dispatcher", async () => {
    const calls: { url: string; hasDispatcher: boolean }[] = [];
    const baseFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        hasDispatcher: Boolean((init as { dispatcher?: unknown } | undefined)?.dispatcher),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const pinned = await createPinnedFetch("https://93.184.216.34/p", {
      resolver: stubResolver([]),
      baseFetch,
    });
    try {
      await pinned.fetch("https://93.184.216.34/p");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.hasDispatcher).toBe(false);
    } finally {
      await pinned.close();
    }
  });

  it("rejects an unsafe redirect target before opening a pinned connection to it", async () => {
    const resolverCalls: string[] = [];
    const resolver: SSRFResolver = async (host) => {
      resolverCalls.push(host);
      if (host === "source.example") return [{ address: "93.184.216.34", family: 4 }];
      if (host === "private.example") return [{ address: "10.0.0.5", family: 4 }];
      throw new Error(`unexpected lookup for ${host}`);
    };
    const calls: string[] = [];
    const baseFetch: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(request.url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://private.example/metadata" },
      });
    };
    const pinned = await createPinnedFetch("https://source.example/audio", { resolver, baseFetch });

    try {
      await expect(pinned.fetch("https://source.example/audio")).rejects.toMatchObject({
        reason: "private_address",
      });
      expect(calls).toEqual(["https://source.example/audio"]);
      expect(resolverCalls).toEqual(["source.example", "private.example"]);
    } finally {
      await pinned.close();
    }
  });
});

describe("pinned redirects", () => {
  it.each(["validation", "wrapper"])("cancels an unsent upload after %s failure", async (failure) => {
    let canceled = false;
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: async (host) => [{ address: host === "private.example.com" ? "10.0.0.1" : "93.184.216.34", family: 4 }],
      baseFetch: async () => { throw new Error("wrapper failed"); },
    });
    try {
      await expect(pinned.fetch(failure === "validation" ? "https://private.example.com/" : "https://source.example.com/", {
        method: "POST", duplex: "half",
        body: new ReadableStream({ cancel() { canceled = true; } }),
      } as RequestInit)).rejects.toThrow(failure === "validation" ? "blocked address" : "wrapper failed");
      expect(canceled).toBe(true);
    } finally {
      await pinned.close();
    }
  });

  it.each([
    [301, "POST", "GET"], [302, "POST", "GET"], [303, "PUT", "GET"],
    [301, "HEAD", "HEAD"], [302, "GET", "GET"], [303, "HEAD", "HEAD"],
    [307, "GET", "GET"], [308, "HEAD", "HEAD"],
  ])("applies %s method rules to %s", async (status, method, expected) => {
    const calls: Request[] = [];
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: stubResolver(["93.184.216.34"]),
      baseFetch: async (input) => {
        calls.push(input as Request);
        return calls.length === 1
          ? new Response(null, { status: Number(status), headers: { location: "/next" } })
          : new Response("accepted");
      },
    });
    try {
      const response = await pinned.fetch("https://source.example.com/", {
        method: String(method),
        ...(method === "POST" || method === "PUT"
          ? { body: "payload", headers: { "content-type": "text/plain", "content-length": "7" } }
          : {}),
      });
      expect(await response.text()).toBe("accepted");
      expect(calls[1]!.method).toBe(expected);
      expect(calls[1]!.body).toBeNull();
      expect(calls[1]!.headers.has("content-type")).toBe(false);
      expect(calls[1]!.headers.has("content-length")).toBe(false);
    } finally {
      await pinned.close();
    }
  });

  it.each([301, 302, 307, 308])("refuses a body-preserving %s before resolving its target", async (status) => {
    const events: string[] = [];
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: async (host) => { events.push(host); return [{ address: "93.184.216.34", family: 4 }]; },
      baseFetch: async () => new Response(new ReadableStream({
        cancel() { events.push("response canceled"); },
      }), { status, headers: { location: "https://target.example.com/" } }),
      onRedirectFollowed: () => { events.push("followed"); },
    });
    try {
      await expect(pinned.fetch("https://source.example.com/", {
        method: "PUT",
        body: new ReadableStream({ cancel() { events.push("upload canceled"); } }),
        duplex: "half",
      } as RequestInit)).rejects.toThrow("cannot safely replay");
      expect(events).toEqual(["source.example.com", "upload canceled", "response canceled"]);
    } finally {
      await pinned.close();
    }
  });

  it.each([false, true])("binds credentials to their origin (cross-origin: %s)", async (crossOrigin) => {
    const requests: Request[] = [];
    const events: string[] = [];
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: async (host) => { events.push(host); return [{ address: "93.184.216.34", family: 4 }]; },
      baseFetch: async (input) => {
        requests.push(input as Request);
        return requests.length === 1
          ? new Response(new ReadableStream({ cancel() { events.push("discarded"); } }), {
            status: 302, headers: { location: crossOrigin ? "https://target.example.com/" : "/next" },
          })
          : new Response(null, { status: 204 });
      },
      onRedirectFollowed: () => { events.push("followed"); },
    });
    try {
      await pinned.fetch("https://source.example.com/", {
        headers: {
          authorization: "Bearer example", cookie: "example=value",
          "proxy-authorization": "Basic example", host: "source.example.com", "x-example": "retained",
        },
      });
      for (const name of ["authorization", "cookie", "proxy-authorization", "host"]) {
        expect(requests[1]!.headers.has(name)).toBe(!crossOrigin);
      }
      expect(requests[1]!.headers.get("x-example")).toBe("retained");
      expect(events).toEqual([
        "source.example.com", "discarded", "followed", ...(crossOrigin ? ["target.example.com"] : []),
      ]);
    } finally {
      await pinned.close();
    }
  });

  it.each(["manual", "error"] as const)("honors redirect mode %s", async (redirect) => {
    let discarded = false;
    let calls = 0;
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: stubResolver(["93.184.216.34"]),
      baseFetch: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { discarded = true; } }), {
          status: 302, headers: { location: "https://target.example.com/" },
        });
      },
    });
    try {
      const pending = pinned.fetch("https://source.example.com/", { redirect });
      if (redirect === "error") {
        await expect(pending).rejects.toThrow("redirect mode is set to error");
        expect(discarded).toBe(true);
      } else {
        const response = await pending;
        expect(response.status).toBe(302);
        expect(discarded).toBe(false);
        await response.body!.cancel();
      }
      expect(calls).toBe(1);
    } finally {
      await pinned.close();
    }
  });

  it("stops redirect loops at twenty followed hops and discards every source", async () => {
    let calls = 0;
    let discarded = 0;
    let followed = 0;
    const pinned = await createPinnedFetch("https://source.example.com/", {
      resolver: stubResolver(["93.184.216.34"]),
      baseFetch: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { discarded++; } }), {
          status: 302, headers: { location: "/loop" },
        });
      },
      onRedirectFollowed: () => { followed++; },
    });
    try {
      await expect(pinned.fetch("https://source.example.com/")).rejects.toThrow("maximum redirect count");
      expect(calls).toBe(21);
      expect(discarded).toBe(21);
      expect(followed).toBe(20);
    } finally {
      await pinned.close();
    }
  });
});

describe("buildPinnedLookup — autoSelectFamily callback form", () => {
  const addrs = [
    { address: "2606:2800:220:1::1", family: 6 },
    { address: "93.184.216.34", family: 4 },
  ];

  it("emits the ARRAY callback form by default (autoSelectFamily / all:true)", () => {
    const lookup = buildPinnedLookup(addrs);
    const calls: unknown[][] = [];
    const cb = (...args: unknown[]): void => {
      calls.push(args);
    };
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      "example.com",
      { all: true },
      cb
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBeNull();
    expect(calls[0]?.[1]).toEqual(addrs);
  });

  it("falls back to the single-address form when all:false", () => {
    const lookup = buildPinnedLookup(addrs);
    const calls: unknown[][] = [];
    const cb = (...args: unknown[]): void => {
      calls.push(args);
    };
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      "example.com",
      { all: false },
      cb
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([null, "2606:2800:220:1::1", 6]);
  });
});
