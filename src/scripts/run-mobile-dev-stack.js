import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(rootDir, '.env'), override: false });

const WEB_PORT = String(process.env.WEB_PORT || '3737');
const ADMIN_PORT = String(process.env.WORKFLOW_ADMIN_PORT || '3747');
const DISABLE_NGROK = isTruthy(process.env.PANCAKE_DISABLE_NGROK);
const TUNNEL_PROVIDER = resolveTunnelProvider();
const CLOUDFLARE_PROTOCOL = resolveCloudflareProtocol();
const CLOUDFLARED_COMMAND = findCommand('cloudflared', ['--version'], [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
]);
const KILL_EXISTING_NGROK = process.env.PANCAKE_KILL_EXISTING_NGROK !== 'false';

const children = [];

main().catch(error => {
  console.error(`[dev:mobile] ${error.message}`);
  shutdown(1);
});

async function main() {
  const caffeinate = startCaffeinate();
  if (caffeinate) children.push(caffeinate);

  let publicBaseUrl = resolveStaticNgrokUrl();
  publicBaseUrl = await resolvePublicBaseUrl(TUNNEL_PROVIDER, publicBaseUrl);

  if (!publicBaseUrl) publicBaseUrl = `http://localhost:${WEB_PORT}`;

  const childEnv = {
    ...process.env,
    PUBLIC_APP_BASE_URL: publicBaseUrl,
    PUBLIC_BASE_URL: publicBaseUrl,
  };

  console.log(`[dev:mobile] PUBLIC_APP_BASE_URL=${publicBaseUrl}`);
  console.log(`[dev:mobile] Web:   http://localhost:${WEB_PORT}`);
  console.log(`[dev:mobile] Admin: http://localhost:${ADMIN_PORT}/workflow-runs`);

  children.push(startNpmScript('web', childEnv));
  children.push(startNpmScript('workflow:admin', childEnv));
  children.push(startNpmScript('telegram', childEnv));

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}

async function resolvePublicBaseUrl(provider, staticNgrokUrl) {
  if (provider === 'none') return `http://localhost:${WEB_PORT}`;
  if (provider === 'cloudflare') return startCloudflareTunnelOrThrow();
  if (provider === 'ngrok') return startNgrokTunnelOrThrow(staticNgrokUrl);
  return startAutoTunnel(staticNgrokUrl);
}

function resolveTunnelProvider() {
  if (DISABLE_NGROK) return 'none';

  const provider = String(process.env.PANCAKE_TUNNEL_PROVIDER || 'auto').trim().toLowerCase();
  if (['none', 'cloudflare', 'ngrok', 'auto'].includes(provider)) return provider;
  throw new Error(`Unsupported PANCAKE_TUNNEL_PROVIDER=${provider}. Use none, cloudflare, ngrok, or auto.`);
}

function resolveCloudflareProtocol() {
  const protocol = String(process.env.PANCAKE_CLOUDFLARE_PROTOCOL || 'http2').trim().toLowerCase();
  if (['http2', 'quic', 'auto'].includes(protocol)) return protocol;
  throw new Error(`Unsupported PANCAKE_CLOUDFLARE_PROTOCOL=${protocol}. Use http2, quic, or auto.`);
}

async function startAutoTunnel(staticNgrokUrl) {
  const errors = [];

  if (commandExists(CLOUDFLARED_COMMAND, ['--version'])) {
    try {
      return await startCloudflareTunnelOrThrow();
    } catch (error) {
      errors.push(error.message);
      console.error(`[dev:mobile] cloudflare tunnel failed; trying ngrok. ${error.message}`);
    }
  } else {
    console.error('[dev:mobile] cloudflared is not installed or is not on PATH. To use Cloudflare tunnels: brew install cloudflared');
  }

  if (commandExists('ngrok', ['version'])) {
    try {
      return await startNgrokTunnelOrThrow(staticNgrokUrl);
    } catch (error) {
      errors.push(error.message);
      console.error(`[dev:mobile] ngrok tunnel failed. ${error.message}`);
    }
  } else {
    errors.push('ngrok is not installed or is not on PATH.');
  }

  console.error('[dev:mobile] No public tunnel is available; falling back to local-only mode.');
  if (errors.length) console.error(`[dev:mobile] Tunnel errors: ${errors.join(' | ')}`);
  console.error('[dev:mobile] Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot');
  return `http://localhost:${WEB_PORT}`;
}

