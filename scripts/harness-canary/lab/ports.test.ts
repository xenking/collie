import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { binaryPath, HARNESSES, runDirs } from "./harnesses";
import { realPorts } from "./ports";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("COLLIE_LAB_BIN_<ID>: the lab runs an installed binary", () => {
  test("a relative override is resolved against the invocation folder, so the link does not dangle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lab-bin-"));
    made.push(root);
    const bin = join(root, "my-omp.sh");
    writeFileSync(bin, "#!/bin/sh\necho omp/18.11.3\n");
    chmodSync(bin, 0o755);
    const dirs = runDirs(join(root, "run"));
    const spec = HARNESSES["omp"]!;
    const ports = realPorts({ env: { COLLIE_LAB_BIN_OMP: relative(process.cwd(), bin), PATH: process.env.PATH } });
    expect(await ports.install(spec, dirs, "18.11.3", () => undefined)).toBe("18.11.3");
    expect(readlinkSync(binaryPath(dirs, spec))).toBe(bin);
    expect(lstatSync(binaryPath(dirs, spec)).isSymbolicLink()).toBe(true);
  });
});
