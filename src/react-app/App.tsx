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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
	}
	return (await res.json()) as T;
}

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
	const abortRef = useRef<AbortController | null>(null);

	const prettyJson = useMemo(() => {
		if (lastJson === null || lastJson === undefined) return "";
		try {
			return JSON.stringify(lastJson, null, 2);
		} catch {
			return String(lastJson);
		}
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

	return (
		<>
			<div>
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
				<div className="card">
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
													setStreamText((prev) => prev + chunk);
												}
											}
											continue;
										}

										if (sdk.message.type === "assistant") {
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
						每个按钮对应你列的 7 个验证点；当前后端为占位路由，后续逐条填充 SDK
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
									const json = await fetchJson<unknown>("/api/agent/subagents", {
										method: "POST",
										signal,
										body: JSON.stringify({ count: 3, parallel: true }),
									});
									setLastJson(json);
								})
						}
						>
							2. 子 agent
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("3) skill", async (signal) => {
									const json = await fetchJson<unknown>("/api/agent/skills", { signal });
									setLastJson(json);
								})
						}
						>
							3. skill
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("4) 成本/用量", async (signal) => {
									const json = await fetchJson<unknown>("/api/agent/usage", { signal });
									setLastJson(json);
								})
						}
						>
							4. 成本/用量
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("5) 斜杠命令", async (signal) => {
									const json = await fetchJson<unknown>("/api/agent/slash-commands", {
										signal,
									});
									setLastJson(json);
								})
						}
						>
							5. 斜杠命令
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("6) 待办", async (signal) => {
									const json = await fetchJson<unknown>("/api/agent/todos", { signal });
									setLastJson(json);
								})
						}
						>
							6. 待办
						</button>

						<button
							disabled={busy !== null}
							onClick={() =>
								run("7) 结构化输出", async (signal) => {
									const json = await fetchJson<unknown>(
										"/api/agent/structured-output",
										{
											method: "POST",
											signal,
											body: JSON.stringify({
												prompt:
													"输出一个 JSON，包含可验证的字段，用于测试结构化输出。",
											}),
										},
									);
									setLastJson(json);
								})
						}
						>
							7. 结构化输出
						</button>
					</div>
				</div>

				<div className="card panel">
					<div className="panelHeader">
						<div className="panelTitle">输出</div>
						<div className="panelMeta">
							{busy ? `运行中：${busy}` : "空闲"}
						</div>
					</div>
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
