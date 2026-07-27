import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKSPACE_ROOT = path.resolve(process.cwd());
const MAX_FILE_CHARS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_LISTED_FILES = 500;
const DENIED_SEGMENTS = new Set([".git", ".next", "node_modules", "output"]);

type ToolResult = {
  ok: boolean;
  summary: string;
  content?: string;
  error?: string;
};

type JsonSchema = Record<string, unknown>;

function functionTool(name: string, description: string, properties: JsonSchema, required: string[] = []) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export const CODING_TOOLS = [
  functionTool(
    "set_working_directory",
    "Switch the active local directory for subsequent file and validation tools. Use this whenever the user specifies an absolute local folder.",
    {
      path: { type: "string", description: "Absolute path to the local directory requested by the user." },
    },
    ["path"],
  ),
  functionTool(
    "list_files",
    "List files recursively from the active local directory. Build artifacts and secrets are excluded.",
    {
      path: { type: "string", description: "Path relative to the active local directory, or empty for its root." },
      depth: { type: "integer", minimum: 1, maximum: 8, description: "Maximum recursion depth." },
    },
    ["path", "depth"],
  ),
  functionTool(
    "search_files",
    "Search text across readable project files. Returns matching file names, line numbers, and excerpts.",
    {
      query: { type: "string", description: "Literal text to search for." },
      path: { type: "string", description: "Directory or file relative to the active local directory, or empty for its root." },
      case_sensitive: { type: "boolean", description: "Whether matching is case-sensitive." },
    },
    ["query", "path", "case_sensitive"],
  ),
  functionTool(
    "read_file",
    "Read a UTF-8 project file with line numbers. Use line ranges for large files.",
    {
      path: { type: "string", description: "File path relative to the active local directory." },
      start_line: { type: "integer", minimum: 1, description: "First line to return." },
      end_line: { type: "integer", minimum: 1, description: "Last line to return, inclusive." },
    },
    ["path", "start_line", "end_line"],
  ),
  functionTool(
    "replace_in_file",
    "Edit an existing UTF-8 file by replacing exact text. The operation fails if old_text is absent or ambiguous unless replace_all is true.",
    {
      path: { type: "string", description: "File path relative to the active local directory." },
      old_text: { type: "string", description: "Exact current text to replace." },
      new_text: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
    },
    ["path", "old_text", "new_text", "replace_all"],
  ),
  functionTool(
    "create_file",
    "Create a new UTF-8 project file. It will not overwrite an existing file.",
    {
      path: { type: "string", description: "New file path relative to the active local directory." },
      content: { type: "string", description: "Complete UTF-8 file contents." },
    },
    ["path", "content"],
  ),
  functionTool(
    "git_diff",
    "Show the current unstaged Git diff for the active local directory or one relative path.",
    {
      path: { type: "string", description: "Path relative to the active local directory, or empty for all changes." },
    },
    ["path"],
  ),
  functionTool(
    "run_check",
    "Run an approved non-interactive project validation command.",
    {
      check: { type: "string", enum: ["typecheck", "build", "diff-check"], description: "Validation to run." },
    },
    ["check"],
  ),
] as const;

