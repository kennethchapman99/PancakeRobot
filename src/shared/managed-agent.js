/**
 * Reusable Managed Agent helper for Pancake Robot
 *
 * - Reads pancake-robot.config.json for existing agent/environment IDs
 * - Creates agents/environments if they don't exist, persists IDs
 * - runAgent(agentName, task) → streams session, returns full response
 * - Logs all token usage to SQLite
 */

import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { calculateCost, generateRunId } from './costs.js';
import { logRun, logError } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../pancake-robot.config.json');

// Agent colors for terminal output
const AGENT_COLORS = {
  researcher: chalk.cyan,
  'brand-manager': chalk.magenta,
  lyricist: chalk.green,
  'product-manager': chalk.blue,
  'financial-manager': chalk.yellow,
  'creative-manager': chalk.red,
  'ops-manager': chalk.white,
};

// Environment name (single shared environment)
const ENV_NAME = 'pancake-robot-env';

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      version: '1.0.0',
      agents: {},
      environment: null,
      brand: null,
      distribution: null,
      schedule: {},
      songs: [],
    };
  }
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Get or create the shared cloud environment
 */
async function getOrCreateEnvironment(config) {
  const client = getClient();

  if (config.environment?.id) {
    // Verify it still exists
    try {
      await client.beta.environments.retrieve(config.environment.id);
      return config.environment.id;
    } catch {
      console.log(chalk.dim('Environment stale, recreating...'));
    }
  }

  console.log(chalk.dim('Creating cloud environment...'));
  const env = await client.beta.environments.create({
    name: ENV_NAME,
    config: {
      type: 'cloud',
      networking: { type: 'unrestricted' },
    },
  });

  config.environment = { id: env.id, name: ENV_NAME, created_at: new Date().toISOString() };
  saveConfig(config);
  console.log(chalk.dim(`Environment created: ${env.id}`));
  return env.id;
}

/**
 * Get or create a named agent
 */
async function getOrCreateAgent(agentName, agentDef, config) {
  const client = getClient();
  const model = agentDef.model || 'claude-sonnet-4-6';
  // Use name+model as config key so Haiku/Sonnet variants are stored separately
  const configKey = [
    agentName,
    agentDef.model?.includes('haiku') ? 'haiku' : null,
    agentDef.noTools ? 'notool' : null,
  ].filter(Boolean).join('-');

  if (config.agents[configKey]?.id) {
    try {
      const agent = await client.beta.agents.retrieve(config.agents[configKey].id);
      return { id: agent.id, version: agent.version };
    } catch {
      console.log(chalk.dim(`Agent ${configKey} stale, recreating...`));
    }
  }

  // noTools: true = pure text generation (no web search, no bash)
  // Use for creative/structured agents that don't need live data
  const tools = agentDef.noTools
    ? []
    : [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }];

  console.log(chalk.dim(`Creating agent: ${configKey} (${model}${agentDef.noTools ? ', no-tools' : ', toolset'})...`));
  const agent = await client.beta.agents.create({
    name: agentDef.name,
    model,
    system: agentDef.system,
    tools,
  });

  config.agents[configKey] = {
    id: agent.id,
    version: agent.version,
    name: agentDef.name,
    model,
    created_at: new Date().toISOString(),
  };
  saveConfig(config);
  console.log(chalk.dim(`Agent created: ${agent.id}`));
  return { id: agent.id, version: agent.version };
}

/**
 * Run a noTools agent using client.messages.create directly.
 * Sessions API is for tool-using agents with environments — for pure text
 * generation, direct messages.create is simpler, faster, and more reliable.
 */