async function startCloudflareTunnelOrThrow() {
  assertCloudflaredAvailable();
  const cloudflareProcess = startCloudflared();
  children.push(cloudflareProcess);
  try {
    return await waitForCloudflarePublicUrl(cloudflareProcess);
  } catch (error) {
    stopChild(cloudflareProcess);
    throw error;
  }
}

async function startNgrokTunnelOrThrow(staticNgrokUrl) {
  assertNgrokAvailable();

  if (KILL_EXISTING_NGROK) {
    spawnSync('pkill', ['-f', 'ngrok http'], { stdio: 'ignore' });
  }

  const ngrokProcess = startNgrok(staticNgrokUrl);
  children.push(ngrokProcess);
  try {
    return await waitForNgrokPublicUrl(staticNgrokUrl, ngrokProcess);
  } catch (error) {
    stopChild(ngrokProcess);
    throw error;
  }
}

function resolveStaticNgrokUrl() {
  const domain = normalizeNgrokDomain(process.env.NGROK_DOMAIN || process.env.NGROK_STATIC_DOMAIN);
  if (domain) return `https://${domain}`;

  // Safety: PUBLIC_APP_BASE_URL may be stale, random, local, or a placeholder. Do not pass it
  // to ngrok as --url unless the operator explicitly opts in.
  if (isTruthy(process.env.PANCAKE_USE_PUBLIC_APP_BASE_URL_FOR_NGROK)) {
    const explicit = normalizeBaseUrl(process.env.PUBLIC_APP_BASE_URL);
    if (explicit && !isLocalUrl(explicit) && !isInvalidStaticNgrokUrl(explicit)) return explicit;
  }

  return '';
}

function normalizeNgrokDomain(value) {
  const domain = String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  if (!domain || domain === 'ngrok-free.app' || domain === 'your-static-domain.ngrok-free.app') return '';
  return domain;
}

