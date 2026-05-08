import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  StartupBundleError,
  applyStartupTokenBudget,
  buildStartupBundleFromInstructions,
  loadStartupBundleSections,
  type StartupPromptSection,
} from "../packages/adapters/codex-local/src/server/startup-bundle.ts";

type ScenarioStatus = "pass" | "fail";

interface ScenarioResult {
  id: string;
  status: ScenarioStatus;
  reason: string;
  details?: Record<string, unknown>;
}

function parseArgs(argv: string[]) {
  let artifactPath = "artifacts/startup-failure-injection-report.json";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--artifact" && typeof argv[i + 1] === "string") {
      artifactPath = argv[i + 1];
      i += 1;
    }
  }
  return { artifactPath };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-startup-harness-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function toFailure(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function expectStartupBundleError(err: unknown, expectedCategory: string) {
  if (!(err instanceof StartupBundleError)) {
    throw new Error(`Expected StartupBundleError(${expectedCategory}), got ${toFailure(err)}`);
  }
  if (err.category !== expectedCategory) {
    throw new Error(`Expected category "${expectedCategory}", got "${err.category}"`);
  }
  return err;
}

async function runScenarioMissingFileAndPathClassification(): Promise<ScenarioResult> {
  try {
    const details = await withTempDir(async (dir) => {
      const instructionsPath = path.join(dir, "AGENTS.md");
      await fs.writeFile(instructionsPath, "# Agents\nIdentity\n", "utf8");
      await fs.writeFile(path.join(dir, "HEARTBEAT.md"), "# Heartbeat\nTasks\n", "utf8");
      await fs.writeFile(path.join(dir, "TOOLS.md"), "# Tools\nSafety\n", "utf8");

      const bundlePath = path.join(dir, "startup.bundle.json");
      await buildStartupBundleFromInstructions({
        instructionsFilePath: instructionsPath,
        bundlePath,
      });

      const heartbeatPath = path.join(dir, "HEARTBEAT.md");
      await fs.rm(heartbeatPath, { force: true });

      let missingFileCategory: string | null = null;
      try {
        await loadStartupBundleSections({ bundlePath, validateHashes: true });
      } catch (err) {
        missingFileCategory = expectStartupBundleError(err, "missing_file").category;
      }
      if (!missingFileCategory) {
        throw new Error("Expected missing_file classification but load succeeded.");
      }

      const raw = JSON.parse(await fs.readFile(bundlePath, "utf8")) as {
        files: Array<{ key: string; path: string }>;
      };
      const identity = raw.files.find((entry) => entry.key === "identity");
      if (!identity) throw new Error("startup bundle does not contain identity entry");
      identity.path = "relative/AGENTS.md";
      await fs.writeFile(bundlePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

      let invalidPathCategory: string | null = null;
      try {
        await loadStartupBundleSections({ bundlePath, validateHashes: true });
      } catch (err) {
        invalidPathCategory = expectStartupBundleError(err, "invalid_file_path").category;
      }
      if (!invalidPathCategory) {
        throw new Error("Expected invalid_file_path classification but load succeeded.");
      }

      return {
        bundlePath,
        observedCategories: [missingFileCategory, invalidPathCategory],
      };
    });

    return {
      id: "missing-file-path-classification",
      status: "pass",
      reason: "Startup bundle loader classifies missing file and invalid path deterministically.",
      details,
    };
  } catch (err) {
    return {
      id: "missing-file-path-classification",
      status: "fail",
      reason: toFailure(err),
    };
  }
}

function makeSection(
  key: StartupPromptSection["key"],
  role: StartupPromptSection["role"],
  order: number,
  chars: number,
): StartupPromptSection {
  const char = key.slice(0, 1) || "x";
  return {
    key,
    role,
    pinned: role === "identity" || role === "task" || role === "safety",
    path: `/tmp/${key}.md`,
    sha256: `${key}-sha`,
    bytes: chars,
    content: char.repeat(chars),
    order,
  };
}

async function runScenarioLongMemoryPressureTruncation(): Promise<ScenarioResult> {
  try {
    const maxEstimatedTokens = 90;
    const sections: StartupPromptSection[] = [
      makeSection("persona", "persona", 3, 320),
      makeSection("identity", "identity", 0, 160),
      makeSection("instructions", "instructions", 4, 240),
      makeSection("safety", "safety", 2, 240),
      makeSection("task", "task", 1, 160),
    ];

    const plan = applyStartupTokenBudget({ sections, maxEstimatedTokens });
    const includedKeys = plan.includedSections.map((section) => section.key);
    const expectedOrder = ["identity", "task", "safety", "persona", "instructions"];
    const expectedIncluded = ["identity", "task", "safety"];
    const expectedDropped = ["persona", "instructions"];

    if (JSON.stringify(plan.orderedSectionKeys) !== JSON.stringify(expectedOrder)) {
      throw new Error(`unexpected section order: ${plan.orderedSectionKeys.join(",")}`);
    }
    if (JSON.stringify(includedKeys) !== JSON.stringify(expectedIncluded)) {
      throw new Error(`unexpected included sections: ${includedKeys.join(",")}`);
    }
    if (plan.truncatedSectionKey !== "safety") {
      throw new Error(`expected truncated section "safety", got "${String(plan.truncatedSectionKey)}"`);
    }
    if (JSON.stringify(plan.droppedSectionKeys) !== JSON.stringify(expectedDropped)) {
      throw new Error(`unexpected dropped sections: ${plan.droppedSectionKeys.join(",")}`);
    }
    if (plan.estimatedTokensAfter > maxEstimatedTokens) {
      throw new Error(
        `token budget overflow: ${plan.estimatedTokensAfter} > ${maxEstimatedTokens}`,
      );
    }

    return {
      id: "long-memory-pressure-truncation",
      status: "pass",
      reason: "Pinned-first startup order and truncation behavior are deterministic under low token budget.",
      details: {
        maxEstimatedTokens,
        estimatedTokensBefore: plan.estimatedTokensBefore,
        estimatedTokensAfter: plan.estimatedTokensAfter,
        orderedSectionKeys: plan.orderedSectionKeys,
        includedSectionKeys: includedKeys,
        droppedSectionKeys: plan.droppedSectionKeys,
        truncatedSectionKey: plan.truncatedSectionKey,
      },
    };
  } catch (err) {
    return {
      id: "long-memory-pressure-truncation",
      status: "fail",
      reason: toFailure(err),
    };
  }
}

async function main() {
  const { artifactPath } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const results = await Promise.all([
    runScenarioMissingFileAndPathClassification(),
    runScenarioLongMemoryPressureTruncation(),
  ]);

  const passCount = results.filter((result) => result.status === "pass").length;
  const failCount = results.length - passCount;
  const summaryStatus: ScenarioStatus = failCount === 0 ? "pass" : "fail";
  const artifact = {
    harness: "paperclip.codex_local.startup_failure_injection",
    generatedAt: new Date().toISOString(),
    startedAt,
    command: "pnpm qa:startup-failure-injection-harness",
    summary: {
      status: summaryStatus,
      passCount,
      failCount,
      total: results.length,
    },
    results,
  };

  const artifactAbsPath = path.resolve(artifactPath);
  await fs.mkdir(path.dirname(artifactAbsPath), { recursive: true });
  await fs.writeFile(artifactAbsPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  for (const result of results) {
    const prefix = result.status === "pass" ? "PASS" : "FAIL";
    console.log(`${prefix} ${result.id}: ${result.reason}`);
  }
  console.log(`artifact: ${artifactAbsPath}`);

  if (failCount > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(`fatal: ${toFailure(err)}`);
  process.exit(1);
});
