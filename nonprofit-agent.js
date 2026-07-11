#!/usr/bin/env node
'use strict';
/**
 * Nonprofit / FQHC Lead Search Agent
 * Targets: FQHCs and nonprofits seeking fractional CFO / accounting services
 * Sources: ProPublica Nonprofit Explorer · HRSA Health Center Finder · Indeed Jobs
 * States:  CA, AZ, WA, UT, TX, MO, MT, NM, ND, SD
 *
 * Run manually : node nonprofit-agent.js
 * Or triggered : GitHub Actions workflow_dispatch (via dashboard button)
 */
require('dotenv').config();
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Config ─────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY || null;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const FIRM_NAME         = 'Spectrum Financial Solutions';
const OWNER_NAME        = 'Asante';
const CALENDLY_URL      = 'https://calendly.com/asante-spectrumfinancialsolution/30min';
const LEADS_FILE        = path.join(__dirname, 'outbound-leads.json');
const EMAIL_DELAY_MS    = 3500;
const DAILY_EMAIL_CAP   = 80; // leave headroom for main agent

if (!ANTHROPIC_API_KEY) { console.error('[Error] ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!RESEND_API_KEY)    { console.warn('[Warn] RESEND_API_KEY not set — emails will be logged only (dry-run mode)'); }

const TARGET_STATES = [
  { id: 'CA', name: 'California' },
  { id: 'AZ', name: 'Arizona' },
  { id: 'WA', name: 'Washington' },
  { id: 'UT', name: 'Utah' },
  { id: 'TX', name: 'Texas' },
  { id: 'MO', name: 'Missouri' },
  { id: 'MT', name: 'Montana' },
  { id: 'NM', name: 'New Mexico' },
  { id: 'ND', name: 'North Dakota' },
  { id: 'SD', name: 'South Dakota' },
];

// ProPublica NTEE (National Taxonomy of Exempt Entities) codes to search
// E = Health General, F = Mental Health, P = Human Services
const NP_QUERIES = ['health center', 'community health', 'federally qualified health', 'human services nonprofit'];

// ── Utilities ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return []; }
}

function saveLead(lead) {
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.id === lead.id);
  if (idx >= 0) leads[idx] = { ...leads[idx], ...lead };
  else leads.push(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function alreadyEmailedAddress(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return loadLeads().some(l =>
    (l.status === 'emailed' || l.status === 'follow_up_sent') &&
    l.email && l.email.toLowerCase() === e
  );
}

function alreadyProcessed(listingKey) {
  // no_website leads get retried — only skip if we already found/emailed/rejected
  const FINAL = new Set(['emailed', 'no_email', 'email_found', 'follow_up_sent', 'replied', 'error']);
  return loadLeads().some(l =>
    (l.listingUrl === listingKey || l.id === listingKey) && FINAL.has(l.status)
  );
}

// ── HTTP fetch ─────────────────────────────────────────────────────────────
function fetchUrl(url, extraHeaders = {}, redirectCount = 0) {
  if (redirectCount > 4) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Bad URL: ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const hardTimer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Hard timeout')); }
    }, 16000);
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
      timeout: 12000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(hardTimer); settled = true;
        const next = new URL(res.headers.location, url).toString();
        return fetchUrl(next, extraHeaders, redirectCount + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 500_000) req.destroy(); });
      res.on('end', () => { clearTimeout(hardTimer); settled = true; resolve(body); });
    });
    req.on('error', err => { clearTimeout(hardTimer); settled = true; reject(err); });
    req.on('timeout', () => { req.destroy(); clearTimeout(hardTimer); settled = true; reject(new Error('Timeout')); });
  });
}

