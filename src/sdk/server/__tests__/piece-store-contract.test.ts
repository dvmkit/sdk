import { MemoryJobStore } from "../memory-job-store";
import { pieceStoreContract } from "./__helpers__/piece-store-contract";

pieceStoreContract("memory store", () => Promise.resolve(new MemoryJobStore()));
