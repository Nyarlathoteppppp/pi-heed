import { readFileSync } from "node:fs";

/** Instructions and criteria accept JSON structure: {question, focus, …} and {what, not_for, examples}. */
export type Guidance = string | Record<string, unknown> | unknown[] | null;

export interface ChoiceQuestion {
	type: "choice";
	instructions: Guidance;
	criteria: Record<string, Guidance>;
}

export interface NoulQuestion {
	type: "noul";
	instructions: Guidance;
	/** What a yes and a no mean, for subtle boundaries. */
	criteria?: { true: Guidance; false: Guidance };
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export type Answer = ChoiceAnswer | NoulAnswer;

/**
 * A narrow decision oracle. One call may carry many questions (Jev answers them in one pass).
 * Implementations must throw (not guess) on failure; callers fail open.
 */
export interface Judge {
	readonly name: string;
	decide(state: unknown, questions: Record<string, Question>, signal: AbortSignal): Promise<Record<string, Answer>>;
	/** Optional: open the connection ahead of the first decision. Must never throw. */
	warm?(): void;
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

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Validates an answer and clamps minor numeric overshoot into [0, 1]; anything non-finite or off-schema is
 * rejected, which fails the call open. (Normalisation borrowed from thruwire/foreman, MIT.)
 */
function normalizeAnswer(q: Question, a: any): Answer | undefined {
	if (!a || typeof a !== "object") return undefined;
	if (q.type === "noul") return finite(a.noul) ? { type: "noul", noul: clamp01(a.noul) } : undefined;
	if (typeof a.choice !== "string" || !(a.choice in q.criteria) || !finite(a.confidence) || !a.probabilities || typeof a.probabilities !== "object") return undefined;
	const probabilities: Record<string, number> = {};
	for (const [k, v] of Object.entries(a.probabilities)) {
		if (!finite(v)) return undefined;
		probabilities[k] = clamp01(v);
	}
	return { type: "choice", choice: a.choice, probabilities, confidence: clamp01(a.confidence) };
}

/** Transient statuses worth retrying (TypeSafe's SDK retries the same set). */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

function retryDelay(res: Response | undefined, attempt: number): number {
	const header = res?.headers.get("retry-after");
	const seconds = header !== null && header !== undefined && header !== "" ? Number(header) : Number.NaN;
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	return 150 * 2 ** attempt;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
	});
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

	warm(): void {
		// Unauthenticated HEAD to the origin: resolves DNS and completes TLS so keep-alive can reuse it.
		this.fetchFn(new URL(this.transport.url).origin, { method: "HEAD", signal: AbortSignal.timeout(3000) }).then(
			(r) => r.body?.cancel(),
			() => {},
		);
	}

	/**
	 * One decision request. 429 and transient 5xx are retried (up to twice, honouring Retry-After) inside the
	 * caller's deadline: the signal aborts any wait, so retries never make pi wait longer than the judge timeout.
	 */
	async decide(state: unknown, questions: Record<string, Question>, signal: AbortSignal): Promise<Record<string, Answer>> {
		const body = JSON.stringify({ model: this.transport.model, state, questions });
		let res: Response | undefined;
		for (let attempt = 0; ; attempt++) {
			res = await this.fetchFn(this.transport.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.transport.key}`,
					"Content-Type": "application/json",
					"X-Title": "pi-heed",
				},
				body,
				signal,
			});
			if (res.ok || !RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) break;
			await res.body?.cancel().catch(() => {});
			await sleep(retryDelay(res, attempt), signal);
		}
		if (!res.ok) throw new Error(`jev http ${res.status}`);
		const parsed = (await res.json()) as { answers?: Record<string, unknown> };
		const out: Record<string, Answer> = {};
		for (const [key, q] of Object.entries(questions)) {
			const a = normalizeAnswer(q, parsed.answers?.[key]);
			if (!a) throw new Error(`jev: malformed answer for ${key}`);
			out[key] = a;
		}
		return out;
	}
}

/** Runs a judge call with a hard deadline; returns no answers on timeout, abort or error (fail open). */
export async function ask(
	judge: Judge | undefined,
	state: unknown,
	questions: Record<string, Question>,
	timeoutMs: number,
	outer?: AbortSignal,
): Promise<{ answers?: Record<string, Answer>; error?: string; ms: number }> {
	const started = Date.now();
	if (!judge) return { error: "no judge configured", ms: 0 };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	const onOuter = () => controller.abort(new Error("aborted"));
	if (outer?.aborted) onOuter();
	outer?.addEventListener("abort", onOuter, { once: true });
	try {
		const answers = await judge.decide(state, questions, controller.signal);
		return { answers, ms: Date.now() - started };
	} catch (e) {
		const reason = controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? "aborted") : String((e as Error)?.message ?? e);
		return { error: reason, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuter);
	}
}

/** Waits for a promise at most `ms`; resolves undefined on timeout. Never rejects. */
export function settle<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
	if (!p) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(undefined), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			() => (clearTimeout(t), resolve(undefined)),
		);
	});
}
