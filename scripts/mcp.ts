// The Project Hub's MCP server over stdio (SPEC.md, Phase 9). Claude Code and
// the Claude desktop app start it; it opens no port of its own and asks the
// running hub (127.0.0.1 only) with the read-only agent token. See
// src/server/mcp-server.ts for the tools and src/server/agent-routes.ts for
// what they return.
//
// stdout carries the MCP protocol, so anything else goes to stderr.
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AGENT_TOKEN_FILE, HOST, PORT } from '../src/server/config.ts';
import { createMcpServer, HUB_DOWN, hubFetch, type AgentFetch } from '../src/server/mcp-server.ts';

// The hub creates the token on start; read it per call so a hub started after
// this process (or a new token) still works.
const get: AgentFetch = (path) => {
  let token: string;
  try {
    token = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim();
  } catch {
    return Promise.reject(new Error(`${HUB_DOWN} (No ${AGENT_TOKEN_FILE} yet: the hub creates it when it starts.)`));
  }
  return hubFetch(`http://${HOST}:${PORT}`, token)(path);
};

const server = createMcpServer(get);
await server.connect(new StdioServerTransport());
console.error('project-hub MCP server ready (stdio)');
