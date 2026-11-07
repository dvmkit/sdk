export * as sdk from "@dvmkit/sdk";
export * as server from "@dvmkit/sdk/server";
export { z } from "zod";

export const serverModule = import.meta.resolve("@dvmkit/sdk/server");
