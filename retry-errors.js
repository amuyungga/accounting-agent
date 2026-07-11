/**
 * retry-errors.js
 * Re-attempts cold email sending for leads that previously errored.
 * Run with: node retry-errors.js
 *
 * Only retries leads where:
 *   - status === 'error'
 *   - email is present (can't send without one)
 *   - error was API/send related (not permanent failures like 'no_website')
 */

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN || '';
const LEADS_FILE        = path.join(__dirname, 'outbound-leads.json');

const FIRM_NAME    = 'Spectrum Financial Solutions';
const OWNER_NAME   = 'Asante';
const FROM_EMAIL   = 'outbound@spectrumfinancialsolution.com';
const REPLY_TO     = 'asante@spectrumfinancialsolution.com';
const CALENDLY_URL = 'https://calendly.com/asante-spectrumfinancialsolution/30min';
const EMAIL_DELAY  = 12000; // 12s between sends

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── GitHub helpers ───────────────────────────────────────────────────────────
async function fetchLeadsFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/repos/amuyungga/accounting-agent/contents/outbound-leads.json',
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Spectrum-Retry/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const { content, sha } = JSON.parse(body);
          const leads = JSON.parse(Buffer.from(content, 'base64').toString('utf8').replace(/\0/g, ''));
          resolve({ leads, sha });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function pushLeadsToGitHub(leads, sha) {
  if (!GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify(leads, null, 2)).toString('base64');
  const payload = JSON.stringify({ message: `retry: ${leads.filter(l=>l.status==='emailed').length} emailed after error retry`, content, sha });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/amuyungga/accounting-agent/contents/outbound-leads.json',
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Spectrum-Retry/1.0', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.commit?.sha) {
            console.log(`\n✅ Leads pushed to GitHub (commit ${j.commit.sha.slice(0,7)})`);
            resolve(j.content?.sha); // return new SHA for next push
          } else {
            console.log('⚠️  GitHub push response:', JSON.stringify(j).slice(0, 200));
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', e => { console.log('GitHub push error:', e.message); resolve(null); });
    req.write(payload); req.end();
  });
}