// ── Email extraction ────────────────────────────────────────────────────────
function extractEmails(html, preferDomain) {
  if (!html) return [];
  const all = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []))];
  const junk = ['noreply', 'no-reply', 'donotreply', 'example.com', 'sentry.io',
                 'wixpress', 'squarespace', 'wordpress', 'schema.org', 'w3.org',
                 'googleapis', 'gmpg.org', 'jquery', 'cloudflare'];
  const generic = ['info', 'contact', 'support', 'hello', 'hi', 'mail', 'office',
                   'inquiry', 'inquiries', 'general', 'feedback', 'help', 'team',
                   'webmaster', 'admin', 'marketing', 'press', 'media', 'privacy', 'legal'];
  const personal = ['cfo', 'ceo', 'owner', 'founder', 'president', 'director', 'partner',
                    'manager', 'principal', 'controller', 'finance', 'accounting', 'executive'];

  const score = e => {
    const p = e.split('@')[0].toLowerCase().replace(/[._+].*$/, '');
    if (personal.some(x => p === x || p.startsWith(x))) return 3;
    if (generic.some(x => p === x)) return 1;
    return 2;
  };

  const clean = all.filter(e => !junk.some(j => e.toLowerCase().includes(j)));
  clean.sort((a, b) => score(b) - score(a));
  if (preferDomain) {
    const onDomain = clean.filter(e => e.toLowerCase().includes(preferDomain));
    if (onDomain.length) return onDomain.slice(0, 2);
  }
  return clean.slice(0, 2);
}

async function findEmailOnWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const full = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
    const parsed = new URL(full);
    const domain = parsed.hostname.replace(/^www\./, '');

    const homepage = await fetchUrl(full).catch(() => '');
    let emails = extractEmails(homepage, domain);
    if (emails.length) return emails[0];

    for (const slug of ['/contact', '/contact-us', '/about', '/about-us', '/staff', '/leadership', '/team', '/our-team']) {
      const html = await fetchUrl(`${parsed.origin}${slug}`).catch(() => '');
      emails = extractEmails(html, domain);
      if (emails.length) return emails[0];
    }
    return null;
  } catch {
    return null;
  }
}

// ── Push leads to GitHub ────────────────────────────────────────────────────
async function pushLeadsToGitHub(leads) {
  if (!GITHUB_TOKEN) { console.log('[GitHub] No token — skipping push'); return; }
  return new Promise((resolve) => {
    const getReq = https.request({
      hostname: 'api.github.com',
      path: '/repos/amuyungga/accounting-agent/contents/outbound-leads.json',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nonprofit-agent',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const sha = JSON.parse(body).sha;
          const content = Buffer.from(JSON.stringify(leads, null, 2)).toString('base64');
          const putPayload = JSON.stringify({ message: 'nonprofit-agent: update leads', content, sha });
          const putReq = https.request({
            hostname: 'api.github.com',
            path: '/repos/amuyungga/accounting-agent/contents/outbound-leads.json',
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'nonprofit-agent',
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(putPayload),
            },
          }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { console.log(`[GitHub] Push ${r.statusCode}`); resolve(); }); });
          putReq.on('error', e => { console.log('[GitHub] Push error:', e.message); resolve(); });
          putReq.write(putPayload);
          putReq.end();
        } catch (e) { console.log('[GitHub] SHA error:', e.message); resolve(); }
      });
    });
    getReq.on('error', e => { console.log('[GitHub] Get error:', e.message); resolve(); });
    getReq.end();
  });
}

