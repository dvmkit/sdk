import { initCallerLoggers } from "../lib/caller-loggers";
import { setDefaultService, setDimension } from "./context";
import type { DatasetName } from "./datasets";
import { SPANS_DATASETS } from "./datasets";
import type { SpanWriter } from "./span-writer";
import type { Logger } from "./types";
import { setEmitter, withSpan } from "./with-span";

// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op for fire-and-forget spans
const noop = () => {};

export let loggers: Record<DatasetName, Logger> = buildNoopLoggers();

/**
 * Initialise the loggers module. Wires the span writer as the emitter and
 * returns the loggers object (also sets the module-level singleton).
 *
 * Call once at process startup, after constructing the SpanWriter.
 */
export function initLoggers(writer: SpanWriter, service: string): Record<DatasetName, Logger> {
  setEmitter((row) => {
    writer.enqueue(row);
  });

  setDefaultService(service);

  const result = {} as Record<DatasetName, Logger>;
  for (const ds of SPANS_DATASETS) {
    result[ds.name] = createLogger(ds.name, {});
  }
  loggers = result;
  initCallerLoggers(result);
  return result;
}

function createLogger(dataset: DatasetName, bakedDims: Record<string, unknown>): Logger {
  const logger: Logger = {
    info(name, attrs) {
      void withSpan({ dataset, name, level: "info", attrs, dims: bakedDims }, noop).catch(noop);
    },

    warn(name, attrs) {
      void withSpan({ dataset, name, level: "warn", attrs, dims: bakedDims }, noop).catch(noop);
    },

    error(name, attrs) {
      void withSpan(
        {
          dataset,
          name,
          level: "error",
          attrs,
          dims: bakedDims,
          err: new Error()
        },
        noop
      ).catch(noop);
    },

    async span<T>(
      name: string,
      attrs: Record<string, unknown>,
      fn: () => Promise<T> | T,
      opts?: {
        onError?: (err: unknown) => Record<string, unknown> | undefined;
      }
    ): Promise<T> {
      return withSpan({ dataset, name, attrs, dims: bakedDims, onError: opts?.onError }, fn);
    },

    timer(name, attrs) {
      const startMs = Date.now();
      return {
        [Symbol.dispose]() {
          const endMs = Date.now();
          void withSpan({ dataset, name, attrs, dims: bakedDims, startMs, endMs }, noop).catch(noop);
        }
      };
    },

    set(dims) {
      for (const [k, v] of Object.entries(dims)) {
        setDimension(k, v);
      }
    },

    extend(dims) {
      return createLogger(dataset, { ...bakedDims, ...dims });
    },

    tracked<T extends (...args: never[]) => unknown>(name: string, fn: T): T {
      return ((...args: unknown[]) => logger.span(name, {}, () => fn(...(args as never[])))) as unknown as T;
    }
  };

  return logger;
}

function buildNoopLoggers(): Record<DatasetName, Logger> {
  const noopLogger: Logger = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    info() {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    warn() {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    error() {},
    async span<T>(
      _name: string,
      _attrs: Record<string, unknown>,
      fn: () => Promise<T> | T,
      _opts?: {
        onError?: (err: unknown) => Record<string, unknown> | undefined;
      }
    ): Promise<T> {
      return fn() as Promise<T>;
    },
    timer() {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return { [Symbol.dispose]() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    set() {},
    extend() {
      return noopLogger;
    },
    tracked<T extends (...args: never[]) => unknown>(_name: string, fn: T): T {
      return fn;
    }
  };

  const result = {} as Record<DatasetName, Logger>;
  for (const ds of SPANS_DATASETS) {
    result[ds.name] = noopLogger;
  }
  return result;
}
