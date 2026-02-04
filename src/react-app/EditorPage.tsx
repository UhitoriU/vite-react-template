import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorContent, ReactRenderer, useEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Markdown } from "@tiptap/markdown";
import Suggestion from "@tiptap/suggestion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import mermaid, { type MermaidConfig } from "mermaid";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import "tippy.js/dist/tippy.css";
import "./EditorPage.css";

const initialMarkdown = `# 富文本编辑器 + Markdown 预览\n\n这是一个 **Tiptap 富文本编辑器**（支持 Markdown 快捷输入）+ 右侧 Markdown 渲染预览。\n\n## 列表\n- 无序列表\n- 另一个条目\n\n1. 有序列表\n2. 第二项\n\n- [x] 任务已完成\n- [ ] 任务未完成\n\n## 表格\n\n| 功能 | 状态 | 说明 |\n| --- | --- | --- |\n| 代码块 | ✅ | 支持语法高亮 |\n| 图片 | ✅ | 支持 Markdown 图片 |\n| Mermaid | ✅ | 支持流程图/时序图 |\n| LaTeX | ✅ | 行内与块级公式 |\n\n## 图片\n\n![示例图片](https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=800)\n\n## 代码块\n\n\`\`\`ts\nfunction greet(name: string) {\n  return \"Hello, \" + name + \"!\";\n}\n\nconsole.log(greet(\"Markdown\"));\n\`\`\`\n\n## Mermaid\n\n\`\`\`mermaid\nflowchart TD\n  A[开始] --> B{是否继续?}\n  B -- 是 --> C[继续处理]\n  B -- 否 --> D[结束]\n\`\`\`\n\n## LaTeX\n\n行内公式：$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$\n\n块级公式：\n\n$$\n\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n\n> 提示：左侧编辑器支持 Markdown 快捷输入（例如 \`**bold**\` 自动变成加粗）。\n`;

const mermaidConfig: MermaidConfig = {
	startOnLoad: false,
	securityLevel: "strict",
	theme: "neutral",
};

mermaid.initialize(mermaidConfig);

type SlashItem = {
	title: string;
	description: string;
	command: (args: { editor: any; range: { from: number; to: number } }) => void;
};

function SlashList({
	items,
	command,
	selectedIndex,
	onSelect,
}: {
	items: SlashItem[];
	command: (item: SlashItem) => void;
	selectedIndex: number;
	onSelect: (index: number) => void;
}) {
	return (
		<div className="slashMenu">
			{items.length === 0 ? (
				<div className="slashEmpty">没有匹配的命令</div>
			) : (
				items.map((item, index) => (
					<button
						key={item.title}
						className={index === selectedIndex ? "slashItem active" : "slashItem"}
						onClick={() => command(item)}
						onMouseEnter={() => onSelect(index)}
						type="button"
					>
						<div className="slashTitle">{item.title}</div>
						<div className="slashDesc">{item.description}</div>
					</button>
				))
			)}
		</div>
	);
}