async function runAgentDirect(agentName, agentDef, task, options = {}) {
  const color = AGENT_COLORS[agentName] || chalk.white;
  const label = color.bold(`[${agentName.toUpperCase()}]`);
  const client = getClient();
  const model = agentDef.model || 'claude-sonnet-4-6';
  const runId = generateRunId();
  const startTime = Date.now();

  console.log(`\n${label} ${chalk.dim(`Direct call (${model}, no-tools)`)}`);
  console.log(`${label} ${chalk.italic(task.substring(0, 120))}${task.length > 120 ? '...' : ''}`);

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    system: agentDef.system,
    messages: [{ role: 'user', content: task }],
    stream: true,
  });

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of response) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      process.stdout.write(color(event.delta.text));
      fullText += event.delta.text;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens || 0;
    } else if (event.type === 'message_start' && event.message?.usage) {
      inputTokens = event.message.usage.input_tokens || 0;
    }
  }

  process.stdout.write('\n');

  if (!fullText.trim()) {
    throw new Error(`${agentName} direct call completed with no output`);
  }

  const runtimeSeconds = (Date.now() - startTime) / 1000;
  const costUsd = calculateCost({ inputTokens, outputTokens, cacheReadTokens: 0 });

  try {
    logRun({
      id: runId,
      agentName,
      taskSummary: task.substring(0, 200),
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      runtimeSeconds,
      costUsd,
      sessionId: 'direct',
      status: 'success',
    });
  } catch (dbErr) {
    console.log(chalk.yellow(`${label} Warning: could not log run to DB — ${dbErr.message}`));
  }

  console.log(
    `${label} ${chalk.dim(`Done in ${runtimeSeconds.toFixed(1)}s | ${inputTokens}in/${outputTokens}out tokens | $${costUsd.toFixed(5)}`)}`
  );

  return {
    text: fullText,
    content: [{ type: 'text', text: fullText }],
    usage: { inputTokens, outputTokens, cacheReadTokens: 0 },
    costUsd,
    runtimeSeconds,
    sessionId: 'direct',
    runId,
  };
}

/**
 * Run an agent with a task, streaming the session live.
 * noTools agents use client.messages.create directly (simpler, more reliable).
 * Tool-using agents use the Managed Sessions API with cloud environment.
 * Returns the full text response and usage stats.
 */
