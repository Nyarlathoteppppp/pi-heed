// The intent/task ledger: what the user is asking for right now, kept by the main model next to the policy ledger.
// A policy says what may not happen; it cannot say what the user is trying to get done, which decisions they made
// along the way, or whether they want a discussion before any change. Squeezing that into policy tuples is where the
// conversation lost information (0.8's holds became session-long bans). Here it is state of its own: the main model
// writes it with heed_task, pi-heed checks each entry's receipt (the user's words) and replays it after compaction.
// Policies point at the task they were set in; scope "task" rules end with it.

export type Stage = "discuss" | "execute";
export type TaskStatus = "active" | "done" | "replaced";

export interface TaskDecision {
	text: string;
	quote: string;
	/** Index of the user message the quote is in. */
	at: number;
}

export interface Task {
	id: string;
	/** The model's one-line statement of what the user wants. */
	goal: string;
	/** The user's words that set the task (the receipt). */
	quote: string;
	at: number;
	/** discuss: the user wants analysis or a plan first · execute: the user wants the work done. Not enforced. */
	stage: Stage;
	/** Message index of the receipt for the current stage. */
	stageAt: number;
	decisions: TaskDecision[];
	status: TaskStatus;
	endReason?: string;
}

export type TaskOp =
	/** A new task. Any active task is replaced. */
	| { op: "start"; goal: string; quote: string; at: number; stage: Stage }
	| { op: "note"; id: string; text: string; quote: string; at: number }
	| { op: "stage"; id: string; stage: Stage; quote: string; at: number }
	| { op: "done"; id: string; reason: string };

export class TaskLedger {
	private tasks: Task[] = [];
	private seq = 0;

	apply(op: TaskOp): string[] {
		switch (op.op) {
			case "start": {
				const lines: string[] = [];
				const prev = this.current();
				if (prev) lines.push(this.end(prev, "replaced", `replaced by ${this.nextId()}`));
				const t: Task = { id: `t${++this.seq}`, goal: op.goal, quote: op.quote, at: op.at, stage: op.stage, stageAt: op.at, decisions: [], status: "active" };
				this.tasks.push(t);
				lines.unshift(`+${t.id} task (${t.stage}): ${t.goal}`);
				return lines;
			}
			case "note": {
				const t = this.get(op.id);
				if (t?.status !== "active") return [];
				if (t.decisions.some((d) => d.text === op.text)) return [];
				t.decisions.push({ text: op.text, quote: op.quote, at: op.at });
				return [`${t.id} decided: ${op.text}`];
			}
			case "stage": {
				const t = this.get(op.id);
				if (t?.status !== "active" || t.stage === op.stage) return [];
				const from = t.stage;
				t.stage = op.stage;
				t.stageAt = op.at;
				return [`~${t.id} stage ${from} → ${op.stage}`];
			}
			case "done": {
				const t = this.get(op.id);
				return t?.status === "active" ? [this.end(t, "done", op.reason)] : [];
			}
		}
	}

	private end(t: Task, status: Exclude<TaskStatus, "active">, reason: string): string {
		t.status = status;
		t.endReason = reason;
		return `-${t.id} ${status}: ${reason}`;
	}

	/** The id the next start will get. */
	nextId(): string {
		return `t${this.seq + 1}`;
	}

	current(): Task | undefined {
		return this.tasks.findLast((t) => t.status === "active");
	}

	/** The latest task, active or not (rules recorded after a task is done still belong to it until the next one). */
	latest(): Task | undefined {
		return this.tasks.at(-1);
	}

	get(id: string): Task | undefined {
		return this.tasks.find((t) => t.id === id);
	}

	all(): readonly Task[] {
		return this.tasks;
	}

	reset(): void {
		this.tasks = [];
		this.seq = 0;
	}
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeTask(t: Task): string {
	return `${t.id} [${t.status === "active" ? t.stage : t.status}] ${t.goal}`;
}

/**
 * The task state for the system prompt: the current task with its decisions, then a few earlier ones. Derived from
 * the ledger only, so it changes (and the provider cache resets) only when the ledger does.
 */
export function renderTasks(ledger: TaskLedger, rulesOf: (taskId: string) => string[] = () => []): string {
	const all = ledger.all();
	if (!all.length) return "";
	const cur = ledger.current();
	const lines: string[] = [];
	if (cur) {
		const stage = cur.stage === "discuss" ? "discuss: the user wants analysis or a plan before changes" : "execute";
		lines.push(`Current task ${cur.id} (${stage}): ${cur.goal}. The user said: "${clip(cur.quote, 200)}"`);
		for (const d of cur.decisions.slice(-8)) lines.push(`- Decided: ${d.text} (user: "${clip(d.quote, 120)}")`);
		for (const r of rulesOf(cur.id)) lines.push(`- Rule: ${r}`);
	} else {
		lines.push("No active task.");
	}
	const earlier = all.filter((t) => t !== cur).slice(-3);
	if (earlier.length) lines.push(`Earlier: ${earlier.map((t) => `${t.id} ${t.status}: ${clip(t.goal, 80)}`).join("; ")}`);
	return lines.join("\n");
}
