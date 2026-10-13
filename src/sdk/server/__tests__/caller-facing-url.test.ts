import { describe, expect, it } from "vitest";

import { infoSchemaUrl } from "../auth-error";
import { callerFacingRequestUrl, resolvePublicOrigin } from "../caller-facing-url";

describe("caller-facing URLs", () => {
  it("normalizes an absolute http(s) public URL to its origin", () => {
    expect(resolvePublicOrigin("https://dvm.example/public/path/?ignored=yes#fragment")).toBe(
      "https://dvm.example"
    );
    expect(resolvePublicOrigin("http://dvm.example:8080///")).toBe(
      "http://dvm.example:8080"
    );
  });

  it.each([undefined, "", "not a URL", "/relative", "ftp://dvm.example"])(
    "ignores an absent or invalid public URL (%s)",
    (value) => {
      expect(resolvePublicOrigin(value)).toBeUndefined();
    }
  );

  it("rebases the request path and query onto the public origin", () => {
    expect(
      callerFacingRequestUrl(
        "http://request.example/v1/job?mode=fast",
        "https://dvmkit--scrape.example.com"
      )
    ).toBe("https://dvmkit--scrape.example.com/v1/job?mode=fast");
  });

  it("leaves the request URL byte-identical without a valid override", () => {
    const requestUrl = "http://self-hosted.example:8080/v1/job?mode=fast";
    expect(callerFacingRequestUrl(requestUrl, undefined)).toBe(requestUrl);
  });

  it("uses the same origin selection for schema URLs", () => {
    const requestUrl = "http://request.example/v1/job";
    expect(infoSchemaUrl(requestUrl, "https://dvmkit--scrape.example.com")).toBe(
      "https://dvmkit--scrape.example.com/v1/info"
    );
    expect(infoSchemaUrl(requestUrl)).toBe("http://request.example/v1/info");
  });
});