export async function runAgent(agentName, agentDef, task, options = {}) {
  // noTools agents don't need sessions/environments — use direct API
  if (agentDef.noTools) {
    return runAgentDirect(agentName, agentDef, task, options);
  }

  const color = AGENT_COLORS[agentName] || chalk.white;
  const label = color.bold(`[${agentName.toUpperCase()}]`);
  const client = getClient();
  const config = loadConfig();

  const maxRetries = options.maxRetries ?? 0;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 30000;
      console.log(chalk.dim(`Retrying ${agentName} in ${delay / 1000}s...`));
      await new Promise(r => setTimeout(r, delay));
    }

    let session = null;
    try {
      // Get or create agent and shared environment
      const { id: agentId, version: agentVersion } = await getOrCreateAgent(agentName, agentDef, config);
      const envId = await getOrCreateEnvironment(config);

      // Create session
      session = await client.beta.sessions.create({
        agent: { type: 'agent', id: agentId, version: agentVersion },
        environment_id: envId,
        title: `${agentName} — ${new Date().toISOString()}`,
      });

      const sessionId = session.id;
      const startTime = Date.now();
      const runId = generateRunId();

      console.log(`\n${label} ${chalk.dim(`Session: ${sessionId}`)}`);
      console.log(`${label} ${chalk.italic(task.substring(0, 120))}${task.length > 120 ? '...' : ''}`);

      // STREAM-FIRST: open stream before sending message
      const stream = await client.beta.sessions.events.stream(sessionId);

      // Send the task message
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: task }],
          },
        ],
      });

      // Accumulate response
      const responseBlocks = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;

      for await (const event of stream) {
        switch (event.type) {
          case 'agent.message': {
            for (const block of event.content || []) {
              if (block.type === 'text') {
                responseBlocks.push(block);
                // Stream text to terminal
                process.stdout.write(color(block.text));
              }
            }
            break;
          }
          case 'agent.thinking': {
            if (options.showThinking) {
              for (const block of event.content || []) {
                if (block.type === 'thinking') {
                  process.stdout.write(chalk.dim(`[thinking] ${block.thinking.substring(0, 100)}...\n`));
                }
              }
            }
            break;
          }
          case 'agent.tool_use': {
            const toolName = event.tool_name || event.name || 'unknown';
            console.log(`\n${label} ${chalk.dim(`→ tool: ${toolName}`)}`);
            break;
          }
          case 'agent.mcp_tool_use': {
            console.log(`\n${label} ${chalk.dim(`→ mcp: ${event.tool_name}`)}`);
            break;
          }
          case 'span.model_request_end': {
            if (event.model_usage) {
              inputTokens += event.model_usage.input_tokens || 0;
              outputTokens += event.model_usage.output_tokens || 0;
              cacheReadTokens += event.model_usage.cache_read_input_tokens || 0;
            }
            break;
          }
          case 'session.error': {
            const errMsg = event.error?.message || JSON.stringify(event);
            console.log(`\n${label} ${chalk.red(`Session error: ${errMsg}`)}`);
            throw new Error(errMsg);
          }
          case 'session.status_idle': {
            if (event.stop_reason?.type !== 'requires_action') {
              // Terminal idle — done
              break;
            }
            // requires_action means waiting for a tool result — keep streaming
            break;
          }
          case 'session.status_terminated': {
            if (responseBlocks.length === 0) {
              throw new Error('terminated: session ended before producing output');
            }
            break;
          }
        }

        // Break on terminal states
        if (event.type === 'session.status_terminated') break;
        if (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action') break;
      }

      process.stdout.write('\n');

      const fullText = responseBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      // Guard: don't return empty output as success
      if (!fullText.trim()) {
        throw new Error(`Session ${sessionId} completed with no output`);
      }

      const runtimeSeconds = (Date.now() - startTime) / 1000;
      const costUsd = calculateCost({ inputTokens, outputTokens, cacheReadTokens });

      // Log to SQLite — non-fatal, never let a DB error kill a completed run
      try {
        logRun({
          id: runId,
          agentName,
          taskSummary: task.substring(0, 200),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          runtimeSeconds,
          costUsd,
          sessionId,
          status: 'success',
        });
      } catch (dbErr) {
        console.log(chalk.yellow(`${label} Warning: could not log run to DB — ${dbErr.message}`));
      }

      console.log(
        `${label} ${chalk.dim(`Done in ${runtimeSeconds.toFixed(1)}s | ${inputTokens}in/${outputTokens}out tokens | $${costUsd.toFixed(5)}`)}`
      );

      return {
        text: fullText,
        content: responseBlocks,
        usage: { inputTokens, outputTokens, cacheReadTokens },
        costUsd,
        runtimeSeconds,
        sessionId,
        runId,
      };
    } catch (err) {
      lastError = err;
      console.log(chalk.red(`\n${label} FAILED: ${err.message}`));
      console.log(chalk.red(`${label} Session ID was: ${session?.id ?? 'not created'}`));

      logError({
        agentName,
        errorMessage: err.message,
        context: { task: task.substring(0, 200), attempt, sessionId: session?.id },
      });

      // If agent ID is stale (404), clear it and retry
      if (err.status === 404 || err.message?.includes('not_found')) {
        const cfg = loadConfig();
        delete cfg.agents[agentName];
        saveConfig(cfg);
      }
    }
  }

  throw new Error(`Agent ${agentName} failed after ${maxRetries + 1} attempts: ${lastError?.message}`);
}

/**
 * Parse JSON from agent response (handles markdown code fences)
 */
export function parseAgentJson(text) {
  // Try to extract JSON from code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Try raw parse
  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* fall through */ }
  }

  throw new Error('Could not parse JSON from agent response');
}
