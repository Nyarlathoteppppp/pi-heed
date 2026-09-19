import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ToolAction } from "./types.ts";

// Deterministic side-effect classification. Jev scored "edit changes files" at ~0.7 in a
// smoke test, so this stays rule-based; the model is only asked the semantic questions.

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

const MUTATING_BASH: RegExp[] = [
	/(?<![0-9&>])>{1,2}(?!\s*&|\s*\/dev\/null)\s*[^\s&|;]/, // redirect into a file (not 2>&1, not /dev/null)
	/\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|tee|patch|unzip|tar\s+-?x)\b/,
	/\bsed\s+(?:-[a-zA-Z]*i|--in-place)/,
	/\bfind\b.*\s-(?:delete\b|exec(?:dir)?\s+(?:rm|mv|cp|chmod|chown|sed|perl|truncate|tee)\b)/,
	/\bperl\s+-[a-zA-Z]*i/,
	/\bgit\s+(?:commit|push|reset|checkout|switch|merge|rebase|apply|am|stash|add|rm|mv|restore|clean|cherry-pick|revert|tag|branch\s+-[dDmM])\b/,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|uninstall|update|upgrade|link|publish)\b/,
	/\b(?:pip3?|uv\s+pip|poetry|pipenv)\s+(?:install|uninstall|add|remove)\b/,
	/\buv\s+(?:add|remove|sync)\b/,
	/\b(?:cargo\s+(?:add|remove|install)|go\s+(?:get|install|mod\s+tidy)|brew\s+(?:install|uninstall|upgrade)|gem\s+install|apt(?:-get)?\s+install)\b/,
	/\bcurl\b.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s)/,
	/\b(?:docker|kubectl)\s+(?:rm|run|apply|delete|push|compose\s+(?:up|down))\b/,
];

const DEP_INSTALL: RegExp[] = [
	/\b(?:npm|pnpm|bun)\s+(?:install|i|add)\s+(?:-\S+\s+)*[^-\s]/,
	/\byarn\s+add\b/,
	/\b(?:pip3?|uv\s+pip)\s+install\s+(?!-r\b)(?!-e\s+\.)(?:-\S+\s+)*[^-\s]/,
	/\b(?:uv|poetry)\s+add\b/,
	/\b(?:cargo\s+add|go\s+get|gem\s+install|brew\s+install|apt(?:-get)?\s+install)\b/,
];

const GIT_PUSH = /\bgit\s+push\b/;
const GIT_COMMIT = /\bgit\s+commit\b/;
const RUNS_TESTS = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|jest|vitest|mocha|rspec|phpunit)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/;