function truncate(value: string, max = MAX_TOOL_OUTPUT_CHARS) {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[输出已截断]`;
}

function parseArgs(raw: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeRelativePath(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\.\//, "") : "";
}

function isDenied(relativePath: string) {
  const parts = relativePath.toLowerCase().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return parts.some((part) => DENIED_SEGMENTS.has(part))
    || name === ".env"
    || name.startsWith(".env.")
    || [".npmrc", ".yarnrc", ".pypirc", "credentials.json"].includes(name)
    || /\.(pem|key|p12|pfx)$/i.test(name);
}

function isPathInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveCodingWorkspaceRoot(rawRoot: unknown) {
  const requested = typeof rawRoot === "string" ? rawRoot.trim() : "";
  if (!requested) return DEFAULT_WORKSPACE_ROOT;
  if (!path.isAbsolute(requested)) throw new Error("本地目录必须使用绝对路径");
  const resolved = await fs.realpath(path.resolve(requested));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("本地路径不是文件夹");
  return resolved;
}

export async function switchCodingWorkingDirectory(rawArguments: string) {
  const args = parseArgs(rawArguments);
  const workspaceRoot = await resolveCodingWorkspaceRoot(args.path);
  return {
    workspaceRoot,
    result: { ok: true, summary: `已切换到 ${workspaceRoot}`, content: workspaceRoot } satisfies ToolResult,
  };
}

function resolveWorkspacePath(workspaceRoot: string, rawPath: unknown, allowRoot = false) {
  const relativePath = normalizeRelativePath(rawPath);
  if ((!relativePath && !allowRoot) || path.isAbsolute(relativePath) || isDenied(relativePath)) {
    throw new Error("路径无效或受保护");
  }
  const absolutePath = path.resolve(workspaceRoot, relativePath || ".");
  if (!isPathInside(workspaceRoot, absolutePath)) {
    throw new Error("禁止访问当前工作目录之外的相对路径，请先切换目录");
  }
  return { relativePath, absolutePath };
}

async function resolveExistingWorkspacePath(workspaceRoot: string, rawPath: unknown, allowRoot = false) {
  const resolved = resolveWorkspacePath(workspaceRoot, rawPath, allowRoot);
  const realPath = await fs.realpath(resolved.absolutePath);
  if (!isPathInside(workspaceRoot, realPath)) throw new Error("禁止通过符号链接绕出当前工作目录，请先切换目录");
  return { ...resolved, absolutePath: realPath };
}

async function collectFiles(workspaceRoot: string, relativeRoot: string, maxDepth: number) {
  const files: string[] = [];
  const walk = async (relativeDirectory: string, depth: number) => {
    if (depth > maxDepth || files.length >= MAX_LISTED_FILES) return;
    const { absolutePath } = await resolveExistingWorkspacePath(workspaceRoot, relativeDirectory, true);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory.replace(/\\/g, "/"), entry.name).replace(/^\//, "");
      if (isDenied(relativePath)) continue;
      if (entry.isDirectory()) await walk(relativePath, depth + 1);
      else if (entry.isFile()) files.push(relativePath);
      if (files.length >= MAX_LISTED_FILES) break;
    }
  };
  await walk(relativeRoot, 1);
  return files;
}

async function readUtf8File(workspaceRoot: string, rawPath: unknown) {
  const resolved = await resolveExistingWorkspacePath(workspaceRoot, rawPath);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > MAX_FILE_CHARS * 4) throw new Error("文件过大，请缩小读取范围或使用搜索");
  const content = await fs.readFile(resolved.absolutePath, "utf8");
  if (content.includes("\0")) throw new Error("不支持读取二进制文件");
  return { ...resolved, content };
}

async function runProgram(workspaceRoot: string, file: string, args: string[], timeout: number) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: workspaceRoot,
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, output: truncate(`${result.stdout || ""}${result.stderr || ""}`.trim()) };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    return {
      ok: false,
      output: truncate(`${failure.stdout || ""}${failure.stderr || ""}${failure.message || ""}`.trim()),
    };
  }
}

export function codingToolLabel(name: string, rawArguments: string) {
  const args = parseArgs(rawArguments);
  const target = normalizeRelativePath(args.path);
  switch (name) {
    case "set_working_directory": return `切换本地目录 · ${String(args.path ?? "").slice(0, 120)}`;
    case "list_files": return `浏览项目文件${target ? ` · ${target}` : ""}`;
    case "search_files": return `搜索代码 · ${String(args.query ?? "").slice(0, 40)}`;
    case "read_file": return `读取文件 · ${target}`;
    case "replace_in_file": return `修改文件 · ${target}`;
    case "create_file": return `创建文件 · ${target}`;
    case "git_diff": return `检查代码差异${target ? ` · ${target}` : ""}`;
    case "run_check": return `运行验证 · ${String(args.check ?? "")}`;
    default: return `调用工具 · ${name}`;
  }
}

export async function executeCodingTool(name: string, rawArguments: string, workspaceRoot = DEFAULT_WORKSPACE_ROOT): Promise<ToolResult> {
  const args = parseArgs(rawArguments);
  try {
    if (name === "list_files") {
      const root = normalizeRelativePath(args.path);
      resolveWorkspacePath(workspaceRoot, root, true);
      const depth = Math.max(1, Math.min(8, Number(args.depth) || 4));
      const files = await collectFiles(workspaceRoot, root, depth);
      return { ok: true, summary: `找到 ${files.length} 个文件`, content: files.join("\n") };
    }

    if (name === "search_files") {
      const query = String(args.query ?? "");
      if (!query || query.length > 500) throw new Error("搜索内容为空或过长");
      const target = await resolveExistingWorkspacePath(workspaceRoot, args.path, true);
      const stat = await fs.stat(target.absolutePath);
      const files = stat.isFile() ? [target.relativePath] : await collectFiles(workspaceRoot, target.relativePath, 8);
      const needle = args.case_sensitive === true ? query : query.toLowerCase();
      const matches: string[] = [];
      for (const file of files) {
        if (matches.length >= 200) break;
        try {
          const { content } = await readUtf8File(workspaceRoot, file);
          content.split(/\r?\n/).forEach((line, index) => {
            if (matches.length >= 200) return;
            const haystack = args.case_sensitive === true ? line : line.toLowerCase();
            if (haystack.includes(needle)) matches.push(`${file}:${index + 1}: ${line.trim().slice(0, 300)}`);
          });
        } catch {
          // Ignore binary, protected, and oversized files during project-wide search.
        }
      }
      return { ok: true, summary: `找到 ${matches.length} 处匹配`, content: matches.join("\n") || "无匹配" };
    }

    if (name === "read_file") {
      const file = await readUtf8File(workspaceRoot, args.path);
      const lines = file.content.split(/\r?\n/);
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(lines.length, Math.max(start, Number(args.end_line) || start + 399));
      const content = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
      return { ok: true, summary: `${file.relativePath} · 第 ${start}-${end} 行，共 ${lines.length} 行`, content: truncate(content) };
    }

    if (name === "replace_in_file") {
      const file = await readUtf8File(workspaceRoot, args.path);
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!oldText) throw new Error("old_text 不能为空");
      const occurrences = file.content.split(oldText).length - 1;
      if (!occurrences) throw new Error("未找到要替换的精确文本，请重新读取文件");
      if (occurrences > 1 && args.replace_all !== true) throw new Error(`目标文本出现 ${occurrences} 次，请提供更长的唯一上下文`);
      const updated = args.replace_all === true ? file.content.split(oldText).join(newText) : file.content.replace(oldText, newText);
      await fs.writeFile(file.absolutePath, updated, "utf8");
      return { ok: true, summary: `已修改 ${file.relativePath}（替换 ${args.replace_all === true ? occurrences : 1} 处）` };
    }

    if (name === "create_file") {
      const target = resolveWorkspacePath(workspaceRoot, args.path);
      const content = String(args.content ?? "");
      if (content.length > MAX_FILE_CHARS) throw new Error("新文件内容过大");
      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
      await fs.writeFile(target.absolutePath, content, { encoding: "utf8", flag: "wx" });
      return { ok: true, summary: `已创建 ${target.relativePath}` };
    }

    if (name === "git_diff") {
      const target = normalizeRelativePath(args.path);
      if (target) resolveWorkspacePath(workspaceRoot, target);
      const result = await runProgram(workspaceRoot, "git", ["diff", "--", ...(target ? [target] : [])], 20_000);
      return { ok: result.ok, summary: result.ok ? "已读取当前代码差异" : "读取 Git diff 失败", content: result.output };
    }

    if (name === "run_check") {
      const check = String(args.check ?? "");
      const command = check === "typecheck"
        ? { file: process.execPath, args: [path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], timeout: 120_000 }
        : check === "build"
          ? { file: process.execPath, args: [path.join(workspaceRoot, "node_modules", "next", "dist", "bin", "next"), "build"], timeout: 240_000 }
          : check === "diff-check"
            ? { file: "git", args: ["diff", "--check"], timeout: 20_000 }
            : null;
      if (!command) throw new Error("不支持的验证命令");
      const result = await runProgram(workspaceRoot, command.file, command.args, command.timeout);
      return { ok: result.ok, summary: result.ok ? `${check} 验证通过` : `${check} 验证失败`, content: result.output };
    }

    throw new Error(`未知工具：${name}`);
  } catch (error) {
    return { ok: false, summary: `${name} 执行失败`, error: (error as Error)?.message || "未知错误" };
  }
}
