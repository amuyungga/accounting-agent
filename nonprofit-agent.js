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

// ── Domain guessing — free, no API key, works from any IP ───────────────────
// Derives candidate domains from the org name and checks if they resolve.
// Catches ~30-50% of orgs whose domain is a simple slug of their name.
const STOP_WORDS = new Set([
  'community','health','center','foundation','services','service','clinic',
  'clinics','organization','inc','llc','corp','of','the','and','for','a',
  'an','at','in','on','care','care','solutions','group','association',
  'network','alliance','collaborative','partners','partnership','county',
  'city','regional','rural','urban','valley','mountain','coast','bay',
  'lake','river','family','families','children','youth','senior','adult',
  'medical','mental','behavioral','substance','primary','federally',
  'qualified','fqhc','free','nonprofit','non','profit','charitable',
]);

function orgNameToDomainSlug(name) {
  return name.toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 5)
    .join('');
}

function urlIsUp(url) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 7000);
    let parsed;
    try { parsed = new URL(url); } catch { clearTimeout(timer); return resolve(false); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: parsed.hostname, path: '/', method: 'HEAD', timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      clearTimeout(timer); settled = true;
      resolve(res.statusCode < 500);
    });
    req.on('error', () => { clearTimeout(timer); settled = true; resolve(false); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); settled = true; resolve(false); });
    req.end();
  });
}

async function guessDomainForOrg(orgName) {
  const slug = orgNameToDomainSlug(orgName);
  if (slug.length < 3) return null;

  // Also try full-name slug (all meaningful words)
  const fullSlug = orgName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const candidates = [
    `https://${slug}.org`,
    `https://${slug}.com`,
    `https://www.${slug}.org`,
    `https://${slug}health.org`,
    `https://${slug}clinic.org`,
    `https://${fullSlug}.org`,
    `https://${fullSlug}.com`,
  ];

  for (const url of [...new Set(candidates)]) {
    const up = await urlIsUp(url);
    if (up) {
      console.log(`   [DomainGuess] ✓ ${url}`);
      return url;
    }
  }
  return null;
}

// ── Serper.dev search (optional — requires paid credits) ─────────────────────
const SERPER_API_KEY = process.env.SERPER_API_KEY;

async function searchViaSerper(orgName, city, stateId) {
  if (!SERPER_API_KEY) return null;
  const junk = ['bing.com','duckduckgo.com','google.com','facebook.com','twitter.com',
                 'linkedin.com','yelp.com','wikipedia.org','propublica.org',
                 'guidestar.org','candid.org','charitynavigator.org',
                 'indeed.com','glassdoor.com','irs.gov','usa.gov','bbb.org'];
  const query = `"${orgName}" ${city || ''} ${stateId || ''}`.trim();
  const body  = JSON.stringify({ q: query, num: 5 });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 10000);
    const req = https.request({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY,
                 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer); settled = true;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.statusCode === 401 || data.error) { resolve(null); return; }
          const results = data.organic || [];
          for (const r of results) {
            const url = r.link || '';
            if (url && !junk.some(j => url.toLowerCase().includes(j))) return resolve(url);
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timer); settled = true; resolve(null); });
    req.write(body); req.end();
  });
}

// ── Google Custom Search Engine (100 free queries/day) ───────────────────────
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;
const GOOGLE_CSE_CX  = process.env.GOOGLE_CSE_CX;

// ── Brave Search API (~$5 free credits/month ≈ 2,000 queries) ────────────────
const BRAVE_SEARCH_KEY = process.env.BRAVE_SEARCH_KEY;

async function searchViaGoogleCSE(orgName, city, stateId) {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) return null;
  const junk = ['facebook.com','twitter.com','linkedin.com','yelp.com',
                'wikipedia.org','propublica.org','guidestar.org','candid.org',
                'charitynavigator.org','indeed.com','glassdoor.com','irs.gov',
                'usa.gov','bbb.org','google.com','bing.com',
                'spectrumfinancialsolution.com']; // CSE limited to own site — filter it
  const q = encodeURIComponent(`${orgName} ${city || ''} ${stateId || ''} official website`.trim());
  const apiPath = `/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_CX}&q=${q}&num=5`;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 8000);
    const req = https.request({ hostname: 'www.googleapis.com', path: apiPath, method: 'GET',
      headers: { 'Accept': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer); settled = true;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) { resolve(null); return; }
          for (const item of (data.items || [])) {
            const url = item.link || '';
            if (url && !junk.some(j => url.toLowerCase().includes(j))) {
              try { const u = new URL(url); resolve(`${u.protocol}//${u.hostname}`); return; }
              catch { resolve(url); return; }
            }
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timer); settled = true; resolve(null); });
    req.end();
  });
}

