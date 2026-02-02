import {
	getSandbox,
	parseSSEStream,
	proxyToSandbox,
	type Sandbox,
} from "@cloudflare/sandbox";
import { Hono } from "hono";

export { Sandbox } from "@cloudflare/sandbox";

type Bindings = Env & {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ANTHROPIC_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

// Sandbox SDK: required for preview URLs (when exposing ports from the sandbox)
app.all("/sandbox/*", async (c) => {
	const proxyResponse = await proxyToSandbox(c.req.raw, c.env);
	if (proxyResponse) return proxyResponse;
	return c.text("No sandbox proxy match", 404);
});

// Minimal Sandbox endpoint: proves the container is live and can exec commands.
app.get("/api/sandbox/run", async (c) => {
	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const result = await sandbox.exec('python3 -c "print(2 + 2)"');
	return c.json({
		ok: result.success,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	});
});

// Optional: verify claude-code is installed in the sandbox image (no auth needed for --version).
app.get("/api/sandbox/claude-code-version", async (c) => {
	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const result = await sandbox.exec("claude --version");
	return c.json({
		ok: result.success,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	});
});

type AgentActionResult = {
	ok: boolean;
	action:
		| "stream"
		| "subagents"
		| "skills"
		| "usage"
		| "slash-commands"
		| "todos"
		| "structured-output";
	data?: unknown;
	note?: string;
};

app.get("/api/agent/health", (c) =>
	c.json({ ok: true, runtime: "cloudflare-workers", time: new Date().toISOString() }),
);

// 1)（保留）简单的流式返回：用 NDJSON 模拟 SDK 的 streaming message
app.get("/api/agent/stream-mock", (_c) => {
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
			};
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

			send({ type: "meta", subtype: "start", ts: Date.now() });
			await sleep(150);
			send({ type: "assistant", message: { content: [{ text: "开始流式输出…" }] } });
			await sleep(150);
			send({ type: "assistant", message: { content: [{ name: "Read" }] } });
			await sleep(150);
			send({
				type: "assistant",
				message: {
					content: [
						{ text: "这里会逐步输出 Agent 的思考/工具调用/结果（占位）。" },
					],
				},
			});
			await sleep(150);
			send({
				type: "result",
				subtype: "completed",
				usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
				ts: Date.now(),
			});
			controller.close();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 1) 真实的流式返回：在 Cloudflare Sandbox 容器内运行 Claude Agent SDK（query），并把 stdout 的 NDJSON 转发给前端
app.get("/api/agent/stream", async (c) => {
	const prompt = new URL(c.req.url).searchParams.get("q")?.trim() || "你好！请用一句话介绍你自己。";

	if (!c.env.ANTHROPIC_API_KEY) {
		return c.json(
			{
				ok: false,
				action: "stream",
				note:
					"缺少 ANTHROPIC_API_KEY。请在项目根目录运行：wrangler secret put ANTHROPIC_API_KEY",
			},
			500,
		);
	}

	const encoder = new TextEncoder();
	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");

	// 为本次执行创建隔离 session，把 key/prompt 注入（避免写入镜像或仓库）
	const sessionId = `agent-${crypto.randomUUID()}`;
	const session = await sandbox.createSession({
		id: sessionId,
		env: {
			ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
			AGENT_PROMPT: prompt,
		},
		cwd: "/workspace",
	});

	const runnerPath = "/workspace/agent-runner.mjs";
	await session.writeFile(
		runnerPath,
		// 这个 runner 在容器里执行，并把 SDK 的 streaming messages 逐行 NDJSON 输出到 stdout
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.env.AGENT_PROMPT || "hello";

function safeStringify(value) {
	return JSON.stringify(
		value,
		(_k, v) => (typeof v === "bigint" ? v.toString() : v),
	);
}

function write(obj) {
	process.stdout.write(safeStringify(obj) + "\n");
}

try {
	write({ type: "meta", subtype: "start", ts: Date.now(), prompt });

	for await (const message of query({
		prompt,
		options: {
			allowedTools: ["Read", "Edit", "Glob"],
			permissionMode: "acceptEdits",
		},
	})) {
		write({ type: "sdk", message });
	}

	write({ type: "meta", subtype: "end", ts: Date.now() });
} catch (err) {
	write({
		type: "error",
		ts: Date.now(),
		error: err && typeof err === "object" ? { name: err.name, message: err.message, stack: err.stack } : String(err),
	});
	process.exitCode = 1;
}`,
	);

	// 用 execStream 获取容器内命令输出（SSE），并把 stdout 里的 NDJSON 解析后转发给前端
	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });

	let stdoutBuffer = "";
	let stderrBuffer = "";

	type SandboxExecEvent =
		| { type: "start" }
		| { type: "stdout"; data: string }
		| { type: "stderr"; data: string }
		| { type: "complete"; exitCode: number }
		| { type: "error"; error: unknown };

	const ndjsonStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
			};

			try {
				for await (const rawEvent of parseSSEStream(sseStream)) {
					const event = rawEvent as SandboxExecEvent;
					if (event.type === "stdout") {
						stdoutBuffer += event.data;
						let idx = stdoutBuffer.indexOf("\n");
						while (idx !== -1) {
							const line = stdoutBuffer.slice(0, idx).trim();
							stdoutBuffer = stdoutBuffer.slice(idx + 1);
							if (line) {
								try {
									send(JSON.parse(line) as unknown);
								} catch {
									send({ type: "stdout", data: line });
								}
							}
							idx = stdoutBuffer.indexOf("\n");
						}
					} else if (event.type === "stderr") {
						stderrBuffer += event.data;
						send({ type: "stderr", data: event.data });
					} else if (event.type === "start") {
						send({ type: "sandbox", subtype: "start", ts: Date.now(), command: cmd });
					} else if (event.type === "complete") {
						const tail = stdoutBuffer.trim();
						if (tail) {
							try {
								send(JSON.parse(tail) as unknown);
							} catch {
								send({ type: "stdout", data: tail });
							}
						}
						send({
							type: "sandbox",
							subtype: "complete",
							ts: Date.now(),
							exitCode: event.exitCode,
							success: event.exitCode === 0,
							stderr: stderrBuffer ? stderrBuffer : undefined,
						});
					} else if (event.type === "error") {
						send({ type: "sandbox", subtype: "error", ts: Date.now(), error: event.error });
					}
				}
			} catch (err) {
				send({
					type: "worker",
					subtype: "error",
					ts: Date.now(),
					error:
						err instanceof Error ? { name: err.name, message: err.message } : String(err),
				});
			} finally {
				controller.close();
				// 清理 session（避免泄露环境变量/残留进程）
				await sandbox.deleteSession(sessionId).catch(() => undefined);
			}
		},
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 2) 子 agent：先只返回“边缘沙箱中你可能关心的限制点”占位
app.post("/api/agent/subagents", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		count?: number;
		parallel?: boolean;
	};

	const result: AgentActionResult = {
		ok: true,
		action: "subagents",
		note:
			"占位实现：后续这里接入 Claude Agent SDK，并验证一次请求内并行/串行子 agent 的可行性与限制。",
		data: {
			requested: body,
			cloudflareNotes: {
				runtime: "Workers (nodejs_compat enabled)",
				constraintsToVerify: [
					"无本地持久文件系统（仅临时内存）",
					"不可启动任意子进程/二进制（例如 claude CLI）",
					"网络出站/超时限制（需实测）",
					"并发与流式在 fetch/Streams 上支持情况",
				],
			},
		},
	};

	return c.json(result);
});

// 3) skill（占位）：后续可把 skill 映射为“工具/能力开关/预设 prompt”
app.get("/api/agent/skills", (c) => {
	const result: AgentActionResult = {
		ok: true,
		action: "skills",
		data: {
			skills: [
				{ id: "read_repo", title: "读取仓库文件", enabled: true },
				{ id: "edit_repo", title: "修改仓库文件", enabled: false },
				{ id: "web_fetch", title: "联网抓取", enabled: false },
			],
		},
	};
	return c.json(result);
});

// 4) 跟踪成本/用量（占位）：后续从 SDK 的 usage 字段或你自己的计量层取数
app.get("/api/agent/usage", (c) => {
	const result: AgentActionResult = {
		ok: true,
		action: "usage",
		data: {
			window: "session",
			items: [
				{ model: "(placeholder)", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
			],
		},
	};
	return c.json(result);
});

// 5) SDK 的斜杠命令（占位）：后续你可以在边缘实现一个简化的“命令路由”
app.get("/api/agent/slash-commands", (c) => {
	const result: AgentActionResult = {
		ok: true,
		action: "slash-commands",
		data: {
			commands: [
				{ command: "/help", description: "列出可用命令" },
				{ command: "/usage", description: "查看本次会话用量" },
				{ command: "/todos", description: "查看待办" },
			],
		},
	};
	return c.json(result);
});

// 6) 待办事项列表（占位）：后续可以接 KV/D1/DO 持久化
app.get("/api/agent/todos", (c) => {
	const result: AgentActionResult = {
		ok: true,
		action: "todos",
		data: {
			todos: [
				{ id: 1, title: "验证流式返回", status: "todo" },
				{ id: 2, title: "验证子 agent 并发", status: "todo" },
				{ id: 3, title: "验证结构化输出", status: "todo" },
			],
		},
	};
	return c.json(result);
});

// 7) 结构化输出（占位）：后续用 SDK 的 schema/structured output 能力
app.post("/api/agent/structured-output", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
	};

	const result: AgentActionResult = {
		ok: true,
		action: "structured-output",
		note:
			"占位实现：后续这里返回 Claude 的结构化输出（例如 JSON schema 约束），并验证边缘运行时兼容性。",
		data: {
			input: body,
			output: {
				answer: "(placeholder)",
				confidence: 0,
				items: [],
			},
			schemaHint: {
				type: "object",
				required: ["answer", "confidence", "items"],
			},
		},
	};

	return c.json(result);
});

export default app;
