// Real MCP-driven request_confirmation demo.
//
// Acts as a Claude Code agent: spawns the IAK MCP server, calls
// request_confirmation as it would in production, blocks until the user
// decides. The intent goes through the production MCP code path, forwarded
// to the live iak-mcp-daemon, surfaces in CodeWatch + GroupMind, and the
// decision flows back through the same channels.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/Users/petrus/ide-agent-kit/src/mcp-server.mjs'],
});

const client = new Client(
  { name: 'iak-real-agent-demo', version: '0.0.1' },
  { capabilities: {} }
);

await client.connect(transport);

console.log('[demo] connected — calling request_confirmation...');

const result = await client.callTool({
  name: 'request_confirmation',
  arguments: {
    prompt: process.argv[2] || 'Real agent test: deploy build to production server?',
    session: 'claudemb-real-demo',
    timeoutSec: 600,
  },
});

console.log('[demo] result:');
console.log(JSON.stringify(result, null, 2));

await client.close();
