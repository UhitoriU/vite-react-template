import {
	getSandbox,
	parseSSEStream,
	proxyToSandbox,
	type Sandbox,
} from "@cloudflare/sandbox";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";

export { Sandbox } from "@cloudflare/sandbox";

type Bindings = Env & {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_BASE_URL?: string;
	ANTHROPIC_AUTH_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

function buildSessionEnv(env: Bindings) {
	return {
		...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
		...(env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN } : {}),
		...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
	};
}

function createNdjsonProxyStream(
	sseStream: ReadableStream<Uint8Array>,
	command: string,
	onClose?: () => Promise<void> | void,
) {
	const encoder = new TextEncoder();
	let stdoutBuffer = "";
	let stderrBuffer = "";

	type SandboxExecEvent =
		| { type: "start" }
		| { type: "stdout"; data: string }
		| { type: "stderr"; data: string }
		| { type: "complete"; exitCode: number }
		| { type: "error"; error: unknown };

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
			};

			let shouldStop = false;

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
									const parsed = JSON.parse(line) as { type?: string };
									send(parsed);
									if (parsed && parsed.type === "result") {
										shouldStop = true;
										controller.close();
										break;
									}
								} catch {
									send({ type: "stdout", data: line });
								}
							}
							idx = stdoutBuffer.indexOf("\n");
						}
						if (shouldStop) break;
					} else if (event.type === "stderr") {
						stderrBuffer += event.data;
						send({ type: "stderr", data: event.data });
					} else if (event.type === "start") {
						send({ type: "sandbox", subtype: "start", ts: Date.now(), command });
					} else if (event.type === "complete") {
						if (shouldStop) break;
						const tail = stdoutBuffer.trim();
						if (tail) {
							try {
								const parsed = JSON.parse(tail) as { type?: string };
								send(parsed);
								if (parsed && parsed.type === "result") {
									shouldStop = true;
									controller.close();
									break;
								}
							} catch {
								send({ type: "stdout", data: tail });
							}
						}
						if (shouldStop) break;
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
					error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
				});
			} finally {
				controller.close();
				if (onClose) {
					await onClose();
				}
			}
		},
	});
}

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

type SandboxHoldRequest = {
	id?: string;
	holdSeconds?: number;
	instanceType?: string;
};

