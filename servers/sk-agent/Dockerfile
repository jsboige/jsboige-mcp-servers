# sk-agent MCP Server - Dockerfile
# Multi-agent orchestration via Semantic Kernel, exposed as MCP tool server
#
# Build:   docker build -t sk-agent .
# Run:     docker run -p 127.0.0.1:8100:8100 -v ./sk_agent_config.json:/app/sk_agent_config.json:ro \
#            -e SK_AGENT_API_KEY=<key> sk-agent

FROM python:3.11-slim

# Install Node.js (required for npx mcp-searxng subprocess)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# #4741: isolated venv for the markitdown MCP plugin. markitdown-mcp needs
# mcp>=2.1.1 while sk_agent.py pins the mcp 1.x API (mcp.server.fastmcp,
# removed in 2.x) — the same isolation the host seat provisions as
# venv-markitdown/ (#3411), mirrored here so ONE config entry (with its
# `container: {command, args}` override) serves both runtimes.
COPY requirements-markitdown.txt .
RUN python -m venv /opt/venv-markitdown && \
    /opt/venv-markitdown/bin/pip install --no-cache-dir -r requirements-markitdown.txt

# Copy application code
COPY sk_agent.py sk_agent_config.py sk_agent_schemas.py sk_agent_specs.py \
     sk_agent_capacity_gate.py sk_conversations.py sk_context_condensation.py \
     sk_agent_turns.py \
     github_plugin.py document_processing.py media_processing.py ./

# Guard: fail the BUILD if this list drifts from the real import graph.
# Without it a missing module only surfaces when the container starts,
# i.e. after the previous image has already been replaced.
RUN python -c "import sk_agent" > /dev/null

# Pre-cache mcp-searxng npm package (avoids download on first agent call)
RUN npx -y mcp-searxng --help 2>/dev/null || true

# Default: streamable-http mode on port 8100.
# #4741: runtime identity — the container is the ONLY launcher that sets
# this marker; unset means "stdio" on every host seat (sk_agent_config.
# current_runtime). Plugins whose `runtimes` list excludes it never spawn
# here, and agents requiring them are refused with a typed error.
ENV SK_AGENT_HOST=0.0.0.0 \
    SK_AGENT_PORT=8100 \
    SK_AGENT_RUNTIME=container
EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8100/healthz > /dev/null || exit 1

CMD ["python", "sk_agent.py", "streamable-http"]
