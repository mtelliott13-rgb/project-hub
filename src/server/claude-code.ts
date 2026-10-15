import { getSessionInfo, listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { z } from 'zod';
import { agentSchema, type RunningAgent } from './sessions.ts';

// Documented interfaces only (SPEC.md): the transcript format itself is internal.

export const listAllSessions = (): Promise<SDKSessionInfo[]> => listSessions();

export const sessionInfo = (id: string, dir: string) => getSessionInfo(id, { dir });

/** Sessions Claude Code reports as running. Throws if the CLI fails. */
export async function runningAgents(): Promise<RunningAgent[]> {
  const { stdout } = await execa('claude', ['agents', '--json'], { timeout: 15_000 });
  return z.array(agentSchema).parse(JSON.parse(stdout));
}
