import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OmpCommand, OmpCommandsResponse } from "./types.ts";

const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";
const DISCOVERY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 250;


const TERMINAL_CONTROL = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
// Keep the phone's first row small and useful; the full live registry remains searchable.
const COMMON_BUILTINS: Record<string, true> = {
  new: true,
  branch: true,
  fork: true,
  compact: true,
  shake: true,
  model: true,
  settings: true,
  resume: true,
};
const DANGEROUS_BUILTINS: Record<string, true> = {
  new: true,
  clear: true,
  drop: true,
  quit: true,
  logout: true,
};

interface BuiltinCommandDef {
  name?: unknown;
  description?: unknown;
  allowArgs?: unknown;
  inlineHint?: unknown;
  subcommands?: unknown;
}

interface AcpCommand {
  name?: unknown;
  description?: unknown;
  input?: unknown;
}

interface JsonObject {
  [key: string]: unknown;
}

export interface OmpCommandProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  write(data: string): Promise<void> | void;
  closeInput(): Promise<void> | void;
  terminate(): void;
}

export interface OmpCommandDiscoveryDeps {
  which(command: string): string | null;
  bunInstall(): string;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  importModule(url: string): Promise<unknown>;
  spawn(command: string[], cwd: string): OmpCommandProcess;
  timeoutMs?: number;
  closeTimeoutMs?: number;
}

const defaultDeps: Required<OmpCommandDiscoveryDeps> = {
  which: (command) => Bun.which(command),
  bunInstall: () => process.env.BUN_INSTALL?.trim() || join(homedir(), ".bun"),
  readFile,
  async importModule(url) {
    const child = Bun.spawn([
      join(defaultDeps.bunInstall(), "bin", "bun"), "-e",
      "const m = await import(process.argv[1]); console.log(JSON.stringify({ BUILTIN_SLASH_COMMAND_DEFS: m.BUILTIN_SLASH_COMMAND_DEFS }));",
      url,
    ], { cwd: dirname(fileURLToPath(url)), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), DISCOVERY_TIMEOUT_MS);
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0) throw new Error(`OMP builtin registry failed: ${err.trim()}`);
      return JSON.parse(out);
    } finally {
      clearTimeout(timer);
    }
  },
  spawn(command, cwd) {
    const child = Bun.spawn(command, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PATH: `${join(defaultDeps.bunInstall(), "bin")}${delimiter}${process.env.PATH ?? ""}` },
    });
    return {
      stdout: child.stdout,
      exited: child.exited,
      async write(data) {
        child.stdin.write(data);
        await child.stdin.flush();
      },
      closeInput() {
        child.stdin.end();
      },
      terminate() {
        child.kill();
      },
    };
  },
  timeoutMs: DISCOVERY_TIMEOUT_MS,
  closeTimeoutMs: CLOSE_TIMEOUT_MS,
};

/**
 * Ask a fresh, in-memory ACP session for this pane cwd's skills, extension commands, and file
 * commands, then join them to the full interactive builtin registry from the same global OMP install.
 */
export async function discoverOmpCommands(
  cwd: string,
  injected: Partial<OmpCommandDiscoveryDeps> = {},
): Promise<OmpCommandsResponse> {
  const deps: Required<OmpCommandDiscoveryDeps> = {
    ...defaultDeps,
    ...injected,
    timeoutMs: injected.timeoutMs ?? defaultDeps.timeoutMs,
    closeTimeoutMs: injected.closeTimeoutMs ?? defaultDeps.closeTimeoutMs,
  };
  const executable = deps.which("omp") ?? deps.which(join(deps.bunInstall(), "bin", "omp"));
  if (!executable) throw new Error("OMP executable not found");

  // Bun's global launcher is a bundled file, not a package symlink. Its package lives below the
  // global install root, so derive the source from BUN_INSTALL rather than from the launcher path.
  const packageRoot = join(deps.bunInstall(), "install", "global", "node_modules", ...OMP_PACKAGE.split("/"));
  const packageInfo = parsePackageInfo(await deps.readFile(join(packageRoot, "package.json"), "utf8"));
  if (!packageInfo) throw new Error("OMP global package metadata is unavailable");

  const registry = await deps.importModule(
    pathToFileURL(join(packageRoot, "src", "slash-commands", "builtin-registry.ts")).href,
  );
  const builtins = builtinDefinitions(registry);
  if (!builtins) throw new Error("OMP builtin command registry is unavailable");

  const child = deps.spawn([executable, "--mode=acp", "--no-session", `--cwd=${cwd}`], cwd);
  const controller = new AbortController();
  try {
    const discovered = await withTimeout(
      collectAcpCommands(child, cwd, controller.signal),
      deps.timeoutMs,
      controller,
    );
    return { version: packageInfo.version, commands: mergeCommands(builtins, discovered) };
  } finally {
    controller.abort();
    await closeChild(child, deps.closeTimeoutMs);
  }
}

