import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type StartupBundleFailureCategory =
  | "missing_bundle"
  | "invalid_bundle_json"
  | "invalid_bundle_schema"
  | "missing_file"
  | "invalid_file_path"
  | "hash_mismatch"
  | "write_failed"
  | "entry_missing"
  | "empty_bundle";

export type StartupBundleRole = "identity" | "task" | "safety" | "persona" | "instructions";

export interface StartupBundleFileEntry {
  key: string;
  role: StartupBundleRole;
  pinned: boolean;
  path: string;
  sha256: string;
  bytes: number;
}

export interface StartupBundleDocument {
  version: 1;
  generatedAt: string;
  generator: string;
  entryFilePath: string;
  instructionsRootPath: string;
  loadOrder: string[];
  files: StartupBundleFileEntry[];
  tokenBudget: {
    maxEstimatedTokens: number;
    truncationOrder: StartupBundleRole[];
  };
}

export interface StartupPromptSection {
  key: string;
  role: StartupBundleRole;
  pinned: boolean;
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  order: number;
}

export interface StartupPromptPlan {
  orderedSectionKeys: string[];
  includedSections: StartupPromptSection[];
  droppedSectionKeys: string[];
  truncatedSectionKey: string | null;
  maxEstimatedTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export class StartupBundleError extends Error {
  readonly category: StartupBundleFailureCategory;
  readonly details: Record<string, unknown>;

  constructor(category: StartupBundleFailureCategory, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StartupBundleError";
    this.category = category;
    this.details = details;
  }
}

const STARTUP_BUNDLE_VERSION = 1 as const;
const CHARS_PER_TOKEN_ESTIMATE = 4;
export const DEFAULT_STARTUP_TOKEN_BUDGET = 12_000;

const TRUNCATION_ORDER: StartupBundleRole[] = [
  "identity",
  "task",
  "safety",
  "persona",
  "instructions",
];

const TRUNCATION_PRIORITY: Record<StartupBundleRole, number> = {
  identity: 0,
  task: 1,
  safety: 2,
  persona: 3,
  instructions: 4,
};

function isStartupBundleRole(value: unknown): value is StartupBundleRole {
  return value === "identity" || value === "task" || value === "safety" || value === "persona" || value === "instructions";
}

function toSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

function resolveInstructionsRootPath(instructionsFilePath: string): string {
  return `${path.dirname(instructionsFilePath)}/`;
}

function buildDeterministicCandidates(instructionsFilePath: string) {
  const entryFilePath = path.resolve(instructionsFilePath);
  const instructionsRootPath = resolveInstructionsRootPath(entryFilePath);

  const canonical: Array<{
    key: string;
    role: StartupBundleRole;
    fileName: string;
    pinned: boolean;
  }> = [
    { key: "identity", role: "identity" as const, fileName: "AGENTS.md", pinned: true },
    { key: "task", role: "task" as const, fileName: "HEARTBEAT.md", pinned: true },
    { key: "safety", role: "safety" as const, fileName: "TOOLS.md", pinned: true },
    { key: "persona", role: "persona" as const, fileName: "SOUL.md", pinned: false },
  ];

  const entryBase = path.basename(entryFilePath).toUpperCase();
  const hasCanonicalEntry = canonical.some((candidate) => candidate.fileName.toUpperCase() === entryBase);

  const withCanonical = canonical.map((candidate) => {
    const isEntry = candidate.fileName.toUpperCase() === entryBase;
    const resolvedPath = isEntry
      ? entryFilePath
      : path.resolve(instructionsRootPath, candidate.fileName);

    return {
      ...candidate,
      path: resolvedPath,
      required: isEntry,
    };
  });

  if (!hasCanonicalEntry) {
    withCanonical.unshift({
      key: "entry",
      role: "instructions",
      pinned: true,
      fileName: path.basename(entryFilePath),
      path: entryFilePath,
      required: true,
    });
  }

  return {
    entryFilePath,
    instructionsRootPath,
    candidates: withCanonical,
  };
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function truncateToEstimatedTokens(text: string, maxEstimatedTokens: number): string {
  if (maxEstimatedTokens <= 0) return "";
  const maxChars = Math.max(0, maxEstimatedTokens * CHARS_PER_TOKEN_ESTIMATE);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function readRequiredFile(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StartupBundleError(
      "missing_file",
      `Startup file is missing or unreadable: ${absPath}. ${reason}`,
      { path: absPath },
    );
  }
}

export async function buildStartupBundleFromInstructions(options: {
  instructionsFilePath: string;
  bundlePath: string;
  maxEstimatedTokens?: number;
  generator?: string;
}): Promise<{ bundle: StartupBundleDocument; sections: StartupPromptSection[] }> {
  const { entryFilePath, instructionsRootPath, candidates } = buildDeterministicCandidates(options.instructionsFilePath);
  const maxEstimatedTokens = normalizePositiveInteger(options.maxEstimatedTokens, DEFAULT_STARTUP_TOKEN_BUDGET);

  const seenPaths = new Set<string>();
  const sections: StartupPromptSection[] = [];

  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;

    const exists = await fs
      .stat(candidate.path)
      .then((stats: { isFile: () => boolean }) => stats.isFile())
      .catch(() => false);
    if (!exists) {
      if (candidate.required) {
        throw new StartupBundleError(
          "entry_missing",
          `Required startup entry file does not exist: ${candidate.path}`,
          { path: candidate.path },
        );
      }
      continue;
    }

    const content = await readRequiredFile(candidate.path);
    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = toSha256(content);

    sections.push({
      key: candidate.key,
      role: candidate.role,
      pinned: candidate.pinned,
      path: candidate.path,
      sha256,
      bytes,
      content,
      order: sections.length,
    });
    seenPaths.add(candidate.path);
  }

  if (sections.length === 0) {
    throw new StartupBundleError(
      "empty_bundle",
      `No startup files were resolved for ${entryFilePath}`,
      { entryFilePath },
    );
  }

  const bundle: StartupBundleDocument = {
    version: STARTUP_BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    generator: options.generator ?? "paperclip.codex_local.startup_bundle_builder",
    entryFilePath,
    instructionsRootPath,
    loadOrder: sections.map((section) => section.key),
    files: sections.map((section) => ({
      key: section.key,
      role: section.role,
      pinned: section.pinned,
      path: section.path,
      sha256: section.sha256,
      bytes: section.bytes,
    })),
    tokenBudget: {
      maxEstimatedTokens,
      truncationOrder: TRUNCATION_ORDER,
    },
  };

  const bundlePath = path.resolve(options.bundlePath);
  const bundleDir = path.dirname(bundlePath);
  const tempPath = `${bundlePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, bundlePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StartupBundleError(
      "write_failed",
      `Failed writing startup bundle at ${bundlePath}: ${reason}`,
      { bundlePath },
    );
  }

  return { bundle, sections };
}

function parseStartupBundle(raw: string, bundlePath: string): StartupBundleDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StartupBundleError(
      "invalid_bundle_json",
      `Startup bundle is not valid JSON: ${bundlePath}. ${reason}`,
      { bundlePath },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StartupBundleError(
      "invalid_bundle_schema",
      `Startup bundle must be a JSON object: ${bundlePath}`,
      { bundlePath },
    );
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== STARTUP_BUNDLE_VERSION) {
    throw new StartupBundleError(
      "invalid_bundle_schema",
      `Unsupported startup bundle version in ${bundlePath}: ${String(record.version)}`,
      { bundlePath, version: record.version },
    );
  }

  if (typeof record.entryFilePath !== "string" || record.entryFilePath.trim().length === 0) {
    throw new StartupBundleError(
      "invalid_bundle_schema",
      `Startup bundle entryFilePath is missing in ${bundlePath}`,
      { bundlePath },
    );
  }

  const loadOrder = Array.isArray(record.loadOrder)
    ? record.loadOrder.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const files = Array.isArray(record.files)
    ? (record.files as unknown[])
        .map((value) => (typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null))
        .filter((value): value is Record<string, unknown> => value !== null)
    : [];

  if (loadOrder.length === 0 || files.length === 0) {
    throw new StartupBundleError(
      "invalid_bundle_schema",
      `Startup bundle must include loadOrder and files: ${bundlePath}`,
      { bundlePath },
    );
  }

  const safeFiles: StartupBundleFileEntry[] = files.map((file) => {
    const key = typeof file.key === "string" ? file.key : "";
    const rawRole = file.role;
    const role: StartupBundleRole = isStartupBundleRole(rawRole) ? rawRole : "instructions";
    const pinned = typeof file.pinned === "boolean" ? file.pinned : role === "identity" || role === "task" || role === "safety";
    const filePath = typeof file.path === "string" ? file.path : "";
    const sha256 = typeof file.sha256 === "string" ? file.sha256 : "";
    const bytes = typeof file.bytes === "number" && Number.isFinite(file.bytes) ? Math.max(0, Math.floor(file.bytes)) : 0;
    return { key, role, pinned, path: filePath, sha256, bytes };
  });

  const tokenBudgetObject =
    typeof record.tokenBudget === "object" && record.tokenBudget !== null && !Array.isArray(record.tokenBudget)
      ? (record.tokenBudget as Record<string, unknown>)
      : {};
  const maxEstimatedTokens = normalizePositiveInteger(tokenBudgetObject.maxEstimatedTokens, DEFAULT_STARTUP_TOKEN_BUDGET);

  return {
    version: STARTUP_BUNDLE_VERSION,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date(0).toISOString(),
    generator: typeof record.generator === "string" ? record.generator : "paperclip.codex_local.startup_bundle_loader",
    entryFilePath: path.resolve(record.entryFilePath),
    instructionsRootPath: typeof record.instructionsRootPath === "string"
      ? record.instructionsRootPath
      : resolveInstructionsRootPath(path.resolve(record.entryFilePath)),
    loadOrder,
    files: safeFiles,
    tokenBudget: {
      maxEstimatedTokens,
      truncationOrder: TRUNCATION_ORDER,
    },
  };
}

export async function loadStartupBundleSections(options: {
  bundlePath: string;
  validateHashes?: boolean;
}): Promise<{ bundle: StartupBundleDocument; sections: StartupPromptSection[] }> {
  const bundlePath = path.resolve(options.bundlePath);
  const validateHashes = options.validateHashes !== false;

  const raw = await fs.readFile(bundlePath, "utf8").catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new StartupBundleError(
        "missing_bundle",
        `Startup bundle not found at ${bundlePath}. Generate it before startup or enable fallback.`,
        { bundlePath },
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new StartupBundleError(
      "missing_bundle",
      `Startup bundle could not be read at ${bundlePath}: ${reason}`,
      { bundlePath },
    );
  });

  const bundle = parseStartupBundle(raw, bundlePath);
  const filesByKey = new Map(bundle.files.map((entry) => [entry.key, entry]));

  const sections: StartupPromptSection[] = [];
  for (const key of bundle.loadOrder) {
    const file = filesByKey.get(key);
    if (!file) {
      throw new StartupBundleError(
        "invalid_bundle_schema",
        `Startup bundle loadOrder references missing file key "${key}" in ${bundlePath}`,
        { bundlePath, key },
      );
    }

    if (!path.isAbsolute(file.path)) {
      throw new StartupBundleError(
        "invalid_file_path",
        `Startup bundle path for "${key}" must be absolute: ${file.path}`,
        { bundlePath, key, path: file.path },
      );
    }

    const content = await readRequiredFile(file.path);
    const sha256 = toSha256(content);
    if (validateHashes && file.sha256 && sha256 !== file.sha256) {
      throw new StartupBundleError(
        "hash_mismatch",
        `Startup bundle hash mismatch for "${key}" at ${file.path}. Expected ${file.sha256}, got ${sha256}. Regenerate ${bundlePath}.`,
        { bundlePath, key, path: file.path, expectedSha256: file.sha256, actualSha256: sha256 },
      );
    }

    sections.push({
      key: file.key,
      role: file.role,
      pinned: file.pinned,
      path: file.path,
      sha256,
      bytes: Buffer.byteLength(content, "utf8"),
      content,
      order: sections.length,
    });
  }

  if (sections.length === 0) {
    throw new StartupBundleError(
      "empty_bundle",
      `Startup bundle ${bundlePath} did not load any files`,
      { bundlePath },
    );
  }

  return { bundle, sections };
}

export function applyStartupTokenBudget(options: {
  sections: StartupPromptSection[];
  maxEstimatedTokens: number;
}): StartupPromptPlan {
  const maxEstimatedTokens = normalizePositiveInteger(options.maxEstimatedTokens, DEFAULT_STARTUP_TOKEN_BUDGET);
  const ordered = [...options.sections].sort((left, right) => {
    const roleDelta = TRUNCATION_PRIORITY[left.role] - TRUNCATION_PRIORITY[right.role];
    if (roleDelta !== 0) return roleDelta;
    return left.order - right.order;
  });

  const estimatedTokensBefore = ordered.reduce((sum, section) => sum + estimateTokenCount(section.content), 0);
  const includedSections: StartupPromptSection[] = [];
  const droppedSectionKeys: string[] = [];
  let remainingTokens = maxEstimatedTokens;
  let truncatedSectionKey: string | null = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const section = ordered[index];
    const sectionTokens = estimateTokenCount(section.content);

    if (remainingTokens <= 0) {
      droppedSectionKeys.push(section.key);
      continue;
    }

    if (sectionTokens <= remainingTokens) {
      includedSections.push(section);
      remainingTokens -= sectionTokens;
      continue;
    }

    const truncatedContent = truncateToEstimatedTokens(section.content, remainingTokens);
    if (truncatedContent.length > 0) {
      includedSections.push({
        ...section,
        content: truncatedContent,
        bytes: Buffer.byteLength(truncatedContent, "utf8"),
      });
      truncatedSectionKey = section.key;
    } else {
      droppedSectionKeys.push(section.key);
    }

    for (let tailIndex = index + 1; tailIndex < ordered.length; tailIndex += 1) {
      droppedSectionKeys.push(ordered[tailIndex].key);
    }
    remainingTokens = 0;
    break;
  }

  const estimatedTokensAfter = includedSections.reduce((sum, section) => sum + estimateTokenCount(section.content), 0);

  return {
    orderedSectionKeys: ordered.map((section) => section.key),
    includedSections,
    droppedSectionKeys,
    truncatedSectionKey,
    maxEstimatedTokens,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
