import { TEST_PATH } from "./actions.ts";
import type { ToolAction } from "./types.ts";

// Conversational policy state. Every change is an explicit op, applied in order and persisted in
// the session, so a rebuild replays to exactly the same state. Nothing is deleted: replaced
// policies become `superseded`, finished ones `expired`, both keeping who ended them and why.

export type Effect = "DENY" | "ALLOW" | "REQUIRE_CONFIRMATION" | "REQUIRE_BEFORE";
export type PolicyAction = "modify" | "install_deps" | "git_push" | "git_commit" | "custom";
export type Scope = "session" | "goal" | "run" | "once";
export type Status = "active" | "superseded" | "expired";
export type Prerequisite = "tests";

export interface Provenance {
	/** Index of the user message the policy came from. */
	at: number;
	/** Global creation order; newer wins ties. */
	seq: number;
	by: "rule" | "jev" | "command";
	/** Policy id or op that ended it. */
	endedBy?: string;
	endReason?: string;
}

export interface Policy {
	id: string;
	sourceQuote: string;
	effect: Effect;
	action: PolicyAction;
	/** "*" | "tests" | a path or directory | (custom) the prohibition text. */
	resource: string;
	scope: Scope;
	/** ALLOW policies that carve into this one (derived, for /heed explain). */
	exceptions: string[];
	status: Status;
	prerequisite?: Prerequisite;
	provenance: Provenance;
}

export interface PolicySpec {
	effect: Effect;
	action: PolicyAction;
	resource: string;
	scope: Scope;
	sourceQuote: string;
	prerequisite?: Prerequisite;
	by: Provenance["by"];
	at: number;
}

export type PolicyOp =
	| { op: "add"; spec: PolicySpec }
	/** Supersede the most recent active ALLOW ("never mind, revoke that permission"). */
	| { op: "revoke_allow"; quote: string; at: number; by: Provenance["by"] }
	/** Targeted end of one policy (Jev LIFT, /heed drop, rejected fake prohibition). */
	| { op: "supersede"; id: string; reason: string; by: Provenance["by"] }
	/** Change the scope of a policy (Jev: "this permission is only for this time"). */
	| { op: "rescope"; id: string; scope: Scope; by: Provenance["by"] }
	/** A once-permission was used. */
	| { op: "use"; id: string }
	/** The run or goal ended: expire policies with that scope. */
	| { op: "end"; scope: "run" | "goal"; /** only policies from messages before this index */ before?: number };

export interface Resolution {
	/** The deciding policy, when one applies. */
	policy?: Policy;
	/** The path it was decided for (undefined for path-less decisions). */
	target?: string;
	/** ALLOW policies that let the call through (to consume once-permissions). */
	allowIds: string[];
}

const RESTRICTIVE = new Set<Effect>(["DENY", "REQUIRE_CONFIRMATION", "REQUIRE_BEFORE"]);

export function isRestrictive(p: Policy): boolean {
	return RESTRICTIVE.has(p.effect);
}