// ── Generate nonprofit / FQHC cold email ───────────────────────────────────
async function generateNonprofitEmail(org) {
  const isFQHC = org.orgType === 'fqhc';

  const prompt = isFQHC
    ? `Write a brief, warm cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} (a CPA & financial advisory firm) to the CFO or Executive Director of "${org.name}" — a Federally Qualified Health Center (FQHC) in ${org.city || org.state || ''}.

FQHCs have specific financial needs that generalist CPAs don't understand: HRSA UDS reporting, Section 330 grant compliance, federal cost reports, sliding fee scale audits, and 990/A-133 audit preparation. Spectrum Financial Solutions specializes in exactly these areas.

Tone: warm, mission-aware, knowledgeable — not a generic sales pitch. Show you understand the FQHC world.

Rules:
- First line: Subject: <personalized, mentions their health center name or FQHC mission>
- 3–4 short paragraphs
- Mention specific FQHC pain points: grant compliance, HRSA reporting, audit readiness
- End with soft CTA: free 30-min call at ${CALENDLY_URL}
- Do NOT include a sign-off or signature block`
    : `Write a brief, warm cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} (a CPA & financial advisory firm) to the Executive Director or Finance Director of "${org.name}" — a nonprofit organization in ${org.city || org.state || ''}.

Nonprofits in the $1M–$15M revenue range often struggle with: grant financial management and reporting, 990 preparation, board-ready financial statements, audit readiness, and CFO-level strategic planning — but can't afford a full-time CFO.

Tone: warm, mission-aware, practical — not a generic sales pitch.

Rules:
- First line: Subject: <personalized subject for this specific nonprofit>
- 3–4 short paragraphs
- Mention specific nonprofit pain points: 990 filing, grant compliance, audit prep, board reporting
- Position fractional CFO/accounting as the smart alternative to a full-time hire
- End with soft CTA: free 30-min call at ${CALENDLY_URL}
- Do NOT include a sign-off or signature block`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 450,
    messages: [{ role: 'user', content: prompt }],
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
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content[0].text.trim());
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Send email via Resend ───────────────────────────────────────────────────
async function sendEmail(toEmail, emailContent, org) {
  const lines = emailContent.split('\n');
  const subjectLine = lines.find(l => /^subject:/i.test(l));
  const subject = (subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : `Accounting services for ${org.name}`).replace(/\*\*/g, '');
  const rawBody = lines.filter(l => !/^subject:/i.test(l)).join('\n').trim().replace(/\*\*/g, '');

  const sigText = `\n\n--\nAsante Muyungga, CPA\nFounder and CEO | Spectrum Financial Solutions\nasante@spectrumfinancialsolution.com\nspectrumfinancialsolution.com\nSchedule a free 30-min call: ${CALENDLY_URL}`;
  const sigHtml = `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
<table style="font-family:Arial,sans-serif;font-size:13px;color:#475569;border-collapse:collapse">
  <tr><td style="padding-bottom:6px"><strong style="font-size:14px;color:#1e293b">Asante Muyungga, CPA</strong></td></tr>
  <tr><td style="color:#64748b">Founder and CEO | Spectrum Financial Solutions</td></tr>
  <tr><td style="padding-top:4px"><a href="mailto:asante@spectrumfinancialsolution.com" style="color:#3b82f6;text-decoration:none">asante@spectrumfinancialsolution.com</a></td></tr>
  <tr><td><a href="https://spectrumfinancialsolution.com" style="color:#3b82f6;text-decoration:none">spectrumfinancialsolution.com</a></td></tr>
  <tr><td style="padding-top:8px"><a href="${CALENDLY_URL}" style="background:#3b82f6;color:#fff;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:12px;display:inline-block">📅 Schedule a Free Consultation</a></td></tr>
</table>`;

  const body = rawBody + sigText;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:600px;margin:0 auto"><p>${rawBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>${sigHtml}</div>`;

  if (!RESEND_API_KEY) {
    console.log(`   [DRY RUN] Would send to ${toEmail} — Subject: ${subject}`);
    return true;
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: `${OWNER_NAME} | ${FIRM_NAME} <outbound@spectrumfinancialsolution.com>`,
      to: [toEmail],
      reply_to: 'asante@spectrumfinancialsolution.com',
      bcc: ['snt.milla@gmail.com'],
      subject,
      text: body,
      html,
    });
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
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`Resend ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── ProPublica Nonprofit Explorer API ───────────────────────────────────────
// Free, no API key — covers all US nonprofits with 990 filings
async function searchProPublica(stateId, query) {
  const url = `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(query)}&state%5Bid%5D=${stateId}`;
  try {
    const body = await fetchUrl(url, { 'Accept': 'application/json' });
    const data = JSON.parse(body);
    return (data.organizations || []).map(o => ({
      ein: String(o.ein || ''),
      name: (o.name || '').trim(),
      city: o.city || '',
      state: stateId,
      ntee: o.ntee_code || '',
      revenue: o.revenue || 0,
      source: 'propublica',
      orgType: 'nonprofit',
    }));
  } catch (e) {
    console.log(`   [ProPublica] Error (${stateId}/${query}): ${e.message}`);
    return [];
  }
}

async function getProPublicaWebsite(ein) {
  if (!ein) return null;
  try {
    const body = await fetchUrl(`https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`, { 'Accept': 'application/json' });
    const data = JSON.parse(body);
    return data.organization?.website || null;
  } catch {
    return null;
  }
}

// ── HRSA Health Center Finder ────────────────────────────────────────────────
// Public API — returns all FQHCs in a state
async function searchHRSA(stateId) {
  // Try the primary HRSA Find a Health Center API
  const urls = [
    `https://findahealthcenter.hrsa.gov/api/grantees/search?state=${stateId}&pageNumber=1&pageSize=100`,
    `https://bphc.hrsa.gov/find-a-health-center/search?state=${stateId}&format=json`,
    `https://data.hrsa.gov/api/search/sites?StateAbbreviations=${stateId}&facilityType=Health%20Center&pageSize=100`,
  ];

  for (const url of urls) {
    try {
      const body = await fetchUrl(url, { 'Accept': 'application/json' });
      const data = JSON.parse(body);
      const items = data.grantees || data.results || data.items || data.data || [];
      if (!items.length) continue;
      return items.map(c => ({
        name: (c.name || c.grantee_name || c.organizationName || c.siteName || '').trim(),
        city: c.city || c.primaryCity || '',
        state: stateId,
        website: c.website || c.websiteUrl || c.siteWebsiteUrl || null,
        phone: c.phone || c.phoneNumber || c.sitePhone || null,
        source: 'hrsa',
        orgType: 'fqhc',
      })).filter(c => c.name);
    } catch (e) {
      console.log(`   [HRSA] ${url}: ${e.message}`);
    }
  }
  return [];
}

