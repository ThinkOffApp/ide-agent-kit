#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Entry point for the IAK MCP server. Designed to be invoked by an MCP
// client over stdio. Example Claude Desktop / Code config:
//
//   {
//     "mcpServers": {
//       "ide-agent-kit": {
//         "command": "node",
//         "args": ["/path/to/ide-agent-kit/bin/iak-mcp.mjs"]
//       }
//     }
//   }
//
// Or via npx if installed as a package: `npx ide-agent-kit-mcp`.

import { runMcpServer } from '../src/mcp-server.mjs';

const argv = process.argv.slice(2);
let configPath;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--config' && argv[i + 1]) {
    configPath = argv[i + 1];
    i++;
  }
}

runMcpServer({ configPath }).catch((e) => {
  process.stderr.write(`[iak-mcp] fatal: ${e.message}\n`);
  process.exit(1);
});