function startCloudflared() {
  const args = ['tunnel', '--protocol', CLOUDFLARE_PROTOCOL, '--url', `http://localhost:${WEB_PORT}`];
  console.log(`[dev:mobile] Spawning cloudflared: ${formatSpawnCommand(CLOUDFLARED_COMMAND, args)}`);
  const child = spawn(CLOUDFLARED_COMMAND, args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.recentOutput = [];
  child.exitStatus = null;
  child.connectorRegistered = false;
  child.protocolMismatch = null;
  child.publicUrl = '';

  prefixStream(child.stdout, 'cloudflared', line => recordCloudflaredOutput(child, line));
  prefixStream(child.stderr, 'cloudflared', line => recordCloudflaredOutput(child, line));

  child.on('error', error => {
    console.error(`[cloudflared] ${error.message}`);
    console.error('[cloudflared] Install Cloudflare Tunnel with: brew install cloudflared');
    console.error('[cloudflared] Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot');
  });
  child.on('exit', (code, signal) => {
    child.exitStatus = { code, signal };
  });

  return child;
}

function startNgrok(staticUrl) {
  const args = ['http'];
  if (staticUrl) args.push(`--url=${staticUrl}`);
  args.push(WEB_PORT);
  args.push('--log=stdout');

  const child = spawn('ngrok', args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.recentOutput = [];
  child.exitStatus = null;

  prefixStream(child.stdout, 'ngrok', line => recordNgrokOutput(child, line));
  prefixStream(child.stderr, 'ngrok', line => recordNgrokOutput(child, line));

  child.on('error', error => {
    console.error(`[ngrok] ${error.message}`);
    console.error('[ngrok] Install/auth ngrok or set PANCAKE_DISABLE_NGROK=true for local-only mode.');
    console.error('[ngrok] Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot');
  });
  child.on('exit', (code, signal) => {
    child.exitStatus = { code, signal };
  });

  return child;
}

function assertCloudflaredAvailable() {
  const result = spawnSync(CLOUDFLARED_COMMAND, ['--version'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'ignore',
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error('cloudflared is not installed or is not on PATH. Install with: brew install cloudflared. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot');
  }

  if (result.error) {
    throw new Error(`cloudflared could not be started: ${result.error.message}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
  }
}

function assertNgrokAvailable() {
  const result = spawnSync('ngrok', ['version'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'ignore',
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error('ngrok is not installed or is not on PATH. Install/auth ngrok. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot');
  }

  if (result.error) {
    throw new Error(`ngrok could not be started: ${result.error.message}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
  }
}

async function waitForCloudflarePublicUrl(cloudflareProcess) {
  const deadline = Date.now() + 45000;
  let lastProbe = null;

  while (Date.now() < deadline) {
    if (cloudflareProcess?.protocolMismatch) {
      throw new Error(`${cloudflareProcess.protocolMismatch}${formatTunnelDiagnostics('cloudflared', cloudflareProcess)}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
    }
    const publicUrl = normalizeBaseUrl(cloudflareProcess?.publicUrl);
    if (publicUrl && cloudflareProcess?.connectorRegistered) return publicUrl;
    if (publicUrl) {
      lastProbe = await probePublicUrl(publicUrl);
      if (lastProbe.ok) return publicUrl;
    }
    if (cloudflareProcess?.exitStatus) {
      throw new Error(`cloudflared exited before exposing a public URL${formatTunnelDiagnostics('cloudflared', cloudflareProcess)}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
    }
    await delay(publicUrl ? 1000 : 250);
  }

  const publicUrl = normalizeBaseUrl(cloudflareProcess?.publicUrl);
  if (publicUrl) {
    throw new Error([
      `Cloudflare URL was created (${publicUrl}), but Cloudflare could not find a healthy cloudflared connector within 45 seconds`,
      'likely network/DNS/VPN/proxy/firewall/UDP issue',
      `last public probe: ${formatProbeResult(lastProbe)}`,
      `try: PANCAKE_CLOUDFLARE_PROTOCOL=http2 PANCAKE_TUNNEL_PROVIDER=cloudflare ./bin/pancakerobot`,
      `fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot${formatTunnelDiagnostics('cloudflared', cloudflareProcess)}`,
    ].join('. '));
  }

  throw new Error(`cloudflared did not expose a trycloudflare URL within 45 seconds${formatTunnelDiagnostics('cloudflared', cloudflareProcess)}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
}

async function probePublicUrl(publicUrl) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(publicUrl, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      const body = method === 'GET' ? await response.text().catch(() => '') : '';
      if (isCloudflare1033(response, body)) {
        return { ok: false, status: response.status, cloudflare1033: true };
      }
      if (response.status < 500) return { ok: true, status: response.status };
      if (method === 'GET') return { ok: false, status: response.status };
    } catch (error) {
      if (method === 'GET') return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: 'probe failed' };
}

async function waitForNgrokPublicUrl(preferredUrl, ngrokProcess) {
  const preferred = normalizeBaseUrl(preferredUrl);
  const deadline = Date.now() + 15000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (ngrokProcess?.exitStatus) {
      throw new Error(`ngrok exited before exposing a public URL${formatTunnelDiagnostics('ngrok', ngrokProcess)}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
    }

    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      const data = await response.json();
      const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
      const httpsTunnel = tunnels.find(tunnel => tunnel.proto === 'https' && tunnel.public_url);
      if (httpsTunnel?.public_url) return normalizeBaseUrl(httpsTunnel.public_url);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  if (preferred) return preferred;
  throw new Error(`ngrok did not expose a public URL within 15 seconds${formatTunnelDiagnostics('ngrok', ngrokProcess) || (lastError ? `: ${lastError.message}` : '')}. Local-only fallback: PANCAKE_DISABLE_NGROK=true ./bin/pancakerobot`);
}

function startNpmScript(scriptName, env) {
  const child = spawn('npm', ['run', scriptName], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, scriptName);
  prefixStream(child.stderr, scriptName);

  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      if (scriptName === 'telegram') {
        console.error('[telegram] Telegram polling stopped. If another Pancake Robot or bot process is running, stop that process before starting this stack.');
      }
      console.error(`[${scriptName}] exited with code ${code}`);
    }
    if (signal) console.error(`[${scriptName}] exited from signal ${signal}`);
  });

  return child;
}

function startCaffeinate() {
  if (process.platform !== 'darwin') return null;
  const child = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {
    stdio: 'ignore',
  });
  child.on('error', () => {});
  return child;
}

function prefixStream(stream, label, onLine) {
  stream.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        const output = onLine ? onLine(trimmed) : line;
        if (output === false) continue;
        console.log(`[${label}] ${typeof output === 'string' ? output : line}`);
      }
    }
  });
}

