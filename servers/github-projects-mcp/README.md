# GitHub Projects MCP Server

This MCP server provides tools to interact with GitHub Projects.

## Prerequisites

- Node.js
- A GitHub Personal Access Token with `repo` and `project` scopes.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Create a `.env` file in the root of this server's directory (`mcps/internal/servers/github-projects-mcp`).
3.  Add your GitHub token to the `.env` file:
    ```
    GITHUB_TOKEN=your_personal_access_token
    ```

## Running the Server

To start the server for development or general use:

```bash
npm start
```

## Testing

The End-to-End (E2E) tests require the server to be running independently.

**1. Build the project:**

Make sure you have the latest code compiled:
```bash
npm run build
```

**2. Start the test server:**

In your first terminal, run:
```bash
npm run start:e2e
```
The server will start on the port specified in the `.env` file or on port 3000 by default. The E2E tests will connect to it on port 3001.

**3. Run the E2E tests:**

In a second terminal, run:
```bash
npm run test:e2e
```
Jest will execute the tests located in the `tests/` directory against the running server.