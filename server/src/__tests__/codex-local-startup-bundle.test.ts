import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  StartupBundleError,
  applyStartupTokenBudget,
  buildStartupBundleFromInstructions,
  loadStartupBundleSections,
  type StartupPromptSection,
} from "@paperclipai/adapter-codex-local/server";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-startup-bundle-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("codex startup bundle", () => {
  it("builds deterministic bundle with absolute paths and hashes", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agents\nIdentity instructions\n", "utf8");
      await fs.writeFile(path.join(dir, "HEARTBEAT.md"), "# Heartbeat\nTask loop\n", "utf8");
      await fs.writeFile(path.join(dir, "TOOLS.md"), "# Tools\nSafety constraints\n", "utf8");
      await fs.writeFile(path.join(dir, "SOUL.md"), "# Soul\nPersona details\n", "utf8");

      const bundlePath = path.join(dir, "startup.bundle.json");
      const result = await buildStartupBundleFromInstructions({
        instructionsFilePath: path.join(dir, "AGENTS.md"),
        bundlePath,
        maxEstimatedTokens: 5000,
      });

      expect(result.bundle.loadOrder).toEqual(["identity", "task", "safety", "persona"]);
      expect(result.sections).toHaveLength(4);
      for (const section of result.sections) {
        expect(path.isAbsolute(section.path)).toBe(true);
        expect(section.sha256).toMatch(/^[a-f0-9]{64}$/);
      }

      const rawBundle = JSON.parse(await fs.readFile(bundlePath, "utf8")) as { files: Array<{ path: string }> };
      expect(rawBundle.files.every((file) => path.isAbsolute(file.path))).toBe(true);
    });
  });

  it("raises actionable hash mismatch when startup files drift", async () => {
    await withTempDir(async (dir) => {
      const agentsPath = path.join(dir, "AGENTS.md");
      const heartbeatPath = path.join(dir, "HEARTBEAT.md");
      const toolsPath = path.join(dir, "TOOLS.md");
      await fs.writeFile(agentsPath, "# Agents\n", "utf8");
      await fs.writeFile(heartbeatPath, "# Heartbeat\n", "utf8");
      await fs.writeFile(toolsPath, "# Tools\n", "utf8");

      const bundlePath = path.join(dir, "startup.bundle.json");
      await buildStartupBundleFromInstructions({ instructionsFilePath: agentsPath, bundlePath });

      await fs.writeFile(heartbeatPath, "# Heartbeat\nchanged\n", "utf8");

      await expect(
        loadStartupBundleSections({ bundlePath, validateHashes: true }),
      ).rejects.toMatchObject({
        name: "StartupBundleError",
        category: "hash_mismatch",
      } satisfies Partial<StartupBundleError>);
    });
  });

  it("applies deterministic startup token budget with pinned-first truncation", () => {
    const sections: StartupPromptSection[] = [
      {
        key: "identity",
        role: "identity",
        pinned: true,
        path: "/tmp/AGENTS.md",
        sha256: "a",
        bytes: 40,
        content: "a".repeat(40),
        order: 0,
      },
      {
        key: "task",
        role: "task",
        pinned: true,
        path: "/tmp/HEARTBEAT.md",
        sha256: "b",
        bytes: 40,
        content: "b".repeat(40),
        order: 1,
      },
      {
        key: "safety",
        role: "safety",
        pinned: true,
        path: "/tmp/TOOLS.md",
        sha256: "c",
        bytes: 40,
        content: "c".repeat(40),
        order: 2,
      },
      {
        key: "persona",
        role: "persona",
        pinned: false,
        path: "/tmp/SOUL.md",
        sha256: "d",
        bytes: 40,
        content: "d".repeat(40),
        order: 3,
      },
    ];

    const plan = applyStartupTokenBudget({ sections, maxEstimatedTokens: 25 });

    expect(plan.orderedSectionKeys).toEqual(["identity", "task", "safety", "persona"]);
    expect(plan.includedSections.map((section) => section.key)).toEqual(["identity", "task", "safety"]);
    expect(plan.truncatedSectionKey).toBe("safety");
    expect(plan.droppedSectionKeys).toEqual(["persona"]);
    expect(plan.estimatedTokensAfter).toBeLessThanOrEqual(25);
  });
});
