/**
 * AI Marketing & Sales Agent — Backend Server
 * Accounting Firm Edition
 *
 * Stack: Node.js + Express + Anthropic SDK
 * Run:   node server.js
 */

require('dotenv').config();          // loads .env file when running locally

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

// ── Config ─────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const API_KEY      = process.env.ANTHROPIC_API_KEY;
const LEADS_FILE   = path.join(__dirname, 'leads.json');
const CALENDLY_URL = 'https://calendly.com/asante-spectrumfinancialsolution/30min';
const FIRM_NAME    = 'Spectrum Financial Solutions';
const NOTIFY_EMAIL = 'snt.milla@gmail.com';

// ── Email setup ────────────────────────────────────────────────────────────
const mailer = process.env.GMAIL_APP_PASSWORD ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: NOTIFY_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
}) : null;

async function sendLeadNotification(lead) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: `"${FIRM_NAME} Agent" <${NOTIFY_EMAIL}>`,
      to: NOTIFY_EMAIL,
      subject: `🔔 New Lead: ${lead.name} — ${lead.service}`,
      html: `
        <h2>New lead captured on your website</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
          <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${lead.name}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;"><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${lead.phone || '—'}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:6px 12px;font-weight:bold;">Service</td><td style="padding:6px 12px;">${lead.service}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;">Notes</td><td style="padding:6px 12px;">${lead.notes || '—'}</td></tr>
        </table>
        <p style="margin-top:16px;font-size:13px;color:#64748b;">Captured at ${new Date().toLocaleString()}</p>
      `,
    });
    console.log(`[Email] Notification sent for ${lead.name}`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

// ── HubSpot helper ─────────────────────────────────────────────────────────
const https = require('https');

function hubspotRequest(method, hsPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: hsPath,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncChatLeadToHubSpot(lead) {
  if (!process.env.HUBSPOT_API_KEY) return;
  try {
    const nameParts = (lead.name || '').split(' ');
    const props = {
      email:          lead.email,
      firstname:      nameParts[0] || '',
      lastname:       nameParts.slice(1).join(' ') || '',
      phone:          lead.phone || '',
      hs_lead_status: 'NEW',
      lifecyclestage: 'lead',
    };
    const search = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] }],
    });
    if (search.body.total > 0) {
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${search.body.results[0].id}`, { properties: props });
    } else {
      await hubspotRequest('POST', '/crm/v3/objects/contacts', { properties: props });
    }
    console.log(`[HubSpot] Chat lead synced: ${lead.name} <${lead.email}>`);
  } catch (e) {
    console.error('[HubSpot] Chat sync error:', e.message);
  }
}

async function updateHubSpotContact(email, props) {
  if (!process.env.HUBSPOT_API_KEY || !email) return;
  try {
    const search = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    });
    if (search.body.total > 0) {
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${search.body.results[0].id}`, { properties: props });
    }
  } catch (e) {
    console.error('[HubSpot] Update error:', e.message);
  }
}

// ── Anthropic client ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: API_KEY });

// ── In-memory conversation store (keyed by sessionId) ──────────────────────
const sessions = {};  // { [sessionId]: { messages: [], lead: {} } }

// ── System prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a friendly, professional AI sales assistant for Spectrum Financial Solutions, a CPA & financial advisory firm.
Your job is to:
1. Warmly greet visitors and understand their needs
2. Answer questions about the firm's services
3. Qualify leads by naturally gathering: name, email, phone, business type, company size, and which service(s) they need
4. Encourage prospects to book a free consultation

## Services offered
- **Tax preparation & filing** — personal and business tax returns, tax planning, IRS representation
- **Bookkeeping** — monthly reconciliation, financial statements, accounts payable/receivable
- **CFO / Advisory services** — cash flow forecasting, budgeting, strategic financial guidance
- **Payroll & compliance** — payroll processing, W-2s/1099s, payroll tax filings