// ── Indeed job scraping ──────────────────────────────────────────────────────
// Companies posting CFO/accounting jobs at nonprofits = high buying intent
async function searchIndeedJobs(stateName) {
  const queries = [
    'fractional CFO nonprofit',
    'nonprofit controller accounting director',
    'FQHC finance director CFO',
  ];
  const results = [];
  const seen = new Set();

  for (const q of queries) {
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(stateName)}&sort=date&fromage=60&limit=25`;
    try {
      const html = await fetchUrl(url);
      // Extract company names from Indeed's JSON-in-HTML data
      const matches = [
        ...(html.match(/"companyName":"([^"]+)"/g) || []),
        ...(html.match(/"employerName":"([^"]+)"/g) || []),
        ...(html.match(/class="companyName"[^>]*>([^<]+)</g) || []),
      ];
      for (const m of matches) {
        const company = m
          .replace(/"companyName":"/, '').replace(/"employerName":"/, '')
          .replace(/class="companyName"[^>]*>/, '').replace(/"$/, '').replace(/<.*/, '').trim();
        if (company && company.length > 2 && !seen.has(company.toLowerCase())) {
          seen.add(company.toLowerCase());
          results.push({
            name: company,
            state: stateName,
            source: 'indeed_jobs',
            orgType: 'nonprofit',
          });
        }
      }
    } catch (e) {
      console.log(`   [Indeed] Error for "${q}": ${e.message}`);
    }
    await sleep(2500); // be polite to Indeed
  }
  return results;
}

// ── DuckDuckGo website search ────────────────────────────────────────────────
// Used to find a nonprofit's website when we only have their name
// DDG wraps result URLs as /l/?uddg=ENCODED_URL — must decode uddg parameter
async function findWebsiteViaDuckDuckGo(orgName, city, stateId) {
  const junk = ['duckduckgo', 'google', 'facebook', 'twitter', 'linkedin', 'yelp',
                'wikipedia', 'propublica', 'guidestar', 'candid', 'charitynavigator',
                'indeed', 'glassdoor', 'ziprecruiter', 'irs.gov', 'usa.gov',
                'bbb.org', 'yellowpages', 'mapquest', 'bing.com'];

  const query = `${orgName} ${city || ''} ${stateId} official site`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const html = await fetchUrl(url);

    // DDG result links look like: href="//duckduckgo.com/l/?uddg=https%3A%2F%2F..."
    // Extract and decode the uddg parameter
    const uddgMatches = [...(html.matchAll(/uddg=(https?[^&"'\s]+)/gi))];
    for (const m of uddgMatches) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (!junk.some(j => decoded.toLowerCase().includes(j))) return decoded;
      } catch {}
    }

    // Fallback: plain https:// hrefs (in case DDG changes format)
    const hrefs = html.match(/href="(https?:\/\/[^"]+)"/g) || [];
    const site = hrefs
      .map(h => h.replace(/href="/, '').replace(/"$/, ''))
      .find(u => !junk.some(j => u.toLowerCase().includes(j)));
    return site || null;
  } catch {
    return null;
  }
}

// ── Main orchestrator ────────────────────────────────────────────────────────
async function runNonprofitSearch() {
  console.log('\n🏥 Nonprofit / FQHC Lead Search — Spectrum Financial Solutions');
  console.log('   Sources : ProPublica Nonprofit Explorer · HRSA Health Centers · Indeed Jobs');
  console.log(`   States  : ${TARGET_STATES.map(s => s.id).join(', ')}`);
  console.log(`   Cap     : ${DAILY_EMAIL_CAP} emails max this run\n`);

  const allLeads = loadLeads();
  // Count emails already sent today (reuse today's quota)
  const todayStr = new Date().toISOString().slice(0, 10);
  let emailedThisRun = allLeads.filter(l => (l.emailSentAt || '').startsWith(todayStr)).length;
  let totalFound = 0, totalEmailed = 0;

  for (const state of TARGET_STATES) {
    if (emailedThisRun >= DAILY_EMAIL_CAP) {
      console.log('\n🎯 Daily cap reached — stopping\n');
      break;
    }

    console.log(`\n── ${state.name} (${state.id}) ${'─'.repeat(40 - state.name.length)}`);

    // ── 1. HRSA FQHCs ─────────────────────────────────────────────────────
    const fqhcs = await searchHRSA(state.id).catch(() => []);
    console.log(`   [HRSA]       ${fqhcs.length} FQHCs`);
    await sleep(1000);

    // ── 2. ProPublica nonprofits ──────────────────────────────────────────
    const npOrgs = [];
    for (const q of NP_QUERIES) {
      const orgs = await searchProPublica(state.id, q).catch(() => []);
      npOrgs.push(...orgs);
      await sleep(800);
    }
    // Deduplicate ProPublica orgs (revenue field is not returned by the search endpoint)
    const seenEin = new Set();
    const filteredNp = npOrgs.filter(o => {
      const key = o.ein || o.name.toLowerCase().slice(0, 30);
      if (seenEin.has(key)) return false;
      seenEin.add(key);
      return true;
    });
    console.log(`   [ProPublica] ${filteredNp.length} nonprofits`);

    // ── 3. Indeed high-intent job postings ────────────────────────────────
    const indeedOrgs = await searchIndeedJobs(state.name).catch(() => []);
    console.log(`   [Indeed]     ${indeedOrgs.length} companies hiring`);

    // ── Combine & deduplicate ─────────────────────────────────────────────
    const seenNames = new Set();
    const allOrgs = [
      ...fqhcs,                               // highest priority — known FQHCs
      ...indeedOrgs,                          // high intent — actively hiring
      ...filteredNp,                          // ProPublica nonprofits
    ].filter(o => {
      if (!o.name || o.name.length < 3) return false;
      const key = o.name.toLowerCase().trim();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    console.log(`   [Combined]   ${allOrgs.length} unique orgs to process`);

    // ── Process each org ──────────────────────────────────────────────────
    for (const org of allOrgs.slice(0, 40)) {
      if (emailedThisRun >= DAILY_EMAIL_CAP) break;

      const listingKey = `np_${state.id}_${org.name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)}`;
      if (alreadyProcessed(listingKey)) continue;

      // Find website
      let website = org.website || null;
      if (!website && org.ein) {
        website = await withTimeout(getProPublicaWebsite(org.ein), 8000, 'propublica-website').catch(() => null);
        await sleep(500);
      }
      if (!website) {
        website = await withTimeout(findWebsiteViaDuckDuckGo(org.name, org.city, state.id), 10000, 'ddg').catch(() => null);
        await sleep(800);
      }

      // Find email on their website
      let email = null;
      if (website) {
        email = await withTimeout(findEmailOnWebsite(website), 12000, 'email-find').catch(() => null);
        await sleep(500);
      }

      const lead = {
        id: `np_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: org.name,
        city: org.city || '',
        state: state.id,
        industry: org.orgType === 'fqhc' ? 'FQHC / Community Health Center' : 'Nonprofit Organization',
        source: org.source || 'nonprofit_search',
        listingUrl: listingKey,
        website: website || null,
        phone: org.phone || null,
        email: null,
        status: 'found',
        ein: org.ein || null,
        orgType: org.orgType || 'nonprofit',
        foundAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (!email) {
        lead.status = website ? 'no_email' : 'no_website';
        saveLead(lead);
        console.log(`   ✗ ${org.name.slice(0, 45)} — ${lead.status}`);
        continue;
      }

      if (alreadyEmailedAddress(email)) {
        saveLead({ ...lead, status: 'no_email', email });
        console.log(`   ✗ ${org.name.slice(0, 45)} — already emailed`);
        continue;
      }

      lead.email = email;
      totalFound++;

      // Generate tailored nonprofit/FQHC email
      let emailContent;
      try {
        emailContent = await withTimeout(generateNonprofitEmail(lead), 35000, 'generateEmail');
      } catch (err) {
        lead.status = 'error'; lead.error = err.message;
        saveLead(lead);
        console.log(`   ✗ ${org.name.slice(0, 45)} — email gen error: ${err.message}`);
        continue;
      }

      // Send
      try {
        await sendEmail(email, emailContent, lead);
        lead.status = 'emailed';
        lead.emailSent = true;
        lead.emailSentAt = new Date().toISOString();
        lead.emailContent = emailContent;
        console.log(`   ✅ [${org.orgType.toUpperCase()}] ${org.name.slice(0, 40)} → ${email}`);
        totalEmailed++;
        emailedThisRun++;
      } catch (err) {
        lead.status = 'send_error'; lead.error = err.message;
        console.log(`   ✗ ${org.name.slice(0, 45)} — send error: ${err.message}`);
      }

      saveLead(lead);
      if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
    }

    // Sync to GitHub after every state
    await pushLeadsToGitHub(loadLeads()).catch(e => console.log('[GitHub]', e.message));
    await sleep(2000);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Nonprofit search complete`);
  console.log(`   Leads found with email : ${totalFound}`);
  console.log(`   Emails sent            : ${totalEmailed}`);
  console.log(`${'═'.repeat(60)}\n`);
}

runNonprofitSearch().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
