import { MemoryJobStore } from "../memory-job-store";
import { paymentIntentContract } from "./__helpers__/payment-intent-contract";

paymentIntentContract("memory store", () => Promise.resolve(new MemoryJobStore()));
