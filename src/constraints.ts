import type { Constraint, ConstraintKind } from "./types.ts";

// Rule-based extraction of explicit user constraints (English + Chinese).
// Deliberately narrow: an unrecognised instruction is better than a phantom one.

const NEG_EN = String.raw`(?:don'?t|do not|never|please don'?t|must not|mustn'?t)`;
const NEG_ZH = String.raw`(?:不要|别|不许|不准|禁止|先别|请勿|切勿)`;
const EDIT_EN = String.raw`(?:modify|modifying|change|changing|edit|editing|touch|touching|write|writing|alter|altering)`;
const EDIT_ZH = String.raw`(?:修改|改动|更改|改|动|写入|写)`;

const PATTERNS: Array<{ kind: Exclude<ConstraintKind, "custom" | "protect_path">; re: RegExp }> = [
	{ kind: "no_tests", re: new RegExp(String.raw`\b${NEG_EN}\s+(?:${EDIT_EN}|delete|remove|skip|disable)\s+(?:the\s+|any\s+|existing\s+)*tests?\b`, "i") },
	{ kind: "no_tests", re: new RegExp(String.raw`${NEG_ZH}(?:${EDIT_ZH}|删除|删|跳过|禁用)(?:任何|现有的?)?(?:单元)?测试`) },
	{ kind: "no_deps", re: new RegExp(String.raw`\b(?:${NEG_EN}\s+(?:add|install|introduce|pull in)|no|without\s+(?:adding|installing))\s+(?:any\s+)?(?:new\s+|extra\s+|additional\s+)?(?:dependencies|dependency|deps|packages?|libraries)\b`, "i") },
	{ kind: "no_deps", re: new RegExp(String.raw`(?:${NEG_ZH}|不)(?:安装|装|引入|添加|加)(?:任何|新的?|额外的?)*(?:第三方)?(?:依赖|包|库)`) },
	{ kind: "read_only", re: /\bread[- ]only\b/i },
	{ kind: "read_only", re: new RegExp(String.raw`\b${NEG_EN}\s+${EDIT_EN}\s+(?:any\s+|the\s+)?(?:files?|code|anything)\b`, "i") },
	{ kind: "read_only", re: /\bno (?:code |file )?changes\b/i },
	{ kind: "read_only", re: /只读/ },
	{ kind: "read_only", re: new RegExp(String.raw`${NEG_ZH}${EDIT_ZH}(?:任何)?(?:文件|代码)`) },
];

const PROTECT_EN = new RegExp(String.raw`\b${NEG_EN}\s+${EDIT_EN}\s+[\x60'"]?([\w@.-]*[\w-]\/[\w./@-]*|[\w@.-]+\.[A-Za-z]{1,8})[\x60'"]?`, "i");
const PROTECT_ZH = new RegExp(String.raw`${NEG_ZH}${EDIT_ZH}\s*[\x60'"]?([\w@.-]*[\w-]\/[\w./@-]*|[\w@.-]+\.[A-Za-z]{1,8})[\x60'"]?`);

const REVOKE: Array<{ kind: ConstraintKind; re: RegExp }> = [
	{ kind: "read_only", re: /\b(?:you can|you may|go ahead and|feel free to|now)\s+(?:edit|modify|change|write|fix|implement|apply)\b/i },
	{ kind: "read_only", re: /\b(?:apply|make) (?:the )?(?:fix|fixes|changes)\b/i },
	{ kind: "read_only", re: /(?<![不别])(?:可以|现在|开始|去|直接)(?:改|修改|动手|写|实现|修复)/ },
	{ kind: "no_tests", re: /\b(?:you can|you may|feel free to)\s+(?:edit|modify|change|update)\s+(?:the\s+)?tests?\b/i },
	{ kind: "no_tests", re: /(?<!不)可以(?:改|修改|动|更新)测试/ },
	{ kind: "no_deps", re: /\b(?:you can|you may|feel free to)\s+(?:add|install)\s+(?:new\s+)?(?:dependencies|packages?)\b/i },
	{ kind: "no_deps", re: /(?<!不)可以(?:装|安装|引入|加)(?:新)?(?:依赖|包)/ },
];

const CUSTOM_DIRECTIVE = new RegExp(String.raw`\b${NEG_EN}\b|\bavoid\b|${NEG_ZH}`, "i");
const NOT_A_CONSTRAINT = /don'?t worry|don'?t know|never mind|不要紧|别客气|别担心|别急/i;

function sentences(text: string): string[] {
	return text
		// ASCII punctuation only ends a sentence before whitespace, so "package.json" stays whole.
		.split(/(?<=[。！？；\n])|(?<=[.!?;])(?=\s|$)/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface IngestResult {
	added: Constraint[];
	revoked: Constraint[];
}

export class ConstraintLedger {
	private items: Constraint[] = [];
	private seq = 0;

	ingest(text: string, origin: Constraint["origin"] = "message"): IngestResult {
		const result: IngestResult = { added: [], revoked: [] };
		for (const sentence of sentences(text)) {
			// Revocations first, so "you can edit now, but don't touch tests" ends with only no_tests active.
			for (const { kind, re } of REVOKE) {
				if (!re.test(sentence)) continue;
				for (const c of this.items) {
					if (c.active && c.kind === kind) {
						c.active = false;
						result.revoked.push(c);
					}
				}
			}
			let matched = false;
			const protect = PROTECT_EN.exec(sentence) ?? PROTECT_ZH.exec(sentence);
			if (protect && !/^tests?$/i.test(protect[1])) {
				matched = true;
				const c = this.add("protect_path", sentence, origin, [protect[1]]);
				if (c) result.added.push(c);
			}
			for (const { kind, re } of PATTERNS) {
				if (!re.test(sentence)) continue;
				matched = true;
				const c = this.add(kind, sentence, origin);
				if (c) result.added.push(c);
				break;
			}
			if (!matched && CUSTOM_DIRECTIVE.test(sentence) && !NOT_A_CONSTRAINT.test(sentence) && sentence.length <= 240) {
				const c = this.add("custom", sentence, origin);
				if (c) result.added.push(c);
			}
		}
		return result;
	}

	add(kind: ConstraintKind, quote: string, origin: Constraint["origin"], paths?: string[]): Constraint | undefined {
		const duplicate = this.items.find(
			(c) => c.active && c.kind === kind && (kind === "custom" || kind === "protect_path" ? c.quote === quote : true),
		);
		if (duplicate) return undefined;
		const c: Constraint = { id: `c${++this.seq}`, kind, quote, active: true, origin, ...(paths ? { paths } : {}) };
		this.items.push(c);
		return c;
	}

	drop(id: string): boolean {
		const c = this.items.find((x) => x.id === id && x.active);
		if (!c) return false;
		c.active = false;
		return true;
	}

	active(): Constraint[] {
		return this.items.filter((c) => c.active);
	}

	reset(): void {
		this.items = [];
		this.seq = 0;
	}
}
