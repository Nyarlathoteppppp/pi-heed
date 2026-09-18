import { readFileSync } from "node:fs";

export interface ChoiceAnswer {
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ChoiceQuestion {
	instructions: string;
	criteria: Record<string, string>;
}

/** A narrow decision oracle. Implementations must throw (not guess) on failure; callers fail open. */
export interface Judge {
	readonly name: string;
	choice(state: unknown, question: ChoiceQuestion, signal: AbortSignal): Promise<ChoiceAnswer>;
}

interface Transport {
	url: string;
	model: string;
	key: string;
}

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Reads KEY=value from a dotenv file without exporting anything else. */
function fromEnvFile(path: string | undefined, name: string): string | undefined {
	if (!path) return undefined;
	try {
		const line = readFileSync(path, "utf8")
			.split("\n")
			.find((l) => l.startsWith(`${name}=`));
		return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
	} catch {
		return undefined;
	}
}

export function resolveTransport(env: NodeJS.ProcessEnv = process.env): Transport | undefined {
	const envFile = env.PI_HEED_ENV_FILE;
	const typesafe = env.TYPESAFE_API_KEY ?? fromEnvFile(envFile, "TYPESAFE_API_KEY");
	if (typesafe) return { url: TYPESAFE_URL, model: env.PI_HEED_MODEL ?? "jev-latest", key: typesafe };
	const openrouter = env.OPENROUTER_API_KEY ?? fromEnvFile(envFile, "OPENROUTER_API_KEY");
	if (openrouter) return { url: OPENROUTER_URL, model: env.PI_HEED_MODEL ?? "~typesafe/jev-latest", key: openrouter };
	return undefined;
}

export class JevJudge implements Judge {
	readonly name: string;
	private readonly transport: Transport;
	private readonly fetchFn: typeof fetch;

	constructor(transport: Transport, fetchFn: typeof fetch = fetch) {
		this.transport = transport;
		this.fetchFn = fetchFn;
		this.name = `jev(${transport.url.includes("openrouter") ? "openrouter" : "typesafe"})`;
	}

	async choice(state: unknown, question: ChoiceQuestion, signal: AbortSignal): Promise<ChoiceAnswer> {
		const res = await this.fetchFn(this.transport.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.transport.key}`,
				"Content-Type": "application/json",
				"X-Title": "pi-heed",
			},
			body: JSON.stringify({
				model: this.transport.model,
				state,
				questions: { q: { type: "choice", instructions: question.instructions, criteria: question.criteria } },
			}),
			signal,
		});
		if (!res.ok) throw new Error(`jev http ${res.status}`);
		const body = (await res.json()) as { answers?: { q?: Partial<ChoiceAnswer> } };
		const a = body.answers?.q;
		if (!a || typeof a.choice !== "string" || !(a.choice in question.criteria) || typeof a.confidence !== "number" || !a.probabilities) {
			throw new Error("jev: malformed answer");
		}
		return { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
	}
}

/** Runs a judge call with a hard deadline; returns undefined on timeout, abort or error (fail open). */
export async function ask(
	judge: Judge | undefined,
	state: unknown,
	question: ChoiceQuestion,
	timeoutMs: number,
	outer?: AbortSignal,
): Promise<{ answer?: ChoiceAnswer; error?: string; ms: number }> {
	const started = Date.now();
	if (!judge) return { error: "no judge configured", ms: 0 };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	const onOuter = () => controller.abort(new Error("aborted"));
	outer?.addEventListener("abort", onOuter, { once: true });
	try {
		const answer = await judge.choice(state, question, controller.signal);
		return { answer, ms: Date.now() - started };
	} catch (e) {
		const reason = controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? "aborted") : String((e as Error)?.message ?? e);
		return { error: reason, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuter);
	}
}
