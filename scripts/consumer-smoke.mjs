#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
/** @type {{ package: string, version: string, exports: { export: string, declaration: string, names: string[] }[] }} */
const surface = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8"));
const runtimeProbes = {
  ".": ["configureDVM", "isConfiguredDVMDescriptor"],
  "./server": ["createDVMHost", "signHostingControl", "retryHostedTempoCloseReport", "writeOffHostedTempoCloseReport"],
  "./testing": ["createTestContext"],
  // `./internal` is unsupported and undocumented, but the dvmkit platform imports it from the
  // published package like any other consumer, so an install that cannot resolve it is broken.
  "./internal": [
    "bindDiagnosticCapabilityAuthority",
    "bindDiagnosticIdentityAuthority",
    "createDiagnosticCapabilityAuthority",
    "extendDiagnosticIdentityAuthority",
    "x402WalletFromConfig",
    "tempoAccountFromConfig",
    "toLockPubkey",
    "verifyJobReceipt",
    "readCompletedCreditHistory",
    "createTempoChannelStore",
    "tempoDescriptorController",
    "retireTempoChannel",
    "retireTempoChannelScope",
    "x402VoucherPendingState",
    "assertNoRivalX402Voucher",
  ],
};
const temporaryRoot = mkdtempSync(join(tmpdir(), "dvmkit-sdk-consumer-"));

