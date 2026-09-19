import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHeed, type HeedOptions } from "../src/index.ts";
import type { Policy, PolicyEngine } from "../src/policy.ts";

/** v0.2-style names for active restrictive policies, so older assertions stay readable. */
export function kindOf(p: Policy): string {
	if (p.action === "custom") return "custom";
	if (p.action === "install_deps") return p.effect === "DENY" ? "no_deps" : `${p.effect}:deps`;
	if (p.action === "git_push") return p.effect === "DENY" ? "no_push" : `${p.effect}:push`;
	if (p.action === "git_commit") return `${p.effect}:commit`;
	if (p.effect !== "DENY") return `${p.effect}:${p.resource}`;
	return p.resource === "*" ? "read_only" : p.resource === "tests" ? "no_tests" : "protect_path";
}

export function kinds(engine: PolicyEngine): string[] {
	return engine.active().map(kindOf);
}

type Handler = (event: any, ctx: any) => any;

/** Minimal stand-in for pi's ExtensionAPI: sequential awaited handlers, like agent-core. */
export class FakePi {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; description?: string; getArgumentCompletions?: (p: string) => unknown }>();
	entries: Array<Record<string, any>> = [];
	turnTriggers: string[] = [];
	status: string | undefined;
	notes: string[] = [];
	controller = new AbortController();
	cwd = "/work/project";
	/** extension tools pi reports as available and active */
	tools: Array<{ name: string; description: string }> = [];
	private seq = 0;

	api(): ExtensionAPI {
		const self = this;
		return {
			on(name: string, h: Handler) {
				self.handlers.set(name, [...(self.handlers.get(name) ?? []), h]);
			},
			registerCommand(name: string, opts: any) {
				self.commands.set(name, opts);
			},
			appendEntry(customType: string, data?: unknown) {
				self.entries.push({ type: "custom", id: `e${++self.seq}`, customType, data });
			},
			sendMessage(msg: unknown) {
				self.turnTriggers.push(`sendMessage:${JSON.stringify(msg)}`);
			},
			sendUserMessage(msg: unknown) {
				self.turnTriggers.push(`sendUserMessage:${JSON.stringify(msg)}`);
			},
			getAllTools() {
				return self.tools;
			},
			getActiveTools() {
				return self.tools.map((t) => t.name);
			},
		} as unknown as ExtensionAPI;
	}

	ctx() {
		return {
			cwd: this.cwd,
			hasUI: true,
			signal: this.controller.signal,
			ui: {
				setStatus: (_k: string, v: string | undefined) => (this.status = v),
				notify: (m: string) => this.notes.push(m),
			},
			sessionManager: { getBranch: () => this.entries },
		};
	}

	async emit(name: string, event: Record<string, unknown> = {}) {
		let result: unknown;
		for (const h of this.handlers.get(name) ?? []) {
			const r = await h({ type: name, ...event }, this.ctx());
			if (r !== undefined) result = r;
		}
		return result as any;
	}

	/** Simulates a typed user message: input event + the message entry pi would persist. */
	async user(text: string) {
		this.entries.push({ type: "message", id: `e${++this.seq}`, message: { role: "user", content: text } });
		await this.emit("input", { text, source: "interactive" });
		await this.emit("agent_start");
	}

	async command(line: string) {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await this.commands.get(name)!.handler(rest.join(" "), this.ctx());
	}

	/** Lets background work (shadow-mode decisions, understanding) finish. */
	async flush() {
		await new Promise((r) => setTimeout(r, 0));
	}

	logs(kind?: string) {
		return this.entries.filter((e) => e.customType === "heed" && (!kind || e.data.kind === kind)).map((e) => e.data);
	}
}

let callSeq = 0;
export function toolCall(toolName: string, input: Record<string, unknown>) {
	return { toolCallId: `call${++callSeq}`, toolName, input };
}

export function setup(options: HeedOptions = {}) {
	const pi = new FakePi();
	const heed = createHeed(pi.api(), { judge: null, env: {}, ...options });
	return { pi, heed };
}