// ── Brave Web Search (~$5 free credits/month ≈ 2,000 queries) ────────────────
async function searchViaBrave(orgName, city, stateId) {
  if (!BRAVE_SEARCH_KEY) return null;
  const junk = ['facebook.com','twitter.com','linkedin.com','yelp.com',
                'wikipedia.org','propublica.org','guidestar.org','candid.org',
                'charitynavigator.org','indeed.com','glassdoor.com','irs.gov',
                'usa.gov','bbb.org','google.com','bing.com',
                'spectrumfinancialsolution.com'];
  // No quotes — exact-phrase matching returns 0 results for most orgs
  const q = encodeURIComponent(`${orgName} ${city || ''} ${stateId || ''} official website`.trim());
  const apiPath = `/res/v1/web/search?q=${q}&count=5&search_lang=en&country=us`;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 8000);
    const req = https.request({
      hostname: 'api.search.brave.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_KEY
        // No Accept-Encoding — avoid gzip so Buffer.concat gives plain UTF-8
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer); settled = true;
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            console.log(`   [Brave] HTTP ${res.statusCode}: ${raw.slice(0, 120)}`);
            resolve(null); return;
          }
          const data = JSON.parse(raw);
          const results = (data.web && data.web.results) || [];
          if (results.length === 0) {
            console.log(`   [Brave] 200 OK but 0 results (query too specific?)`);
          }
          for (const item of results) {
            const url = item.url || '';
            if (url && !junk.some(j => url.toLowerCase().includes(j))) {
              try { const u = new URL(url); resolve(`${u.protocol}//${u.hostname}`); return; }
              catch { resolve(url); return; }
            }
          }
          resolve(null);
        } catch(e) {
          console.log(`   [Brave] parse error: ${e.message.slice(0, 100)}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.log(`   [Brave] network error: ${e.message}`);
      clearTimeout(timer); settled = true; resolve(null);
    });
    req.end();
  });
}

// ── Combined website finder: Google CSE → Brave → Serper → domain guessing ───
async function findWebsiteViaDuckDuckGo(orgName, city, stateId) {
  // 1. Google CSE (falls back gracefully if CSE is misconfigured)
  if (GOOGLE_CSE_KEY && GOOGLE_CSE_CX) {
    const cseResult = await searchViaGoogleCSE(orgName, city, stateId);
    if (cseResult) { console.log(`   [CSE] ✓ ${cseResult}`); return cseResult; }
  }
  // 2. Brave Search (free $5/month ≈ 2,000 queries)
  if (BRAVE_SEARCH_KEY) {
    const braveResult = await searchViaBrave(orgName, city, stateId);
    if (braveResult) { console.log(`   [Brave] ✓ ${braveResult}`); return braveResult; }
  }
  // 3. Serper fallback (if paid credits available)
  if (SERPER_API_KEY) {
    const serperResult = await searchViaSerper(orgName, city, stateId);
    if (serperResult) return serperResult;
  }
  // 4. Free domain guessing as last resort
  return guessDomainForOrg(orgName);
}

// ── Retry previously uncontacted leads ────────────────────────────────────────
// Runs at the start of every search cycle.
// Pass 1 — no_website (up to 100): website was never found; try again with Brave/CSE.
// Pass 2 — no_email  (up to 60 ): website was found but no email; Brave may find the
//           REAL site now (previous runs used domain-guessing which was often wrong).
async function retryUncontactedLeads(emailedThisRun) {
  const leads     = loadLeads();
  const noWebsite = leads.filter(l => l.status === 'no_website' && l.name);
  const noEmail   = leads.filter(l => l.status === 'no_email'   && l.name && l.state);

  console.log(`\n🔄 Retry pass — ${noWebsite.length} no_website · ${noEmail.length} no_email uncontacted leads`);

  // Helper: try to email a lead if we found an address
  async function tryEmail(lead) {
    if (alreadyEmailedAddress(lead.email)) { lead.status = 'no_email'; saveLead(lead); return; }
    try {
      const content = await withTimeout(generateNonprofitEmail(lead), 35000, 'retry-gen');
      await sendEmail(lead.email, content, lead);
      lead.status   = 'emailed';
      lead.emailSent    = true;
      lead.emailSentAt  = new Date().toISOString();
      lead.emailContent = content;
      console.log(`   ✅ [RETRY] ${lead.name.slice(0, 42)} → ${lead.email}`);
      emailedThisRun++;
    } catch (err) {
      lead.status = 'error'; lead.error = err.message;
      console.log(`   ✗ [RETRY] ${lead.name.slice(0, 42)} — ${err.message.slice(0, 50)}`);
    }
    saveLead(lead);
    if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
  }

  // ── Pass 1: no_website → re-run website search with improved Brave/CSE ───
  let p1 = 0;
  for (const lead of noWebsite) {
    if (emailedThisRun >= DAILY_EMAIL_CAP || p1 >= 100) break;
    p1++;

    const website = await withTimeout(
      findWebsiteViaDuckDuckGo(lead.name, lead.city || '', lead.state || ''),
      10000, 'retry-web1'
    ).catch(() => null);
    await sleep(600);

    if (!website) {
      console.log(`   ✗ ${lead.name.slice(0, 42)} — still no website`);
      continue;
    }

    lead.website = website;
    const email = await withTimeout(findEmailOnWebsite(website), 12000, 'retry-em1').catch(() => null);
    await sleep(400);

    if (!email) {
      lead.status = 'no_email';
      saveLead(lead);
      console.log(`   ~ ${lead.name.slice(0, 42)} — website found, no email`);
      continue;
    }

    lead.email = email;
    await tryEmail(lead);
  }

  // ── Pass 2: no_email → re-run website search (Brave finds real site vs. guess) ─
  let p2 = 0;
  for (const lead of noEmail) {
    if (emailedThisRun >= DAILY_EMAIL_CAP || p2 >= 60) break;
    p2++;

    const freshWebsite = await withTimeout(
      findWebsiteViaDuckDuckGo(lead.name, lead.city || '', lead.state || ''),
      10000, 'retry-web2'
    ).catch(() => null);
    await sleep(600);

    // Only proceed if Brave/CSE found a DIFFERENT (likely better) website
    if (!freshWebsite || freshWebsite === lead.website) continue;

    lead.website = freshWebsite;
    const email = await withTimeout(findEmailOnWebsite(freshWebsite), 12000, 'retry-em2').catch(() => null);
    await sleep(400);

    if (!email) continue;

    lead.email = email;
    await tryEmail(lead);
  }

  // Persist after retry pass
  await pushLeadsToGitHub(loadLeads()).catch(e => console.log('[GitHub-retry]', e.message));
  console.log(`   Retry complete — emails sent this pass: ${emailedThisRun}`);
  return emailedThisRun;
}

// ── Main orchestrator ────────────────────────────────────────────────────────
async function runNonprofitSearch() {
  // ── API key diagnostics ───────────────────────────────────────────────────
  console.log(`   [DIAG] BRAVE_SEARCH_KEY : ${BRAVE_SEARCH_KEY ? `SET (${BRAVE_SEARCH_KEY.length} chars)` : 'MISSING'}`);
  console.log(`   [DIAG] GOOGLE_CSE_KEY   : ${GOOGLE_CSE_KEY  ? 'SET' : 'MISSING'}`);
  console.log(`   [DIAG] SERPER_API_KEY   : ${SERPER_API_KEY  ? 'SET' : 'MISSING'}`);

  console.log('\n🏥 Nonprofit / FQHC Lead Search — Spectrum Financial Solutions');
  console.log('   Sources : ProPublica Nonprofit Explorer · HRSA Health Centers · Indeed Jobs');
  console.log(`   States  : ${TARGET_STATES.map(s => s.id).join(', ')}`);
  console.log(`   Cap     : ${DAILY_EMAIL_CAP} emails max this run\n`);

  const allLeads = loadLeads();
  // Count emails already sent today (reuse today's quota)
  const todayStr = new Date().toISOString().slice(0, 10);
  let emailedThisRun = allLeads.filter(l => (l.emailSentAt || '').startsWith(todayStr)).length;
  let totalFound = 0, totalEmailed = 0;

  // ── Retry uncontacted leads first (no_website + no_email) ─────────────────
  emailedThisRun = await retryUncontactedLeads(emailedThisRun);

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