function recordCloudflaredOutput(child, line) {
  const publicUrl = extractTryCloudflareUrl(line);
  if (publicUrl) child.publicUrl = publicUrl;
  if (isCloudflareConnectionRegistrationLine(line)) child.connectorRegistered = true;
  const observedProtocol = extractCloudflaredProtocol(line);
  if (observedProtocol && CLOUDFLARE_PROTOCOL !== 'auto' && observedProtocol !== CLOUDFLARE_PROTOCOL) {
    child.protocolMismatch = `cloudflared started with protocol ${observedProtocol}, but PANCAKE_CLOUDFLARE_PROTOCOL requested ${CLOUDFLARE_PROTOCOL}`;
    console.error(`[cloudflared] ${child.protocolMismatch}`);
    stopChild(child);
  }
  recordTunnelOutput(child, line);
  return sanitizeLogLine(line);
}

function recordNgrokOutput(child, line) {
  if (line.includes('pg=/api/tunnels')) return false;
  recordTunnelOutput(child, line);
  return sanitizeLogLine(line);
}

function recordTunnelOutput(child, line) {
  child.recentOutput.push(sanitizeLogLine(line));
  if (child.recentOutput.length > 8) child.recentOutput.shift();
}

function formatTunnelDiagnostics(label, child) {
  const details = [];
  if (child?.exitStatus) {
    const { code, signal } = child.exitStatus;
    details.push(`exit=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`);
  }
  if (child?.recentOutput?.length) details.push(`recent ${label} output: ${child.recentOutput.join(' | ')}`);
  return details.length ? `: ${details.join('; ')}` : '';
}

function extractTryCloudflareUrl(line) {
  const match = String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? normalizeBaseUrl(match[0]) : '';
}

function isCloudflareConnectionRegistrationLine(line) {
  const normalized = String(line || '').toLowerCase();
  return (
    normalized.includes('registered tunnel connection') ||
    normalized.includes('connection registered') ||
    normalized.includes('connection established') ||
    (normalized.includes('connindex=') && normalized.includes('connection') && normalized.includes('registered'))
  );
}

function extractCloudflaredProtocol(line) {
  const text = String(line || '');
  const settingsMatch = text.match(/\bprotocol:([a-z0-9-]+)/i);
  if (settingsMatch) return settingsMatch[1].toLowerCase();

  const initialMatch = text.match(/\bInitial protocol\s+([a-z0-9-]+)/i);
  if (initialMatch) return initialMatch[1].toLowerCase();

  return '';
}

function isCloudflare1033(response, body) {
  return response.status === 530 && /error\s*1033|cloudflare tunnel error/i.test(String(body || ''));
}

function formatProbeResult(result) {
  if (!result) return 'none';
  if (result.cloudflare1033) return `Cloudflare 1033 (status ${result.status})`;
  if (result.status) return `HTTP ${result.status}`;
  return result.error || 'unknown failure';
}

function commandExists(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'ignore',
  });
  return !result.error;
}

function findCommand(command, args, fallbacks) {
  if (commandExists(command, args)) return command;
  for (const fallback of fallbacks) {
    if (commandExists(fallback, args)) return fallback;
  }
  return command;
}

function sanitizeLogLine(line) {
  return String(line || '')
    .replace(/(authtoken=)[^\s]+/gi, '$1[redacted]')
    .replace(/(token=)[^\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]');
}

function formatSpawnCommand(command, args) {
  return [command, ...args].map(part => quoteShellArg(sanitizeLogLine(part))).join(' ');
}

function quoteShellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalUrl(value) {
  const normalized = normalizeBaseUrl(value).toLowerCase();
  return normalized.startsWith('http://localhost') || normalized.startsWith('https://localhost') || normalized.startsWith('http://127.0.0.1') || normalized.startsWith('https://127.0.0.1');
}

function isInvalidStaticNgrokUrl(value) {
  const normalized = normalizeBaseUrl(value).toLowerCase();
  return normalized === 'https://ngrok-free.app' || normalized === 'https://your-static-domain.ngrok-free.app';
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopChild(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

function shutdown(code) {
  for (const child of children.reverse()) {
    stopChild(child);
  }
  setTimeout(() => process.exit(code), 250);
}