## Tone & style
- Warm, confident, and professional — not salesy or pushy
- Keep replies concise (2–4 short paragraphs max)
- Use plain English, avoid jargon
- If someone asks about pricing, say "pricing depends on your specific needs — our team will give you an exact quote during your free consultation"

## Lead qualification
Gather this information naturally over the conversation (never ask all at once):
- First and last name
- Email address
- Phone number (optional)
- Are they a business or individual?
- If business: industry and number of employees
- Which service(s) are they interested in?
- Current pain point or urgency

## Booking a consultation
Once you have name + email + service interest, offer to book a free 30-minute consultation.
When the user agrees to book, respond with a JSON block (the frontend will extract it):

CALENDLY_TRIGGER:{"url":"${CALENDLY_URL}"}

## Lead capture signal
Once you have gathered name + email + at least one service interest, output this JSON on a new line (invisible to user, parsed by server):

LEAD_CAPTURED:{"name":"...", "email":"...", "phone":"...", "service":"...", "notes":"..."}

## Suggested quick replies
When it makes sense, end your message with:

QUICK_REPLIES:["option 1","option 2","option 3"]

Keep quick replies to 2–4 short options.

## Never do
- Never make up specific pricing numbers
- Never promise specific tax savings or refunds
- Never collect credit card or SSN information
- Never disparage competitors
`;

// ── Lead helpers ────────────────────────────────────────────────────────────
function loadLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return []; }
}

function saveLead(lead) {
  const leads = loadLeads();
  const existing = leads.findIndex(l => l.email === lead.email);
  const record = {
    ...lead,
    id: existing >= 0 ? leads[existing].id : Date.now().toString(),
    capturedAt: existing >= 0 ? leads[existing].capturedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (existing >= 0) leads[existing] = record;
  else leads.push(record);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  console.log(`[Lead] Saved: ${record.name} <${record.email}>`);
  return record;
}

// ── Parse assistant output ─────────────────────────────────────────────────
function parseAssistantMessage(raw) {
  let reply        = raw;
  let quickReplies = [];
  let calendlyUrl  = null;
  let leadData     = null;

  // Extract LEAD_CAPTURED
  const leadMatch = reply.match(/LEAD_CAPTURED:(\{[^\n]+\})/);
  if (leadMatch) {
    try { leadData = JSON.parse(leadMatch[1]); } catch {}
    reply = reply.replace(/LEAD_CAPTURED:[^\n]+\n?/, '').trim();
  }

  // Extract CALENDLY_TRIGGER
  const calMatch = reply.match(/CALENDLY_TRIGGER:(\{[^\n]+\})/);
  if (calMatch) {
    try { calendlyUrl = JSON.parse(calMatch[1]).url; } catch {}
    reply = reply.replace(/CALENDLY_TRIGGER:[^\n]+\n?/, '').trim();
    // Also append the booking link as text so it works on all embed versions
    if (calendlyUrl) {
      reply += `\n\n📅 Book your free 30-minute consultation here:\n${calendlyUrl}`;
    }
  }

  // Extract QUICK_REPLIES
  const qrMatch = reply.match(/QUICK_REPLIES:(\[[^\]]+\])/);
  if (qrMatch) {
    try { quickReplies = JSON.parse(qrMatch[1]); } catch {}
    reply = reply.replace(/QUICK_REPLIES:[^\n]+\n?/, '').trim();
  }

  return { reply, quickReplies, calendlyUrl, leadData };
}

// ── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));  // serves dashboard.html

// POST /chat — main chat endpoint
app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message?.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  // Init session
  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], lead: {} };
  }
  const session = sessions[sessionId];

  // Append user message
  session.messages.push({ role: 'user', content: message.trim() });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: session.messages,
    });

    const raw = response.content[0].text;
    const { reply, quickReplies, calendlyUrl, leadData } = parseAssistantMessage(raw);

    // Store clean assistant reply in history
    session.messages.push({ role: 'assistant', content: reply });

    // Save lead if captured
    if (leadData?.email) {
      session.lead = { ...session.lead, ...leadData };
      const saved = saveLead(session.lead);
      sendLeadNotification(saved);
      syncChatLeadToHubSpot(saved);
    }

    res.json({ reply, quickReplies, calendlyUrl });

  } catch (err) {
    console.error('[API Error]', err.message);
    res.status(500).json({ error: 'AI service error', reply: "I'm having trouble right now. Please try again shortly." });
  }
});

// GET /leads — return all leads (basic auth recommended for production)
app.get('/leads', (req, res) => {
  res.json(loadLeads());
});

// GET /outbound-leads — return all outbound (proactively found) leads
app.get('/outbound-leads', (req, res) => {
  const file = path.join(__dirname, 'outbound-leads.json');
  if (!fs.existsSync(file)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { res.json([]); }
});

// POST /outbound-leads/sync — receive leads from local agent run and merge into server store
app.post('/outbound-leads/sync', (req, res) => {
  const syncKey = process.env.SYNC_SECRET || 'spectrum-sync';
  if (req.headers['x-sync-key'] !== syncKey) return res.status(401).json({ error: 'Unauthorized' });
  const incoming = Array.isArray(req.body) ? req.body : [];
  if (!incoming.length) return res.json({ merged: 0, total: 0 });
  const file = path.join(__dirname, 'outbound-leads.json');
  let leads = [];
  if (fs.existsSync(file)) { try { leads = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  let merged = 0;
  for (const lead of incoming) {
    const key = lead.email || lead.id || lead.placeId;
    const idx = key ? leads.findIndex(l => (l.email && l.email === lead.email) || (l.id && l.id === lead.id) || (l.placeId && l.placeId === lead.placeId)) : -1;
    if (idx >= 0) {
      const existing = leads[idx];
      // Agent data wins for most fields; preserve server-side tracking (replies, opens, clicks)
      leads[idx] = {
        ...existing,
        ...lead,
        repliedAt: existing.repliedAt || lead.repliedAt,
        openedAt: existing.openedAt || lead.openedAt,
        clickedAt: existing.clickedAt || lead.clickedAt,
        updatedAt: new Date().toISOString(),
      };
    } else {
      leads.push(lead);
      merged++;
    }
  }
  fs.writeFileSync(file, JSON.stringify(leads, null, 2));
  console.log(`[Sync] Merged ${merged} new leads, total ${leads.length}`);
  res.json({ merged, total: leads.length });
});

// GET /calls — proxy Vapi call logs
app.get('/calls', async (req, res) => {
  const vapiKey = process.env.VAPI_API_KEY;
  if (!vapiKey) return res.status(500).json({ error: 'VAPI_API_KEY not set' });
  try {
    const https = require('https');
    const limit = req.query.limit || 100;
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.vapi.ai',
        path: `/call?limit=${limit}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${vapiKey}` },
      };
      const request = https.request(options, (r) => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
      });
      request.on('error', reject);
      request.end();
    });
    res.json(data);
  } catch (err) {
    console.error('[Vapi] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /outbound-leads/:id/reply — mark a lead as replied
app.patch('/outbound-leads/:id/reply', (req, res) => {
  const file = path.join(__dirname, 'outbound-leads.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No leads file' });
  try {
    const leads = JSON.parse(fs.readFileSync(file, 'utf8'));
    const idx = leads.findIndex(l => l.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Lead not found' });
    leads[idx] = { ...leads[idx], replied: true, repliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(leads, null, 2));
    if (leads[idx].email) updateHubSpotContact(leads[idx].email, { hs_lead_status: 'CONNECTED', lifecyclestage: 'opportunity' });
    console.log(`[Reply] Marked ${leads[idx].name || leads[idx].email} as replied`);
    res.json(leads[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /outbound-leads/:id/unreply — undo a replied marking
app.patch('/outbound-leads/:id/unreply', (req, res) => {
  const file = path.join(__dirname, 'outbound-leads.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No leads file' });
  try {
    const leads = JSON.parse(fs.readFileSync(file, 'utf8'));
    const idx = leads.findIndex(l => l.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Lead not found' });
    leads[idx] = { ...leads[idx], replied: false, repliedAt: null, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(leads, null, 2));
    if (leads[idx].email) updateHubSpotContact(leads[idx].email, { hs_lead_status: 'IN_PROGRESS', lifecyclestage: 'lead' });
    console.log(`[Reply] Undid replied for ${leads[idx].name || leads[idx].email}`);
    res.json(leads[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /webhook/resend — email open/click tracking from Resend
app.post('/webhook/resend', express.raw({ type: '*/*' }), (req, res) => {
  res.json({ ok: true }); // always ACK immediately
  try {
    const event = JSON.parse(req.body.toString());
    const type   = event.type || '';
    const tags   = event.data?.tags || [];
    const leadId = tags.find(t => t.name === 'lead_id')?.value;
    if (!leadId) return;

    const file = path.join(__dirname, 'outbound-leads.json');
    if (!fs.existsSync(file)) return;
    const leads = JSON.parse(fs.readFileSync(file, 'utf8'));
    const idx = leads.findIndex(l => l.id === leadId);
    if (idx < 0) return;

    if (type === 'email.opened') {
      leads[idx].openedAt   = leads[idx].openedAt || new Date().toISOString();
      leads[idx].openCount  = (leads[idx].openCount || 0) + 1;
      if (leads[idx].email) updateHubSpotContact(leads[idx].email, { hs_lead_status: 'OPEN' });
    } else if (type === 'email.clicked') {
      leads[idx].clickedAt  = leads[idx].clickedAt || new Date().toISOString();
      leads[idx].clicked    = true;
      if (leads[idx].email) updateHubSpotContact(leads[idx].email, { hs_lead_status: 'IN_PROGRESS' });
    }
    leads[idx].updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(leads, null, 2));
    console.log(`[Webhook] ${type} — lead ${leadId} (opens: ${leads[idx].openCount || 0})`);
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
  }
});

// GET /hubspot-contacts — fetch contacts + deals from HubSpot
app.get('/hubspot-contacts', async (req, res) => {
  if (!process.env.HUBSPOT_API_KEY) return res.json({ contacts: [], deals: [], _debug: 'no_api_key' });
  try {
    const [contactsRes, dealsRes] = await Promise.all([
      hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [],
        properties: ['email','firstname','lastname','company','phone','hs_lead_status','lifecyclestage','createdate','lastmodifieddate'],
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
      }),
      hubspotRequest('POST', '/crm/v3/objects/deals/search', {
        filterGroups: [],
        properties: ['dealname','dealstage','amount','closedate','createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 100,
      }),
    ]);
    console.log('[HubSpot] contacts status:', contactsRes.status, 'total:', contactsRes.body.total);
    console.log('[HubSpot] deals status:', dealsRes.status, 'total:', dealsRes.body.total);
    const contacts = (contactsRes.body.results || []).map(r => ({ id: r.id, ...r.properties }));
    const deals    = (dealsRes.body.results || []).map(r => ({ id: r.id, ...r.properties }));
    res.json({ contacts, deals, _debug: { contactsStatus: contactsRes.status, dealsStatus: dealsRes.status, contactsTotal: contactsRes.body.total, dealsTotal: dealsRes.body.total } });
  } catch (e) {
    console.error('[HubSpot] Fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /leads/export.csv — CSV export
app.get('/leads/export.csv', (req, res) => {
  const leads = loadLeads();
  const headers = ['id','name','email','phone','service','notes','capturedAt','updatedAt'];
  const rows = leads.map(l => headers.map(h => JSON.stringify(l[h] ?? '')).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Accounting Firm AI Agent running on http://localhost:${PORT}`);
  console.log(`   Chat endpoint : POST http://localhost:${PORT}/chat`);
  console.log(`   Leads JSON    : GET  http://localhost:${PORT}/leads`);
  console.log(`   Leads CSV     : GET  http://localhost:${PORT}/leads/export.csv`);
  console.log(`   Dashboard     : GET  http://localhost:${PORT}/dashboard.html\n`);
});