const INTERPRETER = String.raw`\b(?:python3?|node|ruby|perl|bun|deno)\b`;
// Code handed to an interpreter inline: a heredoc body, or the string after -c / -e / -p.
const HEREDOC = new RegExp(String.raw`(${INTERPRETER}[^\n]*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3(?=\s|'|"|$)`, "g");
const INLINE = new RegExp(String.raw`(${INTERPRETER}(?:\s+-[A-Za-z]+)*?\s+-[cep]\s+)(['"])([\s\S]*?)(?<!\\)\2`, "g");
// Side effects inside interpreter code. Comparisons like "x > 3" are not redirects.
const CODE_WRITES: RegExp[] = [
	/\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]/,
	/\.(?:write_text|write_bytes|unlink|rmdir|mkdir|rename|replace|touch)\s*\(/,
	/\b(?:os\.(?:remove|unlink|rmdir|removedirs|rename|replace|makedirs|mkdir|system|popen)|shutil\.\w+|subprocess\.\w+)\s*\(/,
	/\b(?:fs|fsp|fs\.promises)\.(?:writeFile|appendFile|unlink|rm|rmdir|mkdir|rename|copyFile|cp)(?:Sync)?\s*\(/,
	/\b(?:writeFileSync|appendFileSync|unlinkSync|rmSync|mkdirSync|renameSync|execSync|spawnSync|exec|spawn)\s*\(/,
	/\bFile\.(?:write|delete|rename)\b|\bFileUtils\./,
	/\b(?:requests|httpx)\.(?:post|put|patch|delete)\s*\(|\bfetch\s*\([^)]*method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/i,
];

/** Separates inline interpreter code from the surrounding shell so each is judged by its own rules. */
export function splitInterpreterCode(command: string): { shell: string; code: string[] } {
	const code: string[] = [];
	let shell = command.replace(HEREDOC, (_m, head: string, _q: string, _tag: string, body: string) => {
		code.push(body);
		return `${head}<<CODE `;
	});
	shell = shell.replace(INLINE, (_m, head: string, _q: string, body: string) => {
		code.push(body);
		return `${head}CODE`;
	});
	return { shell, code };
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

// Tools that rewrite the files they are given. [command, what makes it write (or null: writes by default), what makes it not]
const WRITERS: Array<[RegExp, RegExp | null, RegExp | null]> = [
	[/\bprettier\b/, /\s(?:--write|-w)\b/, null],
	[/\b(?:eslint|stylelint|biome\s+(?:check|lint|format)|oxlint)\b/, /\s(?:--fix|--write|--apply)\b/, null],
	[/\bruff\s+check\b/, /\s--fix\b/, null],
	[/\bruff\s+format\b/, null, /\s(?:--check|--diff)\b/],
	[/\b(?:black|isort|autopep8|yapf)\b/, null, /\s(?:--check|--diff|-c)\b/],
	[/\b(?:gofmt|goimports)\b/, /\s-w\b/, null],
	[/\bgo\s+(?:fmt|generate)\b/, null, null],
	[/\bcargo\s+(?:fmt|fix|clippy\s+.*--fix)\b/, null, /\s--check\b/],
	[/\b(?:rustfmt)\b/, null, /\s--check\b/],
	[/\bclang-format\b/, /\s-i\b/, null],
	[/\bswiftformat\b|\bswiftlint\s+--fix\b|\bswiftlint\s+autocorrect\b/, null, /\s--lint\b/],
	[/\btsc\b/, null, /\s--noEmit\b|\s-p\s+\S*noemit/i],
];
/** Script names that build, format or generate: they write even when their body can't be read. */
const WRITING_SCRIPT = /^(?:build|compile|dist|bundle|format|fmt|fix|lint:fix|prettier|gen|generate|codegen|migrate|seed|clean|release|prepare|postinstall)(?:[:-].*)?$/;
const RUN_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/;
const MAKE = /\bmake(?:\s+-\S+)*(?:\s+([\w.-]+))?/;
const READ_ONLY_TARGET = /^(?:test|tests|check|lint|help|list|print-.*|-n)$/;
const SCRIPT_FILE = /\b(?:node|python3?|ruby|perl|bun|deno\s+run|tsx|ts-node)(?:\s+-\S+)*\s+([\w./@-]+\.(?:m?[jt]s|cjs|py|rb|pl))\b/;

/** Writes that only show up once you know what a tool, a package script or a script file does. */
function indirectWrites(shell: string, cwd: string | undefined, depth = 0): boolean {
	for (const [cmd, on, off] of WRITERS) {
		if (!cmd.test(shell)) continue;
		if ((on ? on.test(shell) : true) && !(off && off.test(shell))) return true;
	}
	const run = shell.match(RUN_SCRIPT);
	if (run && !/^(?:install|i|add|ci|test|t|ls|list|view|info|outdated|audit|why|exec|x|dlx|create|init|publish)$/.test(run[1])) {
		const body = packageScript(run[1], cwd);
		if (body !== undefined && depth < 2) {
			const { shell: inner, code } = splitInterpreterCode(body);
			if (MUTATING_BASH.some((re) => re.test(withoutLiterals(inner))) || code.some((c) => CODE_WRITES.some((re) => re.test(c))) || indirectWrites(inner, cwd, depth + 1)) return true;
		} else if (WRITING_SCRIPT.test(run[1])) return true;
	}
	const make = shell.match(MAKE);
	if (make && !READ_ONLY_TARGET.test(make[1] ?? "")) return true;
	const file = shell.match(SCRIPT_FILE)?.[1];
	if (file && cwd) {
		const src = readSmall(isAbsolute(file) ? file : join(cwd, file));
		if (src !== undefined && CODE_WRITES.some((re) => re.test(src))) return true;
	}
	return false;
}

function packageScript(name: string, cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const raw = readSmall(join(cwd, "package.json"));
	if (raw === undefined) return undefined;
	try {
		const body = JSON.parse(raw)?.scripts?.[name];
		return typeof body === "string" ? body : undefined;
	} catch {
		return undefined;
	}
}

function readSmall(path: string): string | undefined {
	try {
		if (!existsSync(path) || statSync(path).size > 256_000) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function classify(toolName: string, input: Record<string, unknown>, cwd?: string): ToolAction {
	if (READ_TOOLS.has(toolName)) {
		const path = str(input.path) ?? str(input.pattern) ?? "";
		return { toolName, effect: "read", mutates: false, installsDeps: false, gitPush: false, gitCommit: false, runsTests: false, paths: path ? [path] : [], summary: `${toolName} ${path}`.trim() };
	}
	if (WRITE_TOOLS.has(toolName)) {
		const path = str(input.path) ?? str(input.file_path) ?? "";
		return { toolName, effect: "write", mutates: true, installsDeps: false, gitPush: false, gitCommit: false, runsTests: false, paths: path ? [path] : [], summary: `${toolName} ${path}`.trim() };
	}
	if (toolName === "bash") {
		const command = str(input.command) ?? "";
		const { shell, code } = splitInterpreterCode(command);
		const direct = MUTATING_BASH.some((re) => re.test(withoutLiterals(shell))) || code.some((c) => CODE_WRITES.some((re) => re.test(c)));
		const indirect = !direct && indirectWrites(withoutLiterals(shell), cwd);
		const mutates = direct || indirect;
		const ops = withoutLiterals(command);
		const installsDeps = DEP_INSTALL.some((re) => re.test(ops));
		// an indirect write goes wherever the tool decides: judge it on every path it mentions
		const writes = direct && !installsDeps ? writtenPaths(shell) : undefined;
		return {
			toolName,
			effect: "exec",
			mutates: mutates || installsDeps,
			installsDeps,
			gitPush: GIT_PUSH.test(ops),
			gitCommit: GIT_COMMIT.test(ops),
			runsTests: RUNS_TESTS.test(command),
			paths: extractPaths(command),
			...(writes && !code.length ? { writes } : {}),
			summary: `bash: ${truncate(command, 200)}`,
		};
	}
	// Extension/MCP tools: unknown side effects. Only semantic (Jev) checks apply.
	return { toolName, effect: "unknown", mutates: false, installsDeps: false, gitPush: false, gitCommit: false, runsTests: false, paths: [], summary: `${toolName} ${truncate(JSON.stringify(input), 200)}` };
}

// A string can still run as a command through these; then nothing is stripped.
const EVALUATES = /\b(?:sh|bash|zsh|dash|su|fish)\s+-\w*c\b|\b(?:ssh|eval|parallel|watch)\b|\b(?:docker|kubectl|podman)\s+exec\b|\bnpx\s+-c\b|\|\s*(?:sh|bash|zsh|xargs)\b|\bxargs\b|\$\(|`/;

/** The command without echo/printf arguments and quoted text, so "echo remember to git push" is not a push. */
export function withoutLiterals(command: string): string {
	if (EVALUATES.test(command)) return command;
	return command
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
		.replace(/\b(?:echo|printf)\b[^;&|\n>]*/g, "echo");
}

const SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;
const REDIRECT = /(?<![<>&])\d?>>?\s*([^\s;&|<>]+)/g;
/** Commands whose every non-flag argument is written to. */
const WRITES_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "chmod", "chown", "truncate", "mv", "tee", "unlink"]);
/** Commands that write only their last argument. */
const WRITES_LAST = new Set(["cp", "ln", "rsync", "install"]);
/** Commands that write nothing besides their redirects. */
const READS = new Set(["cat", "echo", "printf", "grep", "rg", "ls", "head", "tail", "wc", "sort", "uniq", "diff", "find", "jq", "awk", "cut", "tr", "node", "python", "python3", "true", "test", "["]);

/**
 * The paths a shell command writes, or undefined when some write cannot be read off the command
 * (cd, substitutions, sed -i, git, package managers, find -exec…): then callers fall back to every path mentioned.
 */
export function writtenPaths(shell: string): string[] | undefined {
	if (EVALUATES.test(shell) || /\bcd\b|\bpushd\b/.test(shell)) return undefined;
	const out: string[] = [];
	for (const raw of shell.split(SEGMENT_SPLIT)) {
		const segment = raw.trim();
		if (!segment) continue;
		for (const m of segment.matchAll(REDIRECT)) if (!m[1].startsWith("&") && !m[1].startsWith("/dev/")) out.push(unquote(m[1]));
		const words = segment.replace(REDIRECT, " ").trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
		if (words[0] === "sudo") words.shift();
		const [cmd = "", ...rest] = words;
		const args = rest.filter((a) => !a.startsWith("-")).map(unquote);
		if (WRITES_ALL.has(cmd)) out.push(...args);
		else if (WRITES_LAST.has(cmd)) {
			if (args.length) out.push(args.at(-1)!);
		} else if (READS.has(cmd)) {
			if (cmd === "find" && /-(?:delete|exec|execdir|ok|fprint)/.test(segment)) return undefined;
		} else if (MUTATING_BASH.some((re) => re.test(segment.replace(REDIRECT, " ")))) return undefined;
	}
	return out.length ? out : undefined;
}

function unquote(s: string): string {
	return s.replace(/^['"]|['"]$/g, "");
}

function extractPaths(command: string): string[] {
	// a bare directory is a path when it follows cd/pushd/find ("cd test && rm a.ts", "find test -delete")
	const dirs = [...command.matchAll(/\b(?:cd|pushd|find)\s+(?:-\S+\s+)*['"]?([\w@.-]+)\/?['"]?(?=\s|$|;|&|\|)/g)].map((m) => `${m[1]}/`).filter((d) => d !== "./" && d !== "../");
	return [...dirs, ...[...command.matchAll(/(?:^|\s)[\x60'"]?((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+|[\w@-]+\.[A-Za-z]{1,8})(?=[\x60'"]?(?:\s|$|;|\||&))/g)].map((m) => m[1])];
}

export function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[A-Za-z]+$|(?:^|\/)test_[\w-]+\.py$|_test\.(?:go|py)$/;
