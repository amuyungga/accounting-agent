/**
 * command-watcher.js
 * Runs in the background and polls Railway every 5 seconds for pending dashboard commands.
 * When a command is found, it spawns outbound-agent.js --run-commands to execute it immediately.
 * Start with: watch-commands.bat
 */

const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

const RAILWAY = 'accounting-agent-production-cf69.up.railway.app';
const POLL_INTERVAL = 5000; // 5 seconds
let agentRunning = false;

function fetchPendingCommands() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: RAILWAY,
      path: '/api/commands',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const cmds = JSON.parse(d);
          resolve(Array.isArray(cmds) ? cmds.filter(c => c.status === 'pending') : []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function check() {
  if (agentRunning) return; // Don't stack runs

  let pending;
  try { pending = await fetchPendingCommands(); }
  catch { return; }

  if (!pending.length) return;

  console.log(`\n[${ts()}] ⌘ ${pending.length} command(s) pending — launching agent...`);
  pending.forEach(c => console.log(`  → ${c.type}: ${c.label}`));

  agentRunning = true;
  const child = spawn('node', [path.join(__dirname, 'outbound-agent.js'), '--run-commands'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: process.env,
  });

  child.on('error', (e) => {
    console.error(`[${ts()}] ❌ Failed to start agent:`, e.message);
    agentRunning = false;
  });

  child.on('close', (code) => {
    console.log(`[${ts()}] ✅ Agent finished (exit ${code ?? 0})`);
    agentRunning = false;
  });
}

console.log('');
console.log('╔════════════════════════════════════════════════╗');
console.log('║  ⌘  Spectrum Agent — Command Watcher           ║');
console.log('║  Polling Railway every 5s for new commands      ║');
console.log('║  Press Ctrl+C to stop                          ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('');
console.log('Dashboard: https://accounting-agent-production-cf69.up.railway.app/dashboard.html');
console.log('Click "⌘ Commands" → queue a command → it runs within 5 seconds.');
console.log('');

// Start polling
setInterval(check, POLL_INTERVAL);
check(); // Immediate first check