type SandboxHoldResponse = {
	ok: boolean;
	id: string;
	command: string;
	holdSeconds: number;
	elapsedMs: number;
	destroyed?: boolean;
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

const parseSandboxHoldRequest = async (c: { req: { json: () => Promise<unknown> } }) => {
	try {
		return (await c.req.json()) as SandboxHoldRequest;
	} catch {
		return {} as SandboxHoldRequest;
	}
};

const clampHoldSeconds = (value: number | undefined, fallback = 60) => {
	if (!Number.isFinite(value)) return fallback;
	const seconds = Math.floor(value ?? fallback);
	if (seconds < 1) return 1;
	if (seconds > 3600) return 3600;
	return seconds;
};

app.post("/api/sandbox/hold", async (c) => {
	const body = await parseSandboxHoldRequest(c);
	const id =
		typeof body.id === "string" && body.id.trim().length > 0
			? body.id.trim()
			: `sb-${crypto.randomUUID()}`;
	const holdSeconds = clampHoldSeconds(body.holdSeconds, 60);
	const command = `sleep ${holdSeconds}`;
	const instanceType = typeof body.instanceType === "string" ? body.instanceType : undefined;
	const startedAt = Date.now();
	let destroyed = false;

	try {
		const sandbox = getSandbox(c.env.Sandbox, id, { normalizeId: true });
		await sandbox.exec(command, {
			timeout: (holdSeconds + 10) * 1000,
		});
		await sandbox.destroy();
		destroyed = true;
		const response: SandboxHoldResponse = {
			ok: true,
			id,
			command,
			holdSeconds,
			elapsedMs: Date.now() - startedAt,
			destroyed,
			instanceType,
		};
		return c.json(response);
	} catch (err) {
		const errorObj: SandboxHoldResponse["error"] = {
			name: err instanceof Error ? err.name : undefined,
			message: err instanceof Error ? err.message : typeof err === "string" ? err : undefined,
		};
		if (err && typeof err === "object" && "errorResponse" in err) {
			const errorResponse = (err as { errorResponse?: any }).errorResponse;
			errorObj.code = errorResponse?.code;
			errorObj.httpStatus = errorResponse?.httpStatus;
			errorObj.operation = errorResponse?.operation;
			errorObj.context = errorResponse?.context;
			if (typeof errorResponse?.message === "string") {
				errorObj.message = errorResponse.message;
			}
		}

		const response: SandboxHoldResponse = {
			ok: false,
			id,
			command,
			holdSeconds,
			elapsedMs: Date.now() - startedAt,
			destroyed,
			instanceType,
			error: errorObj,
		};
		return c.json(response, 500);
	}
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

// 1) 流式返回：在 Cloudflare Sandbox 容器内运行 Claude Agent SDK（query），并把 stdout 的 NDJSON 转发给前端
// 支持 POST JSON：{ prompt?: string, messages?: Array<ClaudeInputMessage>, options?: object }
// 说明：Sandbox exec 不支持 stdin 流式写入，因此“输入流”会在 Worker 侧完整读取后再启动 SDK。
app.post("/api/agent/stream", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
		messages?: Array<{
			type: "user";
			message: {
				role: "user";
				content:
					| string
					| Array<{
							type: "text" | "image";
							text?: string;
							source?: {
								type: "base64";
								media_type: string;
								data: string;
							};
					  }>;
			};
			delayMs?: number;
		}>;
		options?: Record<string, unknown>;
	};
	const prompt =
		typeof body.prompt === "string" && body.prompt.trim()
			? body.prompt.trim()
			: "你好！请用一句话介绍你自己。";

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "stream",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const encoder = new TextEncoder();
	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `agent-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});

	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/agent-input-${reqId}.json`;
	const inputPayload = {
		prompt,
		messages: Array.isArray(body.messages) ? body.messages : undefined,
		options: typeof body.options === "object" && body.options ? body.options : undefined,
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/agent-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		// 这个 runner 在容器里执行，并把 SDK 的 streaming messages 逐行 NDJSON 输出到 stdout
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const prompt = typeof input.prompt === "string" ? input.prompt : "hello";
const messages = Array.isArray(input.messages) ? input.messages : null;
const options = input.options && typeof input.options === "object" ? input.options : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeStringify(value) {
	return JSON.stringify(
		value,
		(_k, v) => (typeof v === "bigint" ? v.toString() : v),
	);
}

function write(obj) {
	process.stdout.write(safeStringify(obj) + "\n");
}

async function* generateMessages() {
	if (messages && messages.length) {
		for (const item of messages) {
			if (item && typeof item.delayMs === "number" && item.delayMs > 0) {
				await sleep(item.delayMs);
			}
			yield item;
		}
		return;
	}
	yield {
		type: "user",
		message: { role: "user", content: prompt },
	};
}

try {
	write({ type: "meta", subtype: "start", ts: Date.now(), prompt, hasMessages: !!messages });

const maxTurns =
	typeof options?.maxTurns === "number" && Number.isFinite(options.maxTurns)
		? Math.max(1, Math.min(1, options.maxTurns))
		: 1;

const response = query({
		prompt: messages ? generateMessages() : prompt,
		options: {
			includePartialMessages: true,
			maxTurns,
			stream: true,
			...(options && typeof options === "object" ? options : {}),
			maxTurns,
			stream: true,
		},
	});

	let firstTokenEmitted = false;
	for await (const message of response) {
		if (!firstTokenEmitted && message?.type === "stream_event") {
			const event = message.event;
			if (
				event?.type === "content_block_delta" &&
				event?.delta?.type === "text_delta" &&
				typeof event.delta.text === "string" &&
				event.delta.text.length > 0
			) {
				firstTokenEmitted = true;
				write({ type: "meta", subtype: "first_token", ts: Date.now() });
			}
		}
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
				await sandbox.deleteSession(session.id).catch(() => undefined);
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

// 1b) 直接通过 Worker 调用 Anthropic API（不经 Sandbox）
app.post("/api/agent/worker-api", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
		model?: string;
		maxTokens?: number;
	};
	const prompt =
		typeof body.prompt === "string" && body.prompt.trim()
			? body.prompt.trim()
			: "你好";

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "worker-api",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const baseUrl = c.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
	const model = typeof body.model === "string" && body.model.trim() ? body.model : "claude-3-5-sonnet-20241022";
	const maxTokens =
		typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
			? Math.max(1, Math.min(2048, Math.floor(body.maxTokens)))
			: 512;

	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		accept: "text/event-stream",
	};
	if (c.env.ANTHROPIC_AUTH_TOKEN) {
		headers.authorization = `Bearer ${c.env.ANTHROPIC_AUTH_TOKEN}`;
	} else if (c.env.ANTHROPIC_API_KEY) {
		headers["x-api-key"] = c.env.ANTHROPIC_API_KEY;
	}

	const anthropic = new Anthropic({
		// apiKey: c.env.ANTHROPIC_API_KEY ?? "",
		baseURL: baseUrl,
		defaultHeaders: headers,
	});

	let stream: AsyncIterable<unknown>;
	try {
		stream = await anthropic.messages.create({
			model,
			max_tokens: maxTokens,
			stream: true,
			messages: [{ role: "user", content: prompt }],
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({
			ok: false,
			action: "worker-api",
			note: "API error (SDK)",
			data: message,
		});
	}

	const encoder = new TextEncoder();
	const responseStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
			};

			send({ type: "meta", subtype: "start", ts: Date.now(), prompt, model, maxTokens });
			let firstTokenSent = false;

			try {
				for await (const event of stream) {
					const evt = event as { type?: string; delta?: { type?: string; text?: string } };
					if (
						!firstTokenSent &&
						evt?.type === "content_block_delta" &&
						evt?.delta?.type === "text_delta" &&
						typeof evt.delta.text === "string" &&
						evt.delta.text.length > 0
					) {
						firstTokenSent = true;
						send({ type: "meta", subtype: "first_token", ts: Date.now() });
					}
					send({
						type: "sdk",
						message: {
							type: "stream_event",
							event: evt,
						},
					});
				}
			} catch (err) {
				send({
					type: "worker",
					subtype: "error",
					ts: Date.now(),
					error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
				});
			} finally {
				send({ type: "meta", subtype: "end", ts: Date.now() });
				controller.close();
			}
		},
	});

	return new Response(responseStream, {
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
		prompt?: string;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "subagents",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `subagents-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/subagents-input-${reqId}.json`;
	const inputPayload = {
		count: typeof body.count === "number" ? body.count : undefined,
		parallel: typeof body.parallel === "boolean" ? body.parallel : undefined,
		prompt: typeof body.prompt === "string" ? body.prompt : undefined,
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/subagents-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const count = Math.min(Math.max(Number(input.count) || 3, 1), 5);
const parallel = input.parallel !== false;
const prompt = typeof input.prompt === "string" && input.prompt.trim()
	? input.prompt.trim()
	: "请分别用一句话回答：什么是子 agent 的并行优势？";

const agents = {};
for (let i = 1; i <= count; i += 1) {
	const id = "agent-" + i;
	agents[id] = {
		description: "子代理 " + i + "：独立回答并给出不同视角。",
		prompt:
			"你是子代理 " +
			i +
			"。请专注于你的视角，给出简洁可验证的回答，并在末尾标注你的编号。",
	};
}

function appendAssistantText(message, parts) {
	const content = message?.message?.content;
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
}

function appendStreamDelta(message, parts) {
	const event = message?.event;
	if (
		event?.type === "content_block_delta" &&
		event?.delta?.type === "text_delta" &&
		typeof event.delta.text === "string"
	) {
		parts.push(event.delta.text);
	}
}

function appendAnyTextContent(content, parts) {
	if (!content) return;
	if (typeof content === "string") {
		parts.push(content);
		return;
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				parts.push(part.text);
			} else if (part?.type === "tool_result") {
				appendAnyTextContent(part.content, parts);
			}
		}
	}
}

function appendToolResultText(message, parts) {
	if (!message || typeof message !== "object") return;
	if (message.type === "tool_result") {
		appendAnyTextContent(message.content, parts);
	}
	if (message.type === "assistant") {
		const content = message.message?.content;
		if (!Array.isArray(content)) return;
		for (const part of content) {
			if (part?.type === "tool_result") {
				appendAnyTextContent(part.content, parts);
			}
		}
	}
}

function collectToolUses(message, toolUses) {
	if (!message || typeof message !== "object") return;
	const content = message.message?.content;
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "tool_use") {
			const input = part.input;
			const inputPreview =
				input && typeof input === "object"
					? JSON.stringify(input).slice(0, 200)
					: typeof input === "string"
						? input.slice(0, 200)
						: undefined;
			toolUses.push({
				id: part.id,
				name: part.name,
				inputPreview,
			});
		}
	}
}

function summarizeMessage(message) {
	if (!message || typeof message !== "object") return { type: typeof message };
	const type = message.type ?? "unknown";
	const summary = { type };

	if (type === "stream_event") {
		summary.eventType = message.event?.type;
		summary.deltaType = message.event?.delta?.type;
	}

	if (type === "assistant") {
		const content = message.message?.content;
		if (Array.isArray(content)) {
			const texts = content
				.filter((part) => part?.type === "text" && typeof part.text === "string")
				.map((part) => part.text);
			if (texts.length) {
				summary.textPreview = texts.join("").slice(0, 200);
			}
		}
	}

	return summary;
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

async function runOne(id) {
	const startedAt = Date.now();
	const assistantParts = [];
	const streamParts = [];
	const toolResultParts = [];
	const toolUses = [];
	const trace = [];
	let firstAssistantRaw = null;
	let firstResultRaw = null;
	const response = query({
		prompt:
			"请使用名为 " +
			id +
			" 的子代理回答问题，仅输出答案，不要描述你在调用代理：\\n" +
			prompt,
		options: {
			agents,
			maxTurns: 3,
			includePartialMessages: false,
		},
	});

	for await (const message of response) {
		if (trace.length < 12) {
			trace.push(summarizeMessage(message));
		}
		if (message?.type === "assistant") {
			if (!firstAssistantRaw) {
				try {
					firstAssistantRaw = JSON.parse(JSON.stringify(message));
				} catch {
					firstAssistantRaw = { type: message?.type };
				}
			}
			collectToolUses(message, toolUses);
			appendAssistantText(message, assistantParts);
			appendToolResultText(message, toolResultParts);
			continue;
		}
		if (message?.type === "tool_result" || message?.type === "result") {
			if (!firstResultRaw) {
				try {
					firstResultRaw = JSON.parse(JSON.stringify(message));
				} catch {
					firstResultRaw = { type: message?.type };
				}
			}
			appendToolResultText(message, toolResultParts);
			continue;
		}
		if (message?.type === "stream_event") {
			appendStreamDelta(message, streamParts);
		}
	}

	const endedAt = Date.now();
	const outputText =
		assistantParts.join("").trim() ||
		toolResultParts.join("").trim() ||
		streamParts.join("").trim();
	return {
		id,
		startedAt,
		endedAt,
		elapsedMs: endedAt - startedAt,
		output: outputText || null,
		toolUses: toolUses.length ? toolUses : undefined,
		note: outputText ? undefined : "未捕获到文本输出，可查看 trace",
		trace,
		firstAssistantRaw: outputText ? undefined : firstAssistantRaw,
		firstResultRaw: outputText ? undefined : firstResultRaw,
	};
}

const ids = Array.from({ length: count }, (_, i) => "agent-" + (i + 1));
const overallStart = Date.now();
let results;
write({ type: "status", step: "start", ts: overallStart, count, parallel });
let mainOutput = null;

if (parallel) {
	results = await Promise.all(ids.map((id) => runOne(id)));
} else {
	results = [];
	for (const id of ids) {
		results.push(await runOne(id));
	}
}

const overallEnd = Date.now();
const mainParts = [];
for (const item of results) {
	if (item && typeof item.output === "string" && item.output.trim()) {
		mainParts.push("【" + item.id + "】\n" + item.output.trim());
	}
}
if (mainParts.length) {
	const summaryPrompt =
		"你是主代理。请基于以下子代理回答给出简洁统一的主回答（合并去重，" +
		"不要逐条复述），只输出最终回答：\n\n" +
		mainParts.join("\n\n");
	const summaryResponse = query({
		prompt: summaryPrompt,
		options: { maxTurns: 1, includePartialMessages: false },
	});
	const summaryParts = [];
	for await (const message of summaryResponse) {
		if (message?.type === "assistant") {
			appendAssistantText(message, summaryParts);
		}
	}
	mainOutput = summaryParts.join("").trim() || null;
} else {
	mainOutput = null;
}
const response = {
	ok: true,
	action: "subagents",
	data: {
		ok: true,
		count,
		parallel,
		overall: {
			startedAt: overallStart,
			endedAt: overallEnd,
			elapsedMs: overallEnd - overallStart,
		},
		results,
		mainOutput,
	},
};

write({ type: "result", data: response });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 3) skill（占位）：后续可把 skill 映射为“工具/能力开关/预设 prompt”
app.get("/api/agent/skills", (c) => {
	const result: AgentActionResult = {
		ok: false,
		action: "skills",
		note: "请改用 POST /api/agent/skills 以测试 SDK Skills（filesystem）。",
	};
	return c.json(result, 400);
});

// 3) skills：在 sandbox 中创建示例 SKILL.md，并通过 SDK 发现与测试
app.post("/api/agent/skills", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
		testPrompt?: string;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "skills",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `skills-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/skills-input-${reqId}.json`;
	const inputPayload = {
		prompt:
			typeof body.prompt === "string" && body.prompt.trim()
				? body.prompt.trim()
				: "What Skills are available?",
		testPrompt:
			typeof body.testPrompt === "string" && body.testPrompt.trim()
				? body.testPrompt.trim()
				: "用中文总结这个项目的结构，并说明你会使用哪些技能。",
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/skills-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const listPrompt = input.prompt;
const testPrompt = input.testPrompt;

const skillDir = "/workspace/.claude/skills/demo-skill";
try {
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		skillDir + "/SKILL.md",
		"---\n" +
			"name: project-structure\n" +
			"description: 总结项目结构并指出关键文件与入口。\n" +
			"---\n\n" +
			"你是项目结构分析技能。目标：\n" +
			"1) 用 3-5 条要点描述项目结构\n" +
			"2) 指出 1-2 个关键入口文件\n" +
			"3) 如需读取文件，请先说明要读哪些文件\n"
	);
} catch {}

function appendAssistantText(message, parts) {
	const content = message?.message?.content;
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
}

async function runPrompt(prompt) {
	const parts = [];
	const response = query({
		prompt,
		options: {
			cwd: "/workspace",
			settingSources: ["project"],
			allowedTools: ["Skill", "Read", "Grep", "Glob"],
			maxTurns: 2,
			includePartialMessages: false,
		},
	});
	for await (const message of response) {
		if (message?.type === "assistant") {
			appendAssistantText(message, parts);
		}
	}
	return parts.join("").trim() || null;
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

write({ type: "status", step: "list", ts: Date.now() });
const listOutput = await runPrompt(listPrompt);
write({ type: "status", step: "test", ts: Date.now() });
const testOutput = await runPrompt(testPrompt);

const response = {
	ok: true,
	action: "skills",
	data: {
		ok: true,
		listPrompt,
		listOutput,
		testPrompt,
		testOutput,
		skillPath: skillDir + "/SKILL.md",
	},
};

write({ type: "result", data: response });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 4) 跟踪成本/用量（占位）：后续从 SDK 的 usage 字段或你自己的计量层取数
app.get("/api/agent/usage", (c) => {
	const result: AgentActionResult = {
		ok: false,
		action: "usage",
		note: "请改用 POST /api/agent/usage 以测试 SDK Usage 统计。",
	};
	return c.json(result, 400);
});

// 4) usage：通过 SDK 消息去重并返回 steps + 总用量
app.post("/api/agent/usage", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "usage",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `usage-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/usage-input-${reqId}.json`;
	const inputPayload = {
		prompt:
			typeof body.prompt === "string" && body.prompt.trim()
				? body.prompt.trim()
				: "请用三条要点总结这个项目的用途。",
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/usage-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const prompt = input.prompt;

const processedIds = new Set();
const steps = [];
let finalUsage = null;

function safeClone(value) {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
}

const response = query({
	prompt,
	options: { maxTurns: 2, includePartialMessages: false },
});

for await (const message of response) {
	if (message?.type === "assistant" && message?.id && message?.usage) {
		if (!processedIds.has(message.id)) {
			processedIds.add(message.id);
			steps.push({
				messageId: message.id,
				usage: safeClone(message.usage),
			});
		}
	}
	if (message?.type === "result" && message?.usage) {
		finalUsage = safeClone(message.usage);
	}
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

const responseObj = {
	ok: true,
	action: "usage",
	data: {
		ok: true,
		prompt,
		steps,
		totalUsage: finalUsage,
	},
};

write({ type: "result", data: responseObj });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 5) SDK 的斜杠命令（占位）：后续你可以在边缘实现一个简化的“命令路由”
app.get("/api/agent/slash-commands", (c) => {
	const result: AgentActionResult = {
		ok: false,
		action: "slash-commands",
		note: "请改用 POST /api/agent/slash-commands 以测试 SDK Slash Commands。",
	};
	return c.json(result, 400);
});

// 5) slash-commands：发现可用命令并测试 /compact
app.post("/api/agent/slash-commands", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		testCommand?: string;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "slash-commands",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `slash-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/slash-input-${reqId}.json`;
	const inputPayload = {
		testCommand:
			typeof body.testCommand === "string" && body.testCommand.trim()
				? body.testCommand.trim()
				: "/cost",
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/slash-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const testCommand = input.testCommand;

const cmdDir = "/workspace/.claude/commands";
try {
	mkdirSync(cmdDir, { recursive: true });
	writeFileSync(
		cmdDir + "/hello.md",
		"Return a short greeting and today's focus in one sentence."
	);
} catch {}

async function discoverCommands() {
	const found = [];
	const response = query({
		prompt: "Hello",
		options: { maxTurns: 1 },
	});
	for await (const message of response) {
		if (message?.type === "system" && message?.subtype === "init") {
			if (Array.isArray(message.slash_commands)) {
				found.push(...message.slash_commands);
			}
		}
	}
	return found;
}

async function runSlashCommand(command) {
	let compactMeta = null;
	let resultMeta = null;
	const response = query({
		prompt: command,
		options: { maxTurns: 1 },
	});
	for await (const message of response) {
		if (message?.type === "system" && message?.subtype === "compact_boundary") {
			compactMeta = message.compact_metadata ?? null;
		}
		if (message?.type === "result") {
			resultMeta = {
				subtype: message.subtype,
				usage: message.usage ?? null,
			};
		}
	}
	return { compactMeta, resultMeta };
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

const slashCommands = await discoverCommands();
const testResult = await runSlashCommand(testCommand);

const responseObj = {
	ok: true,
	action: "slash-commands",
	data: {
		ok: true,
		testCommand,
		slashCommands,
		testResult,
		customCommandPath: cmdDir + "/hello.md",
	},
};

write({ type: "result", data: responseObj });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 6) 待办事项列表（占位）：后续可以接 KV/D1/DO 持久化
app.get("/api/agent/todos", (c) => {
	const result: AgentActionResult = {
		ok: false,
		action: "todos",
		note: "请改用 POST /api/agent/todos 以测试 SDK TodoWrite。",
	};
	return c.json(result, 400);
});

// 6) todos：通过 TodoWrite 工具跟踪待办状态
app.post("/api/agent/todos", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "todos",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `todos-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/todos-input-${reqId}.json`;
	const inputPayload = {
		prompt:
			typeof body.prompt === "string" && body.prompt.trim()
				? body.prompt.trim()
				: "请用待办事项跟踪完成以下任务：1) 检查 README 结构 2) 总结应用入口 3) 给出改进建议",
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/todos-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const prompt =
	"构建一个完整的身份验证系统并使用待办事项\n" +
	input.prompt;

let todos = [];
const updates = [];
const toolUses = [];
const response = query({
	prompt,
	options: {
		maxTurns: 8,
		includePartialMessages: false,
		allowedTools: ["TodoWrite", "Read", "Grep", "Glob"],
	},
});

for await (const message of response) {
	if (message?.type === "tool_use") {
		toolUses.push({
			name: message.name,
			input: message.input ?? null,
		});
	}
	if (message?.type === "tool_use" && message?.name === "TodoWrite") {
		const next = message?.input?.todos;
		if (Array.isArray(next)) {
			todos = next;
			updates.push({
				ts: Date.now(),
				todos,
			});
		}
	}
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

const responseObj = {
	ok: true,
	action: "todos",
	data: {
		ok: true,
		prompt,
		todos,
		updates,
		toolUses,
	},
};

write({ type: "result", data: responseObj });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// 7) 结构化输出（占位）：后续用 SDK 的 schema/structured output 能力
app.post("/api/agent/structured-output", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		prompt?: string;
		schema?: Record<string, unknown>;
	};

	if (!c.env.ANTHROPIC_API_KEY && !c.env.ANTHROPIC_AUTH_TOKEN) {
		return c.json(
			{
				ok: false,
				action: "structured-output",
				note:
					"缺少密钥。请设置 ANTHROPIC_API_KEY（官方）或 ANTHROPIC_AUTH_TOKEN（中转）。",
			},
			500,
		);
	}

	const sandbox = getSandbox(c.env.Sandbox, "my-sandbox");
	const session = await sandbox.createSession({
		id: `structured-${crypto.randomUUID()}`,
		env: buildSessionEnv(c.env),
		cwd: "/workspace",
	});
	const reqId = crypto.randomUUID();
	const inputPath = `/workspace/structured-input-${reqId}.json`;
	const inputPayload = {
		prompt:
			typeof body.prompt === "string" && body.prompt.trim()
				? body.prompt.trim()
				: "请输出一个包含 summary、confidence 和 items 的结构化结果。",
		schema:
			body.schema && typeof body.schema === "object"
				? body.schema
				: {
						type: "object",
						additionalProperties: false,
						properties: {
							summary: { type: "string" },
							confidence: { type: "number" },
							items: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										title: { type: "string" },
										value: { type: "string" },
									},
									required: ["title", "value"],
								},
							},
						},
						required: ["summary", "confidence", "items"],
					},
	};
	await session.writeFile(inputPath, JSON.stringify(inputPayload), { encoding: "utf8" });

	const runnerPath = `/workspace/structured-runner-${reqId}.mjs`;
	await session.writeFile(
		runnerPath,
		String.raw`import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync("${inputPath}", "utf8"));
const prompt = input.prompt;
const schema = input.schema;

let structured = null;
let resultMeta = null;

const response = query({
	prompt,
	options: {
		outputFormat: { type: "json_schema", schema },
		maxTurns: 2,
		includePartialMessages: false,
	},
});

for await (const message of response) {
	if (message?.type === "result") {
		resultMeta = {
			subtype: message.subtype,
			usage: message.usage ?? null,
		};
		if (message.structured_output) {
			structured = message.structured_output;
		}
	}
}

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

const responseObj = {
	ok: true,
	action: "structured-output",
	data: {
		ok: true,
		prompt,
		schema,
		structured,
		resultMeta,
	},
};

write({ type: "result", data: responseObj });`,
	);

	const cmd = `node ${runnerPath}`;
	const sseStream = await session.execStream(cmd, { timeout: 10 * 60 * 1000 });
	const ndjsonStream = createNdjsonProxyStream(sseStream, cmd, async () => {
		await sandbox.deleteSession(session.id).catch(() => undefined);
	});

	return new Response(ndjsonStream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

export default app;
