FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.7.0

# Claude Agent SDK 文档要求 Claude Code CLI（在容器沙箱里安装）
RUN npm install -g @anthropic-ai/claude-code

# 在沙箱里运行 Agent SDK（由 Worker 触发 exec/execStream）
# 安装到 /workspace 以便 ESM 解析（Node 不默认解析全局模块）
WORKDIR /workspace
RUN npm init -y
RUN npm install @anthropic-ai/claude-agent-sdk

# 可选：提高命令执行默认超时（示例值 5 分钟）
ENV COMMAND_TIMEOUT_MS=300000

# 本地开发时，若要 exposePort/preview URL，会用到 EXPOSE
EXPOSE 8080