function parsePackageInfo(text: string): { version: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value) || value.name !== OMP_PACKAGE || typeof value.version !== "string" || !value.version) {
      return null;
    }
    return { version: value.version };
  } catch {
    return null;
  }
}

function builtinDefinitions(module: unknown): BuiltinCommandDef[] | null {
  if (!isObject(module) || !Array.isArray(module.BUILTIN_SLASH_COMMAND_DEFS)) return null;
  return module.BUILTIN_SLASH_COMMAND_DEFS.filter(isObject);
}

function mergeCommands(builtins: readonly BuiltinCommandDef[], discovered: readonly AcpCommand[]): OmpCommand[] {
  const commands = new Map<string, OmpCommand>();
  for (const builtin of builtins) {
    const name = commandName(builtin.name);
    if (!name || commands.has(name)) continue;
    const { takesArg, argHint } = builtinArgument(builtin);
    commands.set(name, {
      command: name,
      description: stringValue(builtin.description),
      takesArg,
      argHint,
      common: Object.hasOwn(COMMON_BUILTINS, name.slice(1)),
      dangerous: Object.hasOwn(DANGEROUS_BUILTINS, name.slice(1)),
    });
  }
  for (const command of discovered) {
    const name = commandName(command.name);
    if (!name || commands.has(name)) continue;
    const argHint = isObject(command.input) ? stringValue(command.input.hint) : "";
    commands.set(name, {
      command: name,
      description: stringValue(command.description),
      takesArg: argHint !== "",
      argHint,
      common: false,
      // ACP does not tell us whether an arbitrary extension/file command is safe. Do not make a
      // one-tap action out of an unknown no-argument command.
      dangerous: argHint === "",
    });
  }
  return [...commands.values()].sort((left, right) => {
    if (left.common !== right.common) return left.common ? -1 : 1;
    return left.command < right.command ? -1 : left.command > right.command ? 1 : 0;
  });
}

function builtinArgument(command: BuiltinCommandDef): { takesArg: boolean; argHint: string } {
  const inlineHint = stringValue(command.inlineHint);
  if (inlineHint) return { takesArg: true, argHint: inlineHint };
  if (Array.isArray(command.subcommands) && command.subcommands.length > 0) {
    return { takesArg: true, argHint: "<subcommand>" };
  }
  return command.allowArgs === true
    ? { takesArg: true, argHint: "[arguments]" }
    : { takesArg: false, argHint: "" };
}


function commandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const bare = raw.startsWith("/") ? raw.slice(1) : raw;
  return bare && !/[\s/]/.test(bare) ? `/${bare}` : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function collectAcpCommands(
  child: OmpCommandProcess,
  cwd: string,
  signal: AbortSignal,
): Promise<AcpCommand[]> {
  if (!child.stdout) throw new Error("OMP ACP stdout is unavailable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sessionId: string | undefined;
  let sentNewSession = false;
  const cancel = () => void reader.cancel();
  signal.addEventListener("abort", cancel, { once: true });

  const consume = async (line: string): Promise<AcpCommand[] | null> => {
    let frame: unknown;
    try {
      frame = JSON.parse(line.replace(TERMINAL_CONTROL, ""));
    } catch {
      return null;
    }
    if (!isObject(frame)) return null;
    if (frame.id === 1) {
      if ("error" in frame)
        throw new Error(
          `OMP ACP initialize failed: ${isObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "unknown error"}`,
        );
      if (!sentNewSession) {
        sentNewSession = true;
        await child.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd, mcpServers: [] },
          })}\n`,
        );
      }
      return null;
    }
    if (frame.id === 2) {
      if ("error" in frame)
        throw new Error(
          `OMP ACP session creation failed: ${isObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "unknown error"}`,
        );
      if (!isObject(frame.result) || typeof frame.result.sessionId !== "string") {
        throw new Error("OMP ACP session creation returned no session id");
      }
      sessionId = frame.result.sessionId;
      return null;
    }
    if (!sessionId || frame.method !== "session/update" || !isObject(frame.params) || frame.params.sessionId !== sessionId) {
      return null;
    }
    const update = frame.params.update;
    if (!isObject(update) || update.sessionUpdate !== "available_commands_update" || !Array.isArray(update.availableCommands)) {
      return null;
    }
    return update.availableCommands.filter(isObject);
  };

  try {
    await child.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`,
    );
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const commands = await consume(line.trim());
        if (commands) return commands;
      }
      if (!done) continue;
      if (buffer.trim()) {
        const commands = await consume(buffer.trim());
        if (commands) return commands;
      }
      throw new Error("OMP ACP ended before advertising commands");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}


async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    controller.abort();
    timeout.reject(new Error("OMP command discovery timed out"));
  }, timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeChild(child: OmpCommandProcess, timeoutMs: number): Promise<void> {
  try {
    await child.closeInput();
  } catch {
    // Closing a process that already exited is still a successful cleanup.
  }
  if (await settlesWithin(child.exited, timeoutMs)) return;
  child.terminate();
  await settlesWithin(child.exited, timeoutMs);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
