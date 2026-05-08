import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "@paperclipai/adapter-codex-local/server";
import type { AdapterInvocationMeta } from "@paperclipai/adapter-utils";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-startup-telemetry-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function createFakeCodexCommand(dir: string) {
  const commandPath = path.join(dir, "fake-codex.sh");
  await writeExecutable(
    commandPath,
    [
      "#!/bin/sh",
      "if [ -n \"$MARKER_PATH\" ]; then",
      "  echo invoked > \"$MARKER_PATH\"",
      "fi",
      "cat >/dev/null",
      "echo '{\"type\":\"thread.started\",\"thread_id\":\"thread-test\"}'",
      "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}'",
      "echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":11,\"cached_input_tokens\":3,\"output_tokens\":7}}'",
      "exit 0",
      "",
    ].join("\n"),
  );
  return commandPath;
}

function baseContext(config: Record<string, unknown>, onMeta: (meta: AdapterInvocationMeta) => Promise<void>) {
  return {
    runId: "run-test",
    agent: {
      id: "agent-test",
      companyId: "company-test",
      name: "Backend Engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: async () => {},
    onMeta,
  };
}

describe("codex startup telemetry contract", () => {
  it("serializes startup telemetry fields in adapter invocation metadata", async () => {
    await withTempDir(async (dir) => {
      const instructionsPath = path.join(dir, "AGENTS.md");
      await fs.writeFile(instructionsPath, "# Agents\nIdentity\n", "utf8");
      await fs.writeFile(path.join(dir, "HEARTBEAT.md"), "# Heartbeat\nTasks\n", "utf8");
      await fs.writeFile(path.join(dir, "TOOLS.md"), "# Tools\nSafety\n", "utf8");

      const bundlePath = path.join(dir, "startup.bundle.json");
      const codexHome = path.join(dir, ".codex-home");
      const command = await createFakeCodexCommand(dir);
      const seenMeta: AdapterInvocationMeta[] = [];

      const result = await execute(
        baseContext(
          {
            command,
            cwd: dir,
            instructionsFilePath: instructionsPath,
            startupBundlePath: bundlePath,
            startupBundleEnabled: true,
            startupBundleAutoBuild: true,
            startupBundleFallbackToLegacyInstructions: true,
            env: {
              CODEX_HOME: codexHome,
            },
          },
          async (meta) => {
            seenMeta.push(meta);
          },
        ),
      );

      expect(seenMeta).toHaveLength(1);
      const telemetry = seenMeta[0].startupTelemetry;
      expect(telemetry).toBeDefined();
      expect(telemetry?.startupFailureCategory).toBeNull();
      expect(typeof telemetry?.startupTokenEstimate).toBe("number");
      expect(telemetry?.selectedFiles.length ?? 0).toBeGreaterThan(0);
      for (const file of telemetry?.selectedFiles ?? []) {
        expect(path.isAbsolute(file.path)).toBe(true);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      }

      const resultTelemetry = (result.resultJson ?? {})["startupTelemetryContract"];
      expect(resultTelemetry).toEqual(telemetry);
    });
  });

  it("emits missing_bundle failure category when falling back to legacy instructions", async () => {
    await withTempDir(async (dir) => {
      const instructionsPath = path.join(dir, "AGENTS.md");
      await fs.writeFile(instructionsPath, "# Agents\nIdentity only\n", "utf8");

      const bundlePath = path.join(dir, "missing-startup.bundle.json");
      const codexHome = path.join(dir, ".codex-home");
      const command = await createFakeCodexCommand(dir);
      const seenMeta: AdapterInvocationMeta[] = [];

      await execute(
        baseContext(
          {
            command,
            cwd: dir,
            instructionsFilePath: instructionsPath,
            startupBundlePath: bundlePath,
            startupBundleEnabled: true,
            startupBundleAutoBuild: false,
            startupBundleFallbackToLegacyInstructions: true,
            env: {
              CODEX_HOME: codexHome,
            },
          },
          async (meta) => {
            seenMeta.push(meta);
          },
        ),
      );

      expect(seenMeta).toHaveLength(1);
      const telemetry = seenMeta[0].startupTelemetry;
      expect(telemetry?.startupFailureCategory).toBe("missing_bundle");
      expect(telemetry?.selectedFiles).toHaveLength(1);
      expect(telemetry?.selectedFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("publishes startup failure telemetry before aborting when fallback is disabled", async () => {
    await withTempDir(async (dir) => {
      const instructionsPath = path.join(dir, "AGENTS.md");
      await fs.writeFile(instructionsPath, "# Agents\nIdentity only\n", "utf8");

      const bundlePath = path.join(dir, "missing-startup.bundle.json");
      const codexHome = path.join(dir, ".codex-home");
      const markerPath = path.join(dir, "command-ran.marker");
      const command = await createFakeCodexCommand(dir);
      const seenMeta: AdapterInvocationMeta[] = [];

      await expect(
        execute(
          baseContext(
            {
              command,
              cwd: dir,
              instructionsFilePath: instructionsPath,
              startupBundlePath: bundlePath,
              startupBundleEnabled: true,
              startupBundleAutoBuild: false,
              startupBundleFallbackToLegacyInstructions: false,
              env: {
                CODEX_HOME: codexHome,
                MARKER_PATH: markerPath,
              },
            },
            async (meta) => {
              seenMeta.push(meta);
            },
          ),
        ),
      ).rejects.toThrow(/Startup bundle initialization failed \(missing_bundle\)/);

      expect(seenMeta).toHaveLength(1);
      expect(seenMeta[0].startupTelemetry?.startupFailureCategory).toBe("missing_bundle");
      const markerExists = await fs
        .stat(markerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(false);
    });
  });
});