function MermaidBlock({ code }: { code: string }) {
	const reactId = useId();
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const renderId = useMemo(() => `mermaid-${reactId.replace(/[:]/g, "_")}`, [reactId]);

	useEffect(() => {
		let cancelled = false;
		const render = async () => {
			try {
				setError(null);
				const { svg } = await mermaid.render(renderId, code);
				if (!cancelled) setSvg(svg);
			} catch (err) {
				if (!cancelled) {
					setSvg("");
					setError(err instanceof Error ? err.message : "Mermaid render failed");
				}
			}
		};
		render();
		return () => {
			cancelled = true;
		};
	}, [code, renderId]);

	if (error) {
		return (
			<pre className="markdownError">
				Mermaid 渲染失败：{error}\n\n{code}
			</pre>
		);
	}

	return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function EditorPage() {
	const [markdownSource, setMarkdownSource] = useState(initialMarkdown);
	const [autoSync, setAutoSync] = useState(true);
	const autoSyncRef = useRef(true);

	useEffect(() => {
		autoSyncRef.current = autoSync;
	}, [autoSync]);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				bulletList: { keepMarks: true, keepAttributes: false },
				orderedList: { keepMarks: true, keepAttributes: false },
			}),
			Link.configure({ openOnClick: false, autolink: true }),
			Image,
			Placeholder.configure({ placeholder: "输入 / 试试快捷命令，或直接输入 Markdown 快捷语法..." }),
			Table.configure({ resizable: true }),
			TableRow,
			TableHeader,
			TableCell,
			TaskList,
			TaskItem.configure({ nested: true }),
			Underline,
			Highlight,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			Markdown,
			Extension.create({
				name: "slashCommand",
				addProseMirrorPlugins() {
					const editor = this.editor;
					const items: SlashItem[] = [
						{
							title: "标题 1",
							description: "插入 H1 标题",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
						},
						{
							title: "标题 2",
							description: "插入 H2 标题",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
						},
						{
							title: "无序列表",
							description: "开始一个无序列表",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).toggleBulletList().run(),
						},
						{
							title: "有序列表",
							description: "开始一个有序列表",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
						},
						{
							title: "引用",
							description: "插入引用块",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
						},
						{
							title: "代码块",
							description: "插入代码块",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
						},
						{
							title: "任务列表",
							description: "插入任务列表",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).toggleTaskList().run(),
						},
						{
							title: "表格",
							description: "插入 3x3 表格",
							command: ({ editor, range }) =>
								editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
						},
						{
							title: "图片",
							description: "插入图片 URL",
							command: ({ editor, range }) => {
								const url = window.prompt("请输入图片 URL");
								if (!url) return;
								editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
							},
						},
					];

					return [
						Suggestion({
							editor,
							char: "/",
							startOfLine: false,
							items: ({ query }) =>
								items
									.filter((item) =>
										item.title.toLowerCase().includes(query.toLowerCase()) ||
										item.description.toLowerCase().includes(query.toLowerCase()),
									)
									.slice(0, 8),
							render: () => {
								let component: ReactRenderer | null = null;
								let popup: TippyInstance | null = null;
								let selectedIndex = 0;
								let currentItems: SlashItem[] = [];
								let currentCommand: ((item: SlashItem) => void) | null = null;

								const updateSelection = (index: number) => {
									selectedIndex = index;
									if (component) {
										component.updateProps({ selectedIndex });
									}
								};

								return {
									onStart: (props) => {
										selectedIndex = 0;
										currentItems = props.items as SlashItem[];
										currentCommand = (item: SlashItem) => props.command(item);
										component = new ReactRenderer(SlashList, {
											props: {
												items: currentItems,
												selectedIndex,
												onSelect: updateSelection,
												command: (item: SlashItem) => props.command(item),
											},
											editor: props.editor,
										});

										if (!props.clientRect) return;
										popup = tippy(document.body, {
											getReferenceClientRect: props.clientRect as any,
											appendTo: () => document.body,
											content: component.element,
											showOnCreate: true,
											interactive: true,
											trigger: "manual",
											placement: "bottom-start",
											theme: "light-border",
										});
									},
									onUpdate(props) {
										currentItems = props.items as SlashItem[];
										currentCommand = (item: SlashItem) => props.command(item);
										component?.updateProps({
											items: currentItems,
											selectedIndex,
											onSelect: updateSelection,
											command: (item: SlashItem) => props.command(item),
										});

										if (!props.clientRect) return;
										popup?.setProps({
											getReferenceClientRect: props.clientRect as any,
										});
									},
									onKeyDown(props) {
										if (props.event.key === "Escape") {
											popup?.hide();
											return true;
										}
										if (props.event.key === "ArrowDown") {
											updateSelection(
												(selectedIndex + 1) % (currentItems.length || 1),
											);
											return true;
										}
										if (props.event.key === "ArrowUp") {
											updateSelection(
												(selectedIndex - 1 + (currentItems.length || 1)) %
													(currentItems.length || 1),
											);
											return true;
										}
										if (props.event.key === "Enter") {
											const item = currentItems[selectedIndex] as SlashItem | undefined;
											if (item) {
												currentCommand?.(item);
												return true;
											}
										}
										return false;
									},
									onExit() {
										popup?.destroy();
										component?.destroy();
									},
								};
							},
							command: ({ editor, range, props }) => {
								(props as SlashItem).command({ editor, range });
							},
						}),
					];
				},
			}),
		],
		content: "",
		onCreate: ({ editor }) => {
			const cmd = editor.commands as unknown as { setMarkdown?: (value: string) => void };
			if (cmd.setMarkdown) {
				cmd.setMarkdown(initialMarkdown);
			} else {
				editor.commands.setContent("<p>开始输入...</p>");
			}
		},
		onUpdate: ({ editor }) => {
			if (!autoSyncRef.current) return;
			const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
			const next = storage?.markdown?.getMarkdown?.();
			if (typeof next === "string" && next.trim().length > 0) {
				setMarkdownSource(next);
			}
		},
	});

	const insertImage = () => {
		const url = window.prompt("请输入图片 URL");
		if (!url || !editor) return;
		editor.chain().focus().setImage({ src: url }).run();
	};

	const insertTable = () => {
		if (!editor) return;
		editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
	};

	const insertMermaid = () => {
		if (!editor) return;
		const sample = "flowchart TD\n  A --> B\n  B --> C";
		const cmd = editor.commands as unknown as { setMarkdown?: (value: string) => void };
		const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
		const current = storage?.markdown?.getMarkdown?.() ?? "";
		const next = `${current}\n\n\`\`\`mermaid\n${sample}\n\`\`\``;
		if (cmd.setMarkdown) {
			cmd.setMarkdown(next);
			setMarkdownSource(next);
			return;
		}
		editor.chain().focus().setCodeBlock().insertContent(sample).run();
		setMarkdownSource(next);
	};

	const insertMath = () => {
		if (!editor) return;
		editor.chain().focus().insertContent("$\\sum_{i=1}^{n} i$ ").run();
	};

	const syncFromEditor = () => {
		if (!editor) return;
		const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
		const next = storage?.markdown?.getMarkdown?.();
		if (typeof next === "string") {
			setMarkdownSource(next);
		}
	};

	return (
		<div className="editorPage">
			<div className="editorColumn">
				<div className="editorHeader">
					<h1>富文本编辑器（Tiptap）</h1>
					<p>支持 Markdown 快捷输入，点击按钮可插入常见结构。</p>
				</div>

				<div className="toolbar">
					<button onClick={() => editor?.chain().focus().toggleBold().run()}>
						加粗
					</button>
					<button onClick={() => editor?.chain().focus().toggleItalic().run()}>
						斜体
					</button>
					<button onClick={() => editor?.chain().focus().toggleUnderline().run()}>
						下划线
					</button>
					<button onClick={() => editor?.chain().focus().toggleStrike().run()}>
						删除线
					</button>
					<button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
						H2
					</button>
					<button onClick={() => editor?.chain().focus().toggleBulletList().run()}>
						无序列表
					</button>
					<button onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
						有序列表
					</button>
					<button onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
						引用
					</button>
					<button onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
						代码块
					</button>
					<button onClick={insertTable}>表格</button>
					<button onClick={insertImage}>图片</button>
					<button onClick={insertMermaid}>Mermaid</button>
					<button onClick={insertMath}>LaTeX</button>
				</div>

				<div className="editorBody">
					<EditorContent editor={editor} className="tiptap" />
				</div>
			</div>

			<div className="previewColumn">
				<div className="previewHeader">
					<h2>Markdown 渲染预览</h2>
					<div className="previewActions">
						<button onClick={syncFromEditor}>从编辑器同步</button>
						<button onClick={() => setAutoSync((prev) => !prev)}>
							{autoSync ? "关闭自动同步" : "开启自动同步"}
						</button>
					</div>
				</div>
				<textarea
					className="markdownInput"
					value={markdownSource}
					onChange={(event) => setMarkdownSource(event.target.value)}
				/>
				<div className="markdownPreview">
					<ReactMarkdown
						remarkPlugins={[remarkGfm, remarkMath]}
						rehypePlugins={[rehypeKatex, rehypeHighlight]}
						components={{
							code({ className, children, ...props }) {
								const codeString = String(children ?? "").replace(/\n$/, "");
								const language = className?.replace("language-", "") ?? "";
								const isBlock = Boolean(className);
								if (!isBlock) {
									return (
										<code className={className} {...props}>
											{children}
										</code>
									);
								}
								if (language === "mermaid") {
									return <MermaidBlock code={codeString} />;
								}
								return (
									<pre className="markdownCode">
										<code className={className} {...props}>
											{codeString}
										</code>
									</pre>
								);
							},
							img({ ...props }) {
								return <img {...props} loading="lazy" />;
							},
							blockquote({ children }) {
								return <blockquote className="markdownQuote">{children}</blockquote>;
							},
							table({ children }) {
								return (
									<div className="markdownTable">
										<table>{children}</table>
									</div>
								);
							},
						}}
					>
						{markdownSource}
					</ReactMarkdown>
				</div>
			</div>
		</div>
	);
}