function normPath(p: string): string {
	return p.replace(/^\.\//, "").replace(/\/$/, "");
}

/** True when `path` is `frag` or inside it on a path-segment boundary ("a.ts" matches "src/a.ts", not "data.ts"). */
export function pathMatches(path: string, frag: string): boolean {
	const p = normPath(path);
	const f = normPath(frag);
	return p === f || p.endsWith(`/${f}`) || p.startsWith(`${f}/`) || p.includes(`/${f}/`);
}

/** Higher = more specific. A single file beats any directory; deeper directories beat shallower. */
export function resourceSpecificity(resource: string): number {
	if (resource === "*") return 0;
	if (resource === "tests") return 1;
	const segs = normPath(resource).split("/").filter(Boolean);
	const isFile = /\.[A-Za-z0-9]{1,8}$/.test(segs.at(-1) ?? "");
	return 2 + segs.length + (isFile ? 50 : 0);
}

const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/**
 * A scratch file: an absolute path in a temp directory that is not inside the project. Blanket policies
 * ("don't modify anything") are about the project; writing a throwaway script to /tmp is not modifying it.
 * The project itself may live under /tmp, so the working directory always wins.
 */
export function isScratch(path: string, cwd?: string): boolean {
	if (!path.startsWith("/")) return false;
	const roots = [...TEMP_ROOTS, ...(process.env.TMPDIR ? [process.env.TMPDIR.replace(/\/?$/, "/")] : [])];
	if (!roots.some((r) => path.startsWith(r))) return false;
	return !(cwd && (path === cwd || path.startsWith(cwd.replace(/\/?$/, "/"))));
}

function actionSpecificity(a: PolicyAction): number {
	return a === "modify" ? 0 : 1;
}

/** Does policy resource `broad` cover `narrow`? */
function covers(broad: string, narrow: string): boolean {
	if (broad === "*") return true;
	if (broad === "tests") return narrow !== "*" && narrow !== "tests" && TEST_PATH.test(narrow);
	if (narrow === "*" || narrow === "tests") return false;
	return pathMatches(narrow, broad);
}

export class PolicyEngine {
	private policies: Policy[] = [];
	private seq = 0;

	apply(op: PolicyOp): string[] {
		switch (op.op) {
			case "add":
				return this.add(op.spec);
			case "revoke_allow": {
				const last = this.active()
					.filter((p) => p.effect === "ALLOW")
					.sort((a, b) => b.provenance.seq - a.provenance.seq)[0];
				return last ? [this.end(last, "superseded", `revoked: "${op.quote}"`)] : [];
			}
			case "supersede": {
				const p = this.get(op.id);
				return p?.status === "active" ? [this.end(p, "superseded", op.reason)] : [];
			}
			case "rescope": {
				const p = this.get(op.id);
				if (!p || p.status !== "active" || p.scope === op.scope) return [];
				const from = p.scope;
				p.scope = op.scope;
				return [`~${p.id} scope ${from} → ${op.scope}`];
			}
			case "use": {
				const p = this.get(op.id);
				return p?.status === "active" && p.scope === "once" ? [this.end(p, "expired", "used once")] : [];
			}
			case "end":
				return this.active()
					.filter((p) => p.scope === op.scope && (op.before === undefined || p.provenance.at < op.before))
					.map((p) => this.end(p, "expired", `${op.scope} ended`));
		}
	}

	private add(spec: PolicySpec): string[] {
		const same = this.active().filter((p) => p.action === spec.action && p.resource === spec.resource);
		const lines: string[] = [];
		const restrictive = RESTRICTIVE.has(spec.effect);
		// Exact duplicate with nothing contradicting it: keep the older one (its provenance is the original).
		// If a contradicting policy is active on the same thing, this is a RE-APPLY and goes through.
		const duplicate = same.some((p) => p.effect === spec.effect && p.scope === spec.scope && p.prerequisite === spec.prerequisite);
		const contradicted = same.some((p) => RESTRICTIVE.has(p.effect) !== restrictive);
		if (duplicate && !contradicted) return [];

		if (!restrictive && (spec.scope === "session" || spec.scope === "goal")) {
			// A lasting permission for exactly what was restricted is a LIFT: end the restriction,
			// don't store a redundant ALLOW.
			const lifted = same.filter((p) => RESTRICTIVE.has(p.effect));
			if (lifted.length) {
				for (const p of lifted) lines.push(this.end(p, "superseded", `lifted: "${spec.sourceQuote}"`));
				return lines;
			}
		}

		const p: Policy = {
			id: `p${++this.seq}`,
			sourceQuote: spec.sourceQuote,
			effect: spec.effect,
			action: spec.action,
			resource: spec.resource,
			scope: spec.scope,
			exceptions: [],
			status: "active",
			...(spec.prerequisite ? { prerequisite: spec.prerequisite } : {}),
			provenance: { at: spec.at, seq: this.seq, by: spec.by },
		};
		// A restriction on exactly this (re-apply), or a newer restriction of another kind, replaces
		// what was there. Temporary permissions (run/once) coexist and win by recency instead.
		if (restrictive) for (const q of same) lines.push(this.end(q, "superseded", `replaced by ${p.id}`, p.id));
		this.policies.push(p);
		if (spec.effect === "ALLOW") {
			for (const q of this.active()) {
				if (q !== p && isRestrictive(q) && (q.action === p.action || q.action === "modify") && covers(q.resource, p.resource) && q.resource !== p.resource) {
					q.exceptions.push(p.id);
				}
			}
		}
		lines.unshift(`+${p.id} ${describe(p)}`);
		return lines;
	}

	private end(p: Policy, status: Exclude<Status, "active">, reason: string, by?: string): string {
		p.status = status;
		p.provenance.endReason = reason;
		if (by) p.provenance.endedBy = by;
		return `-${p.id} ${status}: ${reason}`;
	}

	/**
	 * The deciding policy for a tool action. For each target path the most specific applicable policy
	 * wins (resource, then action, then recency). Any restricted target restricts the whole call.
	 */
	resolve(action: ToolAction, satisfied: (p: Prerequisite) => boolean = () => false, cwd?: string): Resolution {
		const candidates = this.active().filter((p) => p.action !== "custom" && !(p.effect === "REQUIRE_BEFORE" && p.prerequisite && satisfied(p.prerequisite)));
		// A bash command that only writes to known paths is judged on those, not on everything it reads.
		const paths = action.writes ?? action.paths;
		const targets: Array<string | undefined> = paths.length ? paths : [undefined];
		const allowIds = new Set<string>();
		for (const target of targets) {
			const applicable = candidates.filter((p) => applies(p, action, target, cwd));
			if (!applicable.length) continue;
			const winner = applicable.reduce((a, b) => (rank(b) > rank(a) ? b : a));
			if (isRestrictive(winner)) return { policy: winner, target, allowIds: [] };
			allowIds.add(winner.id);
		}
		return { allowIds: [...allowIds] };
	}

	customDenies(): Policy[] {
		return this.active().filter((p) => p.action === "custom" && p.effect === "DENY");
	}

	get(id: string): Policy | undefined {
		return this.policies.find((p) => p.id === id);
	}

	active(): Policy[] {
		return this.policies.filter((p) => p.status === "active");
	}

	history(): Policy[] {
		return this.policies.filter((p) => p.status !== "active");
	}

	all(): readonly Policy[] {
		return this.policies;
	}

	reset(): void {
		this.policies = [];
		this.seq = 0;
	}
}

function rank(p: Policy): number {
	// resource specificity dominates, then action specificity, then recency
	return resourceSpecificity(p.resource) * 1e9 + actionSpecificity(p.action) * 1e8 + p.provenance.seq;
}

function applies(p: Policy, action: ToolAction, target: string | undefined, cwd?: string): boolean {
	switch (p.action) {
		case "install_deps":
			return action.installsDeps;
		case "git_push":
			return action.gitPush;
		case "git_commit":
			return action.gitCommit;
		case "modify":
			if (!action.mutates) return false;
			if (p.resource === "*") return !(target !== undefined && isScratch(target, cwd));
			if (target === undefined) return false;
			if (p.resource === "tests") return TEST_PATH.test(target);
			return pathMatches(target, p.resource);
		default:
			return false;
	}
}

const ACTION_TEXT: Record<PolicyAction, string> = {
	modify: "modify",
	install_deps: "install dependencies",
	git_push: "git push",
	git_commit: "git commit",
	custom: "",
};

export function describe(p: Policy): string {
	if (p.action === "custom") return `${p.effect} "${p.resource}" (${p.scope})`;
	const what = p.action === "modify" ? `modify ${p.resource === "*" ? "anything" : p.resource}` : ACTION_TEXT[p.action];
	const pre = p.prerequisite ? ` unless ${p.prerequisite} ran first` : "";
	return `${p.effect} ${what}${pre} (${p.scope})`;
}

/** Plain-language line for the system prompt: what the model may or may not do, in the user's own words. */
export function plain(p: Policy): string {
	const where = (r: string) => (r === "*" ? "files" : r === "tests" ? "test files" : r);
	const scope = p.scope === "once" ? " (this once)" : p.scope === "run" ? " (for this request)" : "";
	switch (p.effect) {
		case "ALLOW":
			return `Allowed: ${p.action === "modify" ? `modify ${where(p.resource)}` : p.action.replace("_", " ")}${scope}`;
		case "REQUIRE_CONFIRMATION":
			return `Ask the user before you ${p.action === "modify" ? `modify ${where(p.resource)}` : p.action.replace("_", " ")}`;
		case "REQUIRE_BEFORE":
			return `Before ${p.action.replace("_", " ")}: run the ${p.prerequisite} and make no changes after they pass`;
		default:
			if (p.action === "custom") return `Do not: ${p.resource}`;
			if (p.action === "modify") return `Do not modify ${where(p.resource)}${scope}`;
			return `Do not ${p.action === "install_deps" ? "add dependencies" : p.action.replace("_", " ")}${scope}`;
	}
}
