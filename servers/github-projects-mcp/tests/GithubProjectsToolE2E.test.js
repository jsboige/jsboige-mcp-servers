const axios = require('axios');

describe('GitHub Projects MCP E2E Test', () => {
  const port = process.env.PORT || 3001;

  it('should list projects for a valid owner', async () => {
    const response = await axios.post(`http://localhost:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'list_projects',
      params: {
        owner: 'microsoft'
      }
    });

    expect(response.status).toBe(200);
    expect(response.data.jsonrpc).toBe('2.0');
    expect(response.data.result).toBeDefined();
    expect(Array.isArray(response.data.result.projects)).toBe(true);
  });

  it('should return an error for an invalid owner', async () => {
    const response = await axios.post(`http://localhost:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'list_projects',
      params: {
        owner: 'non-existent-owner-for-test'
      }
    });

    expect(response.status).toBe(200); // MCP returns errors in the body with a 200 OK
    expect(response.data.jsonrpc).toBe('2.0');
    expect(response.data.result).toBeUndefined();
    expect(response.data.error).toBeDefined();
    expect(response.data.error.code).toBe(-32603); // Internal error
    expect(response.data.error.message).toContain('Request failed with status code 404');
  });
});