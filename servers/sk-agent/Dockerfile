# sk-agent MCP Server - Dockerfile
# Multi-agent orchestration via Semantic Kernel, exposed as MCP tool server
#
# Build:   docker build -t sk-agent .
# Run:     docker run -p 8100:8100 -v ./sk_agent_config.json:/app/sk_agent_config.json:ro \
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
RUN pip install --no-cache-dir -r requirements.txt uvicorn

# Copy application code
COPY sk_agent.py sk_agent_config.py sk_conversations.py \
     document_processing.py media_processing.py ./

# Pre-cache mcp-searxng npm package (avoids download on first agent call)
RUN npx -y mcp-searxng --help 2>/dev/null || true

# Default: streamable-http mode on port 8100
ENV SK_AGENT_PORT=8100
EXPOSE 8100

CMD ["python", "sk_agent.py", "streamable-http"]