try {
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, root], root));
  const archive = join(temporaryRoot, packed.filename);

  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "sdk-consumer-fixture", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`
  );
  npm(["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", archive], consumer);

  const consumerManifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
  const savedSpecifier = consumerManifest.dependencies?.[manifest.name];
  if (typeof savedSpecifier !== "string") fail(`--save-exact did not record ${manifest.name} as a dependency`);
  if (/[\^~*]|\bx\b/u.test(savedSpecifier)) {
    fail(`--save-exact recorded a floating range: ${savedSpecifier}`);
  }
  const consumerLock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  const installedEntry = consumerLock.packages?.[`node_modules/${manifest.name}`];
  if (installedEntry?.version !== manifest.version) {
    fail(`consumer lockfile pinned ${installedEntry?.version ?? "nothing"}, expected ${manifest.version}`);
  }

  const installedRoot = join(consumer, "node_modules", ...manifest.name.split("/"));
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  if (installedManifest.version !== manifest.version) fail("installed package version differs from the packed version");

  const runtime = importThroughEntryPoints(consumer);
  const declarations = countInstalledDeclarations(installedRoot, installedManifest);
  typecheckConsumer(consumer, "bundler");
  typecheckConsumer(consumer, "node16");
  runExamples(consumer);
  runDrainRecovery(consumer);
  const completedHistory = runCompletedCreditHistory(consumer);
  runContentRetention(consumer, installedRoot);
  const trustedSpanPersistence = runTrustedSpanPersistence(consumer);
  const paymentDiagnostics = runPaymentDiagnostics(consumer, archive);

  const total = declarations.reduce((sum, entry) => sum + entry.names.length, 0);
  const expectedTotal = surface.exports.reduce((sum, entry) => sum + entry.names.length, 0);
  if (total !== expectedTotal) {
    fail(`installed package exposes ${total} declaration-level names; api-surface.json records ${expectedTotal}`);
  }
  for (const expected of surface.exports) {
    const actual = declarations.find((entry) => entry.export === expected.export);
    if (!actual) fail(`installed package does not expose ${expected.export}`);
    if (JSON.stringify(actual.names) !== JSON.stringify(expected.names)) {
      fail(`installed ${expected.export} declaration names differ from api-surface.json`);
    }
  }

  const shape = declarations.map((entry) => `${entry.export} ${entry.names.length}`).join(", ");
  console.log(
    `consumer ok: exact install of ${manifest.name}@${manifest.version}, runtime imports (${runtime.join(", ")}), bundler and node16 type resolution, runnable public examples, persisted drain recovery, completed credit history (${completedHistory.records} records, ${completedHistory.pages} pages, ${completedHistory.verifiedRefunds} offline verifications), signed content holds and export recipe, payment diagnostics (${paymentDiagnostics.cashuCases} accepted Cashu cases, ${paymentDiagnostics.credentialCases} credential failures, SHA-256 ${paymentDiagnostics.sha256})${trustedSpanPersistence ? ", trusted span persistence" : ""}, ${total} declaration-level names (${shape})`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

/** @param {string} consumer @param {string} archive */
function runPaymentDiagnostics(consumer, archive) {
  const probe = join(consumer, "payment-diagnostics.mjs");
  cpSync(join(root, "scripts", "fixtures", "payment-diagnostics.mjs"), probe);
  const output = execFileSync(process.execPath, [probe, archive, manifest.version], {
    cwd: consumer, encoding: "utf8", env: process.env,
    stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "");
}

/** @param {string} consumer @param {string} installedRoot */
function runContentRetention(consumer, installedRoot) {
  const probe = join(consumer, "content-retention.mjs");
  cpSync(join(root, "scripts", "fixtures", "content-retention.mjs"), probe);
  cpSync(join(root, "protocol-fixtures", "job-content-retention-v1.json"), join(consumer, "job-content-retention-v1.json"));
  execFileSync(process.execPath, [probe, join(installedRoot, "recipes", "postgres", "financial-export-v1.sql")], {
    cwd: consumer, encoding: "utf8", env: process.env,
    stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
}

/** @param {string} consumer */
function runTrustedSpanPersistence(consumer) {
  if (!process.env.DATABASE_URL) return false;
  const probe = join(consumer, "trusted-span-persistence.mjs");
  cpSync(join(root, "scripts", "fixtures", "trusted-span-persistence.mjs"), probe);
  execFileSync(process.execPath, [probe], {
    cwd: consumer,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return true;
}

/** @param {string} consumer */
function runCompletedCreditHistory(consumer) {
  const probe = join(consumer, "completed-credit-history.mjs");
  cpSync(join(root, "scripts", "fixtures", "completed-credit-history.mjs"), probe);
  const output = execFileSync(process.execPath, [probe], {
    cwd: consumer,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return JSON.parse(output);
}

/** @param {string} consumer */
function runDrainRecovery(consumer) {
  const probe = join(consumer, "pending-drain-recovery.mjs");
  cpSync(join(root, "scripts", "fixtures", "pending-drain-recovery.mjs"), probe);
  execFileSync(process.execPath, [probe], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, DVM_CONFIG_DIR: join(consumer, "caller-state") },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/** @param {string} consumer */
function runExamples(consumer) {
  const destination = join(consumer, "examples");
  cpSync(join(root, "examples"), destination, { recursive: true });
  execFileSync(
    process.execPath,
    [
      "--test",
      "examples/quickstart/handler.test.ts",
      "examples/authenticated-route/handler.test.ts",
      "examples/payments-and-lifecycle/handler.test.ts",
    ],
    {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

/** @param {string} consumer */
function importThroughEntryPoints(consumer) {
  const probe = join(consumer, "runtime-probe.mjs");
  writeFileSync(
    probe,
    [
      ...Object.keys(runtimeProbes).map(
        (entry, index) => `import * as entry${index} from ${JSON.stringify(manifest.name + entry.slice(1))};`
      ),
      "",
      `const probes = ${JSON.stringify(runtimeProbes)};`,
      `const loaded = [${Object.keys(runtimeProbes).map((_, index) => `entry${index}`).join(", ")}];`,
      "const summary = [];",
      "for (const [index, entry] of Object.keys(probes).entries()) {",
      "  for (const name of probes[entry]) {",
      "    if (typeof loaded[index][name] !== 'function') {",
      "      throw new Error(`${entry} does not export ${name} as a function at runtime`);",
      "    }",
      "  }",
      "  summary.push(`${entry} ${Object.keys(loaded[index]).length}`);",
      "}",
      "process.stdout.write(summary.join('\\n'));",
      "",
    ].join("\n")
  );
  const output = execFileSync(process.execPath, [probe], { cwd: consumer, encoding: "utf8" });
  rmSync(probe, { force: true });
  const summary = output.split("\n").filter(Boolean);
  if (summary.length !== Object.keys(runtimeProbes).length) {
    fail("runtime probe did not report every declared entry point");
  }
  return summary;
}

/** @param {string} installedRoot @param {any} installedManifest */
function countInstalledDeclarations(installedRoot, installedManifest) {
  return Object.entries(installedManifest.exports).map(([name, target]) => {
    const declaration = join(installedRoot, target.types.replace(/^\.\//u, ""));
    const program = ts.createProgram({
      rootNames: [declaration],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2024,
      },
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(declaration);
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) fail(`could not inspect the installed declaration for ${name}`);
    return {
      export: name,
      names: checker
        .getExportsOfModule(symbol)
        .map((item) => item.getName())
        .sort(),
    };
  });
}

/** @param {string} consumer @param {"bundler" | "node16"} resolution */
function typecheckConsumer(consumer, resolution) {
  const entry = join(consumer, `consumer-${resolution}.ts`);
  writeFileSync(
    entry,
    [
      `import { configureDVM } from "${manifest.name}";`,
      `import { createDVMHost, signHostingControl, retryHostedTempoCloseReport, writeOffHostedTempoCloseReport, type DVMServeResult, type PaidJobCompletion, type PaymentMode, type HostingControlConfig, type HostingControlCommand, type HostingControlStatus } from "${manifest.name}/server";`,
      `import { createTestContext } from "${manifest.name}/testing";`,
      `import { bindDiagnosticCapabilityAuthority, bindDiagnosticIdentityAuthority, createDiagnosticCapabilityAuthority, type CreditDepositPayload, type CreditDrainPayload, type DiagnosticCapabilityAuthority, type DiagnosticIdentityAuthority, extendDiagnosticIdentityAuthority, readX402ChannelGuardFacts, tempoChallengeAmountMicro, type StoredX402ChannelMetadata, readCompletedCreditHistory, type CompletedCreditHistoryQuery, type CompletedCreditHistoryPage, type CompletedCreditHistoryRecord, type CompletedRefundHistoryRecord, type ExpiredCreditLossHistoryRecord, toLockPubkey } from "${manifest.name}/internal";`,
      "",
      `import { x402WalletFromConfig, tempoAccountFromConfig, type WalletCredentialConfig } from "${manifest.name}/internal";`,
      "export const credentials: WalletCredentialConfig = { tempo: { method: 'tempo', network: 'moderato' } };",
      "export const x402Projection = x402WalletFromConfig(credentials);",
      "export const tempoProjection = tempoAccountFromConfig(credentials);",
      "export declare const guardChannel: StoredX402ChannelMetadata;",
      "export const guardFacts: Promise<{balance: bigint; pendingWithdrawal: bigint}> = readX402ChannelGuardFacts({channel: guardChannel, configuredNetwork: 'base-sepolia'});",
      "export const parseTempoAmount: (challenge: Parameters<typeof tempoChallengeAmountMicro>[0]) => bigint = tempoChallengeAmountMicro;",
      "export const surface = [configureDVM, createDVMHost, createTestContext, retryHostedTempoCloseReport, writeOffHostedTempoCloseReport, toLockPubkey] as const;",
      "export const readHistory: (query?: CompletedCreditHistoryQuery) => CompletedCreditHistoryPage = readCompletedCreditHistory;",
      "export type CompletedRecords = CompletedRefundHistoryRecord | ExpiredCreditLossHistoryRecord;",
      "export declare const historyRecord: CompletedCreditHistoryRecord;",
      "export const historyFee: number | null = historyRecord.feeMicro;",
      "export const historyKind: 'completed_refund' | 'expired_credit_loss' = historyRecord.kind;",
      "export type CreditReportCallers = [CreditDepositPayload['callerPubkey'], CreditDrainPayload['callerPubkey']];",
      "export const creditReportCallers: CreditReportCallers = ['caller', 'caller'];",
      "export const diagnosticCapabilityAuthority: DiagnosticCapabilityAuthority = createDiagnosticCapabilityAuthority(['example']);",
      "export const diagnosticIdentityAuthority: DiagnosticIdentityAuthority | undefined = extendDiagnosticIdentityAuthority(undefined, 'dvm_slug', 'example-app');",
      "export const trustedDiagnosticValue = bindDiagnosticIdentityAuthority(bindDiagnosticCapabilityAuthority({}, diagnosticCapabilityAuthority), diagnosticIdentityAuthority);",
      "export const paidCompletion: PaidJobCompletion = { jobId: 'job', rail: 'cashu', amountMicro: 1000, currency: 'usd', testFunds: true };",
      "export declare const serveResult: DVMServeResult;",
      "export const paymentMode: PaymentMode = serveResult.paymentModes[0]!;",
      "export const hostingConfig: HostingControlConfig = { secret: 'example-management-secret-32-bytes-long', scope: 'example-deployment' };",
      "export const hostingCommand: HostingControlCommand = { action: 'status', scope: hostingConfig.scope, dvmId: 'example-dvm', timestampMs: 1700000000000, nonce: 'example_nonce_00000001' };",
      "export const hostingSignature: string = signHostingControl(hostingConfig.secret, hostingCommand);",
      "export declare const hostingStatus: HostingControlStatus;",
      "export const unownedActiveJobIds: string[] = hostingStatus.unownedActiveJobIds;",
      "",
    ].join("\n")
  );
  const moduleKind = resolution === "node16" ? ts.ModuleKind.Node16 : ts.ModuleKind.ESNext;
  const moduleResolution =
    resolution === "node16" ? ts.ModuleResolutionKind.Node16 : ts.ModuleResolutionKind.Bundler;
  const program = ts.createProgram({
    rootNames: [entry],
    options: {
      module: moduleKind,
      moduleResolution,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2024,
      types: [],
    },
  });
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => consumer,
      getNewLine: () => "\n",
    });
    fail(`a ${resolution} consumer does not typecheck against the packed package:\n${formatted}`);
  }
  rmSync(entry, { force: true });
}

/** @param {string[]} args @param {string} cwd */
function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("run this check through npm so the active npm executable is unambiguous");
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`consumer: ${message}`);
  process.exit(1);
}
