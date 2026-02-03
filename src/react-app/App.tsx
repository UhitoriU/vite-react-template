import { useMemo, useRef, useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import cloudflareLogo from "./assets/Cloudflare_Logo.svg";
import honoLogo from "./assets/hono.svg";
import "./App.css";

type LogEntry = {
	ts: number;
	level: "info" | "error";
	message: string;
	data?: unknown;
};

type SandboxHoldResponse = {
	ok: boolean;
	id: string;
	command: string;
	holdSeconds: number;
	elapsedMs: number;
	processId?: string;
	instanceType?: string;
	error?: {
		name?: string;
		message?: string;
		code?: string;
		httpStatus?: number;
		operation?: string;
		context?: unknown;
	};
};

async function* readNdjson(response: Response): AsyncGenerator<unknown, void, void> {
	if (!response.body) {
		throw new Error("Response body is null (streaming not supported?)");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line) {
				yield JSON.parse(line) as unknown;
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	const tail = buffer.trim();
	if (tail) {
		yield JSON.parse(tail) as unknown;
	}
}

function App() {
	const [busy, setBusy] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [lastJson, setLastJson] = useState<unknown>(null);
	const [prompt, setPrompt] = useState("Help me build a web application");
	const [streamText, setStreamText] = useState("");
	const streamHasDeltaRef = useRef(false);
	const [subagentCount, setSubagentCount] = useState(3);
	const [subagentParallel, setSubagentParallel] = useState(true);
	const [loadInstanceType, setLoadInstanceType] = useState("basic");
	const [loadTotal, setLoadTotal] = useState(200);
	const [loadConcurrency, setLoadConcurrency] = useState(50);
	const [loadHoldSeconds, setLoadHoldSeconds] = useState(60);
	const abortRef = useRef<AbortController | null>(null);

	const prettyJson = useMemo(() => {
		if (lastJson === null || lastJson === undefined) return "";
		try {
			return JSON.stringify(lastJson, null, 2);
		} catch {
			return String(lastJson);
		}
	}, [lastJson]);

	const usageSummary = useMemo(() => {
		if (!lastJson || typeof lastJson !== "object") return null;
		const action = (lastJson as { action?: string }).action;
		if (action !== "usage") return null;
		const data = (lastJson as { data?: any }).data ?? {};
		const steps = Array.isArray(data.steps) ? data.steps : [];
		const total = data.totalUsage ?? null;
		const totalCost =
			total && typeof total.total_cost_usd === "number"
				? total.total_cost_usd.toFixed(6)
				: null;
		const inputTokens = total?.input_tokens ?? null;
		const outputTokens = total?.output_tokens ?? null;
		return {
			stepsCount: steps.length,
			totalCost,
			inputTokens,
			outputTokens,
		};
	}, [lastJson]);

	const appendLog = (entry: Omit<LogEntry, "ts">) => {
		setLogs((prev) => [...prev, { ts: Date.now(), ...entry }]);
	};

	const clear = () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setLogs([]);
		setLastJson(null);
		setStreamText("");
		streamHasDeltaRef.current = false;
		setBusy(null);
	};

	const run = async (label: string, fn: (signal: AbortSignal) => Promise<void>) => {
		abortRef.current?.abort();
		const abortController = new AbortController();
		abortRef.current = abortController;
		setBusy(label);
		appendLog({ level: "info", message: `开始：${label}` });

		try {
			await fn(abortController.signal);
			appendLog({ level: "info", message: `完成：${label}` });
		} catch (err) {
			appendLog({
				level: "error",
				message: `失败：${label}`,
				data: err instanceof Error ? { name: err.name, message: err.message } : err,
			});
		} finally {
			setBusy((cur) => (cur === label ? null : cur));
		}
	};

	const consumeNdjson = async (res: Response) => {
		if (!res.body) {
			throw new Error("Response body is null (streaming not supported?)");
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line) {
					const msg = JSON.parse(line) as unknown;
					appendLog({ level: "info", message: "stream", data: msg });
					const payload = msg as { type?: string; data?: unknown };
					if (payload?.type === "result" && payload.data !== undefined) {
						setLastJson(payload.data);
						await reader.cancel();
						return;
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}

		const tail = buffer.trim();
		if (tail) {
			const msg = JSON.parse(tail) as unknown;
			appendLog({ level: "info", message: "stream", data: msg });
			const payload = msg as { type?: string; data?: unknown };
			if (payload?.type === "result" && payload.data !== undefined) {
				setLastJson(payload.data);
			}
		}
	};

	const postSandboxHold = async (
		payload: {
			id: string;
			holdSeconds: number;
			instanceType: string;
		},
		signal: AbortSignal,
	): Promise<SandboxHoldResponse> => {
		const res = await fetch("/api/sandbox/hold", {
			method: "POST",
			signal,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const text = await res.text();
		let json: SandboxHoldResponse | null = null;
		try {
			json = text ? (JSON.parse(text) as SandboxHoldResponse) : null;
		} catch {
			json = null;
		}
		if (!res.ok || !json || !json.ok) {
			const reason = json?.error?.message ?? `HTTP ${res.status} ${res.statusText}`;
			const err = new Error(reason);
			(err as any).response = json;
			throw err;
		}
		return json;
	};

	const percentile = (values: number[], p: number) => {
		if (!values.length) return null;
		const sorted = [...values].sort((a, b) => a - b);
		const idx = Math.min(
			sorted.length - 1,
			Math.max(0, Math.floor((p / 100) * sorted.length)),
		);
		return sorted[idx];
	};

	const runSandboxLoadTest = async (signal: AbortSignal) => {
		setLastJson(null);
		setStreamText("");
		const total = Math.max(1, Math.floor(loadTotal));
		const concurrency = Math.max(1, Math.floor(loadConcurrency));
		const holdSeconds = Math.max(1, Math.floor(loadHoldSeconds));
		const prefix = `sb-${Date.now().toString(36)}-`;

		let nextIndex = 0;
		let success = 0;
		let failed = 0;
		const durations: number[] = [];
		const failReasons = new Map<string, number>();
		const failSamples = new Map<string, number>();

		const recordFailure = (reason: string) => {
			failed += 1;
			failReasons.set(reason, (failReasons.get(reason) ?? 0) + 1);
		};

		const worker = async () => {
			while (true) {
				const current = nextIndex;
				nextIndex += 1;
				if (current >= total) return;
				const id = `${prefix}${current}`;
				const started = Date.now();
				try {
					await postSandboxHold(
						{ id, holdSeconds, instanceType: loadInstanceType },
						signal,
					);
					durations.push(Date.now() - started);
					success += 1;
				} catch (err) {
					durations.push(Date.now() - started);
					const reason =
						err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
					recordFailure(reason);
					const sampleCount = (failSamples.get(reason) ?? 0) + 1;
					failSamples.set(reason, sampleCount);
					if (sampleCount <= 3) {
						appendLog({
							level: "error",
							message: "sandbox failed",
							data: { id, reason },
						});
					}
				}

				const finished = success + failed;
				if (finished % 25 === 0 || finished === total) {
					appendLog({
						level: "info",
						message: "progress",
						data: {
							total,
							finished,
							success,
							failed,
						},
					});
				}
			}
		};

		const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
		await Promise.all(workers);

		const p50 = percentile(durations, 50);
		const p95 = percentile(durations, 95);
		const summary = {
			total,
			concurrency,
			instanceType: loadInstanceType,
			holdSeconds,
			success,
			failed,
			p50Ms: p50,
			p95Ms: p95,
			failReasons: Object.fromEntries(failReasons.entries()),
		};
		setLastJson(summary);
	};

	return (
		<>
			<div className="min-w-0">
				<a href="https://vite.dev" target="_blank">
					<img src={viteLogo} className="logo" alt="Vite logo" />
				</a>
				<a href="https://react.dev" target="_blank">
					<img src={reactLogo} className="logo react" alt="React logo" />
				</a>
				<a href="https://hono.dev/" target="_blank">
					<img src={honoLogo} className="logo cloudflare" alt="Hono logo" />
				</a>
				<a href="https://workers.cloudflare.com/" target="_blank">
					<img
						src={cloudflareLogo}
						className="logo cloudflare"
						alt="Cloudflare logo"
					/>
				</a>
			</div>
			<h1>Claude Agent SDK @ Cloudflare 边缘沙箱验证</h1>

			<div className="grid">
				<div className="card leftPanel">
					<div className="row">
						<input
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder="输入你的问题..."
							className="input"
							disabled={busy !== null}
						/>
						<button
							disabled={busy !== null || prompt.trim().length === 0}
							onClick={() =>
								run("前端流式", async (signal) => {
									setLastJson(null);
									setStreamText("");
									streamHasDeltaRef.current = false;
									const res = await fetch("/api/agent/stream", {
										method: "POST",
										signal,
										headers: { "content-type": "application/json" },
										body: JSON.stringify({
											prompt: prompt.trim(),
											options: { maxTurns: 5 },
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									for await (const msg of readNdjson(res)) {
										appendLog({ level: "info", message: "stream", data: msg });
										const sdk = (msg as { type?: string; message?: any }) ?? {};
										if (sdk.type !== "sdk" || !sdk.message) continue;

										if (sdk.message.type === "stream_event") {
											const event = sdk.message.event;
											if (
												event?.type === "content_block_delta" &&
												event?.delta?.type === "text_delta"
											) {
												const chunk = event.delta.text ?? "";
												if (chunk) {
													streamHasDeltaRef.current = true;
													setStreamText((prev) => prev + chunk);
												}
											}
											continue;
										}

										if (sdk.message.type === "assistant") {
											if (streamHasDeltaRef.current) continue;
											const parts = sdk.message.message?.content ?? [];
											const chunk = parts
												.map((p: { type?: string; text?: string }) =>
													p?.type === "text" ? p.text ?? "" : "",
												)
												.join("");
											if (chunk) {
												setStreamText((prev) => prev + chunk);
											}
										}
									}
								})
						}
						>
							发送
						</button>
						<button
							disabled={busy !== null || prompt.trim().length === 0}
							onClick={() =>
								run("Worker API 流式", async (signal) => {
									setLastJson(null);
									setStreamText("");
									streamHasDeltaRef.current = false;
									const res = await fetch("/api/agent/worker-api", {
										method: "POST",
										signal,
										headers: { "content-type": "application/json" },
										body: JSON.stringify({
											prompt: prompt.trim(),
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									for await (const msg of readNdjson(res)) {
										appendLog({ level: "info", message: "stream", data: msg });
										const sdk = (msg as { type?: string; message?: any }) ?? {};
										if (sdk.type !== "sdk" || !sdk.message) continue;

										if (sdk.message.type === "stream_event") {
											const event = sdk.message.event;
											if (
												event?.type === "content_block_delta" &&
												event?.delta?.type === "text_delta"
											) {
												const chunk = event.delta.text ?? "";
												if (chunk) {
													streamHasDeltaRef.current = true;
													setStreamText((prev) => prev + chunk);
												}
											}
											continue;
										}

										if (sdk.message.type === "assistant") {
											if (streamHasDeltaRef.current) continue;
											const parts = sdk.message.message?.content ?? [];
											const chunk = parts
												.map((p: { type?: string; text?: string }) =>
													p?.type === "text" ? p.text ?? "" : "",
												)
												.join("");
											if (chunk) {
												setStreamText((prev) => prev + chunk);
											}
										}
									}
								})
						}
						>
							Worker API
						</button>
					</div>
					<p className="hint">输入问题后点击发送，右侧会实时追加流式输出</p>
					<div className="row">
						<button onClick={clear} disabled={busy !== null}>
							清空
						</button>
						<button
							onClick={() => abortRef.current?.abort()}
							disabled={abortRef.current === null}
						>
							中止
						</button>
					</div>
					<p className="hint">
						每个按钮对应你列的 7 个验证点；部分后端仍为占位路由，后续逐条填充 SDK
					</p>

					<div className="row wrap buttonCol">
						<label className="chip">
							子 agent 数
							<input
								type="number"
								min={1}
								max={5}
								value={subagentCount}
								disabled={busy !== null}
								onChange={(event) => {
									const next = Number(event.target.value);
									if (Number.isNaN(next)) return;
									setSubagentCount(Math.min(Math.max(next, 1), 5));
								}}
							/>
						</label>
						<label className="chip">
							<input
								type="checkbox"
								checked={subagentParallel}
								disabled={busy !== null}
								onChange={(event) => setSubagentParallel(event.target.checked)}
							/>
							并行
						</label>
					</div>

					<div className="row wrap">
						<label className="chip">
							实例类型
							<select
								value={loadInstanceType}
								disabled={busy !== null}
								onChange={(event) => setLoadInstanceType(event.target.value)}
							>
								<option value="lite">lite</option>
								<option value="basic">basic</option>
								<option value="standard-1">standard-1</option>
								<option value="standard-2">standard-2</option>
								<option value="standard-3">standard-3</option>
								<option value="standard-4">standard-4</option>
							</select>
						</label>
						<label className="chip">
							总请求
							<input
								type="number"
								min={1}
								value={loadTotal}
								disabled={busy !== null}
								onChange={(event) => {
									const next = Number(event.target.value);
									if (Number.isNaN(next)) return;
									setLoadTotal(Math.max(next, 1));
								}}
							/>
						</label>
						<label className="chip">
							并发
							<input
								type="number"
								min={1}
								value={loadConcurrency}
								disabled={busy !== null}
								onChange={(event) => {
									const next = Number(event.target.value);
									if (Number.isNaN(next)) return;
									setLoadConcurrency(Math.max(next, 1));
								}}
							/>
						</label>
						<label className="chip">
							占用秒数
							<input
								type="number"
								min={1}
								value={loadHoldSeconds}
								disabled={busy !== null}
								onChange={(event) => {
									const next = Number(event.target.value);
									if (Number.isNaN(next)) return;
									setLoadHoldSeconds(Math.max(next, 1));
								}}
							/>
						</label>
						<button
							disabled={busy !== null}
							onClick={() => run("Sandbox 并发压测", runSandboxLoadTest)}
						>
							Sandbox 并发压测
						</button>
					</div>
					<p className="hint">
						每个请求创建 1 个 sandbox 并启动 sleep，占用资源。实例类型由
						<code>wrangler.json</code> 决定，这里的选择仅用于记录。
					</p>

					<div className="row wrap">
						<button
							disabled={busy !== null}
							onClick={() =>
								run("1) 流式返回 (NDJSON)", async (signal) => {
									setLastJson(null);
									const res = await fetch("/api/agent/stream", { signal });
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									for await (const msg of readNdjson(res)) {
										appendLog({ level: "info", message: "stream", data: msg });
									}
								})
						}
						>
							1. 流式返回
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("2) 子 agent 限制", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/subagents", {
										method: "POST",
										signal,
										body: JSON.stringify({
											count: subagentCount,
											parallel: subagentParallel,
											prompt: prompt.trim(),
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							2. 子 agent 并发
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("3) skill", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/skills", {
										method: "POST",
										signal,
										body: JSON.stringify({
											prompt: "What Skills are available?",
											testPrompt: prompt.trim() || undefined,
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							3. skill
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("4) 成本/用量", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/usage", {
										method: "POST",
										signal,
										body: JSON.stringify({
											prompt: prompt.trim() || undefined,
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							4. 成本/用量
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("5) 斜杠命令", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/slash-commands", {
										method: "POST",
										signal,
										body: JSON.stringify({ testCommand: "/cost" }),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							5. 斜杠命令
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("6) 待办", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/todos", {
										method: "POST",
										signal,
										body: JSON.stringify({
											prompt: prompt.trim() || undefined,
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							6. 待办
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("7) 结构化输出", async (signal) => {
									setLastJson(null);
									setStreamText("");
									const res = await fetch("/api/agent/structured-output", {
										method: "POST",
										signal,
										body: JSON.stringify({
											prompt:
												"输出一个 JSON，包含可验证的字段，用于测试结构化输出。",
										}),
									});
									if (!res.ok) {
										throw new Error(`HTTP ${res.status} ${res.statusText}`);
									}
									await consumeNdjson(res);
								})
						}
						>
							7. 结构化输出
						</button>
					</div>
				</div>

				<div className="card panel rightPanel min-w-0">
					<div className="panelHeader">
						<div className="panelTitle">输出</div>
						<div className="panelMeta">
							{busy ? `运行中：${busy}` : "空闲"}
						</div>
					</div>
					{usageSummary ? (
						<div className="usageBox">
							<div>步骤数: {usageSummary.stepsCount}</div>
							<div>输入 tokens: {usageSummary.inputTokens ?? "-"}</div>
							<div>输出 tokens: {usageSummary.outputTokens ?? "-"}</div>
							<div>总成本(USD): {usageSummary.totalCost ?? "-"}</div>
						</div>
					) : null}
					<pre className="json">
						{streamText || prettyJson || "(点击按钮开始测试)"}
					</pre>

					<div className="panelHeader">
						<div className="panelTitle">日志</div>
						<div className="panelMeta">{logs.length} 条</div>
					</div>
					<pre className="log">
						{logs
							.map((l) => {
								const ts = new Date(l.ts).toLocaleTimeString();
								const data = l.data === undefined ? "" : ` ${JSON.stringify(l.data)}`;
								return `[${ts}] ${l.level.toUpperCase()} ${l.message}${data}`;
							})
							.join("\n")}
					</pre>
				</div>
			</div>

			<p className="read-the-docs">
				后端路由在 <code>src/worker/index.ts</code>；前端在 <code>src/react-app/App.tsx</code>
			</p>
		</>
	);
}

export default App;