// ── Email generation ─────────────────────────────────────────────────────────
async function generateColdEmail(lead) {
  const prompt = `Write a brief, warm cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} (a CPA & financial advisory firm) to the owner/manager of "${lead.name}" — a ${lead.industry} in ${lead.city || lead.address}.

Rules:
- First line must be: Subject: <personalized subject — MUST include their business name OR industry AND city>
- 3 short paragraphs max, conversational tone, NOT salesy or generic
- Mention their industry (${lead.industry}) and a relevant financial pain point
- Offer a FREE 30-minute consultation: ${CALENDLY_URL}
- Sign off as: ${OWNER_NAME}, CPA | ${FIRM_NAME}
- Write ONLY the email body. No preamble, no sign-off.`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 30000,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.content[0].text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ── Email sending ────────────────────────────────────────────────────────────
async function sendEmail(lead, emailContent) {
  const lines = emailContent.split('\n');
  const subjectLine = lines.find(l => /^subject:/i.test(l));
  const subject = (subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : `A quick note for ${lead.name}`).replace(/\*\*/g, '');
  const rawBody = lines.filter(l => !/^subject:/i.test(l)).join('\n').trim().replace(/\*\*/g, '');

  const sigText = `\n\n--\nAsante Muyungga, CPA\nFounder and CEO | Spectrum Financial Solutions\nasante@spectrumfinancialsolution.com\nspectrumfinancialsolution.com\nSchedule a free 30-min call: ${CALENDLY_URL}`;
  const sigHtml = `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
<table style="font-family:Arial,sans-serif;font-size:13px;color:#475569">
  <tr><td style="padding-bottom:10px"><strong style="font-size:14px;color:#1e293b">Asante Muyungga, CPA</strong></td></tr>
  <tr><td>Founder and CEO | Spectrum Financial Solutions</td></tr>
  <tr><td style="padding-top:4px"><a href="mailto:${REPLY_TO}" style="color:#3b82f6">${REPLY_TO}</a></td></tr>
  <tr><td style="padding-top:6px"><a href="${CALENDLY_URL}" style="background:#3b82f6;color:#fff;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:12px">📅 Schedule a Free Consultation</a></td></tr>
</table>`;

  const body = rawBody + sigText;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:600px;margin:0 auto"><p>${rawBody.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</p>${sigHtml}</div>`;

  const payload = JSON.stringify({
    from: `${OWNER_NAME} | ${FIRM_NAME} <${FROM_EMAIL}>`,
    to: [lead.email],
    reply_to: REPLY_TO,
    bcc: ['snt.milla@gmail.com'],
    subject,
    text: body,
    html,
    tags: [
      { name: 'lead_id', value: (lead.id || 'unknown').slice(0, 50) },
      { name: 'type',    value: 'cold_outreach_retry' },
    ],
    headers: {
      'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=Unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Mailer': 'Spectrum-Retry/1.0',
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(subject);
        else reject(new Error(`Resend ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Spectrum Error Retry Script\n');

  if (!ANTHROPIC_API_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1); }
  if (!RESEND_API_KEY)    { console.error('❌ Missing RESEND_API_KEY');    process.exit(1); }

  // Load leads — prefer GitHub (latest), fall back to local file
  let leads, sha;
  console.log('📥 Loading leads from GitHub...');
  const ghResult = await fetchLeadsFromGitHub();
  if (ghResult) {
    ({ leads, sha } = ghResult);
    console.log(`   Got ${leads.length} leads from GitHub\n`);
    // Also update local file
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  } else {
    console.log('   GitHub unavailable — using local file');
    leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  }

  // Find retryable leads: status=error AND has an email
  const retryable = leads.filter(l =>
    l.status === 'error' &&
    l.email &&
    !l.email.includes('press@google') // skip Google's generic email
  );

  console.log(`📋 Found ${retryable.length} error leads with emails to retry`);
  console.log(`   (${leads.filter(l=>l.status==='error' && !l.email).length} error leads skipped — no email)\n`);

  if (retryable.length === 0) {
    console.log('✅ Nothing to retry. All done!');
    return;
  }

  let sent = 0, failed = 0;

  for (let i = 0; i < retryable.length; i++) {
    const lead = retryable[i];
    const idx  = leads.findIndex(l => l.id === lead.id);
    console.log(`[${i+1}/${retryable.length}] ${lead.name} (${lead.city}) → ${lead.email}`);

    try {
      // Generate email
      const emailContent = await generateColdEmail(lead);
      // Send it
      const subject = await sendEmail(lead, emailContent);
      // Update lead
      leads[idx].status    = 'emailed';
      leads[idx].emailedAt = new Date().toISOString();
      leads[idx].error     = undefined;
      leads[idx].emailSubject = subject;
      sent++;
      console.log(`   ✅ Sent — "${subject}"`);
    } catch (err) {
      leads[idx].error = err.message;
      failed++;
      console.log(`   ❌ Failed — ${err.message.slice(0, 80)}`);
    }

    // Save locally after every lead
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));

    // Push to GitHub every 10 leads (or last lead)
    if (sha && ((i + 1) % 10 === 0 || i === retryable.length - 1)) {
      const newSha = await pushLeadsToGitHub(leads, sha);
      if (newSha) sha = newSha;
    }

    // Rate limit between emails
    if (i < retryable.length - 1) {
      process.stdout.write(`   ⏳ Waiting ${EMAIL_DELAY/1000}s...\r`);
      await sleep(EMAIL_DELAY);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Done! Sent: ${sent}  |  Failed: ${failed}  |  Total: ${retryable.length}`);
  console.log(`📊 Dashboard: https://accounting-agent-production-cf69.up.railway.app/dashboard.html`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
