/**
 * Outbound Lead Generation Agent
 * Spectrum Financial Solutions
 *
 * What it does:
 *   1. Rotates through major cities across California
 *   2. Each run: picks the next 10 unsearched city+industry combinations
 *   3. Scrapes business websites for contact emails
 *   4. Claude writes a personalized cold email for each lead
 *   5. Sends via Gmail and saves everything to outbound-leads.json
 *   6. Tracks progress in outbound-progress.json so no city is repeated
 *
 * Usage:
 *   node outbound-agent.js           ← runs today's 10 searches
 *   node outbound-agent.js --reset   ← restart rotation from the beginning
 *
 * Required .env:
 *   ANTHROPIC_API_KEY        (already set)
 *   OUTLOOK_PASSWORD         (your Outlook/Microsoft 365 password or app password)
 *   GOOGLE_PLACES_API_KEY    (optional — get free at console.cloud.google.com)
 *                             Without it, falls back to Yellow Pages scraping.
 */

require('dotenv').config();
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Firm config ─────────────────────────────────────────────────────────────
const FIRM_NAME    = 'Spectrum Financial Solutions';
const OWNER_NAME   = 'Asante';
const FROM_EMAIL   = 'asante@spectrumfinancialsolution.com';
const CALENDLY_URL = 'https://calendly.com/asante-spectrumfinancialsolution/30min';
const LEADS_FILE   = path.join(__dirname, 'outbound-leads.json');
const PROGRESS_FILE = path.join(__dirname, 'outbound-progress.json');
const GOOGLE_API   = process.env.GOOGLE_PLACES_API_KEY || null;

// ── Daily search limit ──────────────────────────────────────────────────────
const DAILY_SEARCH_LIMIT = 15;   // city+industry combinations per run
const MAX_LEADS_PER_SEARCH = 5;  // businesses per search query
const EMAIL_DELAY_MS = 12000;    // 12s between emails

// ── California cities only ────────────────────────────────────────────────
const ALL_CITIES = [
  // Priority target
  'Fairfield, CA',
  // California
  'Los Angeles, CA', 'San Francisco, CA', 'San Diego, CA', 'San Jose, CA',
  'Sacramento, CA', 'Fresno, CA', 'Oakland, CA', 'Long Beach, CA',
  'Bakersfield, CA', 'Anaheim, CA', 'Santa Ana, CA', 'Irvine, CA',
  'Stockton, CA', 'Chula Vista, CA', 'Fremont, CA', 'Riverside, CA',
  'Santa Clarita, CA', 'San Bernardino, CA', 'Modesto, CA', 'Fontana, CA',
  'Moreno Valley, CA', 'Glendale, CA', 'Huntington Beach, CA', 'Santa Ana, CA',
  'Garden Grove, CA', 'Oxnard, CA', 'Oceanside, CA', 'Rancho Cucamonga, CA',
  'Santa Rosa, CA', 'Ontario, CA', 'Elk Grove, CA', 'Corona, CA',
  'Salinas, CA', 'Pomona, CA', 'Torrance, CA', 'Escondido, CA',
  'Sunnyvale, CA', 'Pasadena, CA', 'Orange, CA', 'Fullerton, CA',
  'Visalia, CA', 'Thousand Oaks, CA', 'Simi Valley, CA', 'Concord, CA',
  'Roseville, CA', 'Santa Clara, CA', 'Vallejo, CA', 'Berkeley, CA',
  // Colorado
  'Denver, CO', 'Colorado Springs, CO', 'Aurora, CO', 'Boulder, CO',
  // Connecticut
  'Bridgeport, CT', 'New Haven, CT', 'Hartford, CT', 'Stamford, CT',
  // Delaware
  'Wilmington, DE', 'Dover, DE',
  // Florida
  'Miami, FL', 'Orlando, FL', 'Tampa, FL', 'Jacksonville, FL',
  'Fort Lauderdale, FL', 'St. Petersburg, FL', 'Hialeah, FL', 'Tallahassee, FL',
  'Naples, FL', 'Sarasota, FL',
  // Georgia
  'Atlanta, GA', 'Savannah, GA', 'Augusta, GA', 'Columbus, GA',
  // Hawaii
  'Honolulu, HI', 'Hilo, HI',
  // Idaho
  'Boise, ID', 'Nampa, ID', 'Meridian, ID',
  // Illinois
  'Chicago, IL', 'Aurora, IL', 'Rockford, IL', 'Naperville, IL',
  // Indiana
  'Indianapolis, IN', 'Fort Wayne, IN', 'Evansville, IN',
];

// ── Industries to target ────────────────────────────────────────────────────
const INDUSTRIES = [
  'restaurant',
  'law firm',
  'medical clinic',
  'dental office',
  'real estate agency',
  'retail store',
  'construction company',
  'hair salon',
  'auto repair shop',
  'landscaping company',
  'property management',
  'insurance agency',
  'marketing agency',
  'IT consulting firm',
  'chiropractic office',
  'veterinary clinic',
  'gym fitness center',
  'plumbing company',
  'electrical contractor',
  'catering company',
];

// ── Progress tracker ────────────────────────────────────────────────────────
// Generates every city+industry combination, rotates through them daily
function buildSearchQueue() {
  const queue = [];
  for (const city of ALL_CITIES) {
    for (const industry of INDUSTRIES) {
      queue.push({ city, industry, key: `${city}|${industry}` });
    }
  }
  return queue;
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { completed: [], nextIndex: 0 };
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { completed: [], nextIndex: 0 }; }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function getNextSearches(count) {
  const queue = buildSearchQueue();
  const progress = loadProgress();

  // If we've gone through the whole list, restart
  if (progress.nextIndex >= queue.length) {
    console.log('\n🔄 Full rotation complete — restarting from the beginning\n');
    progress.nextIndex = 0;
    progress.completed = [];
  }

  const batch = queue.slice(progress.nextIndex, progress.nextIndex + count);
  progress.nextIndex += batch.length;
  saveProgress(progress);

  const total = queue.length;
  const pct = Math.round((progress.nextIndex / total) * 100);
  console.log(`📊 Progress: ${progress.nextIndex}/${total} searches done (${pct}%)`);
  const remaining = total - progress.nextIndex;
  const daysLeft = Math.ceil(remaining / DAILY_SEARCH_LIMIT);
  console.log(`📅 At 10/day, full US coverage completes in ~${daysLeft} more days\n`);

  return batch;
}

// ── Anthropic + Mailer ─────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
if (!RESEND_API_KEY) console.warn('[Warn] RESEND_API_KEY not set in .env — emails will be logged but not sent.');

// ── Lead DB ────────────────────────────────────────────────────────────────
function loadLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return []; }
}

function saveLead(lead) {
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.placeId === lead.placeId);
  const record = {
    ...lead,
    id: idx >= 0 ? leads[idx].id : `ol_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    foundAt: idx >= 0 ? leads[idx].foundAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) leads[idx] = record;
  else leads.push(record);
  // Atomic write: write to .tmp first, then rename — prevents corruption on crash/interrupt
  const tmp = LEADS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2));
  fs.renameSync(tmp, LEADS_FILE);
  return record;
}

function alreadyProcessed(placeId) {
  const leads = loadLeads();
  const lead = leads.find(l => l.placeId === placeId);
  return lead && lead.status !== 'found';
}

function alreadyEmailedAddress(email) {
  if (!email) return false;
  const leads = loadLeads();
  return leads.some(l =>
    l.email && l.email.toLowerCase() === email.toLowerCase() &&
    ['emailed', 'follow_up_sent'].includes(l.status)
  );
}

// ── Lead scoring (0–100) ───────────────────────────────────────────────────
function scoreLead(lead) {
  let score = 0;
  if (lead.industry === 'intent_lead') score += 40;
  if (lead.intentSource === 'linkedin')     score += 15;
  if (lead.intentSource === 'indeed')       score += 15;
  if (lead.intentSource === 'new_business') score += 20;
  if (lead.intentSource === 'craigslist')   score += 10;
  if (lead.intentSource === 'ziprecruiter') score += 10;
  if (lead.intentSource === 'reddit')       score += 8;
  if (lead.email)   score += 15;
  if (lead.phone)   score += 5;
  if (lead.website) score += 5;
  return Math.min(score, 100);
}

// ── HTTP fetch ─────────────────────────────────────────────────────────────
function fetchUrl(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return reject(new Error('Invalid URL')); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(targetUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 600_000) req.destroy(); });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Email extraction ───────────────────────────────────────────────────────
function extractEmails(html, preferDomain) {
  if (!html) return [];
  const pattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const all = [...new Set(html.match(pattern) || [])];
  const junk = ['noreply', 'no-reply', 'donotreply', 'example.com', 'sentry.io',
                 'wixpress', 'squarespace', 'wordpress', 'schema.org', 'w3.org',
                 'googleapis', 'gmpg.org', 'jquery', 'cloudflare'];
  const clean = all.filter(e => !junk.some(j => e.toLowerCase().includes(j)));
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
    const homepageHtml = await fetchUrl(full).catch(() => '');
    let emails = extractEmails(homepageHtml, domain);
    if (emails.length) return emails[0];
    for (const slug of ['/contact', '/contact-us', '/about']) {
      const contactHtml = await fetchUrl(`${parsed.origin}${slug}`).catch(() => '');
      emails = extractEmails(contactHtml, domain);
      if (emails.length) return emails[0];
    }
    return null;
  } catch {
    return null;
  }
}

// ── Google Places API (New) ────────────────────────────────────────────────
async function searchGooglePlaces(industry, city) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ textQuery: `${industry} in ${city}` });
    const req = https.request({
      hostname: 'places.googleapis.com',
      path: '/v1/places:searchText',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_API,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) {
            console.warn(`[Google Places] ${json.error.message}`);
            resolve([]);
            return;
          }
          const places = json.places || [];
          resolve(places.map(p => ({
            source: 'google_places',
            placeId: p.id,
            name: p.displayName?.text || '',
            address: p.formattedAddress || city,
            city,
            phone: p.nationalPhoneNumber || null,
            website: p.websiteUri || null,
            industry,
            status: 'found',
            email: null,
          })));
        } catch (e) {
          console.error(`[Google Places] Parse error: ${e.message}`);
          resolve([]);
        }
      });
    });
    req.on('error', err => { console.error(`[Google Places] ${err.message}`); resolve([]); });
    req.write(payload);
    req.end();
  });
}

async function getPlaceDetails(placeId) {
  // Details already included in searchGooglePlaces with the new API
  return {};
}

// ── Yellow Pages fallback ──────────────────────────────────────────────────
async function searchYellowPages(industry, city) {
  const q   = encodeURIComponent(industry);
  const loc = encodeURIComponent(city);
  const url = `https://www.yellowpages.com/search?search_terms=${q}&geo_location_terms=${loc}`;
  try {
    const html = await fetchUrl(url);
    const leads = [];
    const nameMatches    = [...html.matchAll(/class="business-name"[^>]*><span[^>]*>([^<]+)<\/span>/g)];
    const phoneMatches   = [...html.matchAll(/class="phones phone primary">([^<]+)<\/a>/g)];
    const websiteMatches = [...html.matchAll(/class="[^"]*track-visit-website[^"]*"[^>]*href="([^"]+)"/g)];

    for (let i = 0; i < Math.min(nameMatches.length, MAX_LEADS_PER_SEARCH * 2); i++) {
      const name    = nameMatches[i]?.[1]?.trim();
      if (!name) continue;
      const phone   = phoneMatches[i]?.[1]?.trim()   || null;
      const website = websiteMatches[i]?.[1]          || null;
      leads.push({
        source: 'yellow_pages',
        placeId: `yp_${city.replace(/[^a-z0-9]/gi,'_')}_${industry.replace(/[^a-z0-9]/gi,'_')}_${i}`,
        name, phone,
        website: website && website.startsWith('http') ? website : null,
        address: city, city, industry,
        status: 'found', email: null,
      });
    }
    return leads;
  } catch (err) {
    console.error(`[Yellow Pages] ${err.message}`);
    return [];
  }
}

// ── Claude cold email ──────────────────────────────────────────────────────
async function generateColdEmail(business, variant = 'A') {
  const promptA = `Write a brief, warm cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} (a CPA & financial advisory firm) to the owner/manager of "${business.name}" — a ${business.industry} in ${business.city || business.address}.

Rules:
- First line must be: Subject: <compelling, specific subject line>
- 3 short paragraphs max, conversational tone, NOT salesy or generic
- Mention their industry (${business.industry}) and a relevant financial pain point (e.g., tax deadlines, payroll complexity, cash flow, bookkeeping overhead)
- Offer a FREE 30-minute consultation
- Weave in this booking link naturally: ${CALENDLY_URL}
- Do NOT include a sign-off or signature — it will be added automatically
- Do NOT start with "I hope this email finds you well" or similar filler
- Write ONLY the email body. No preamble, no sign-off.`;

  const promptB = `Write a short, direct cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} to "${business.name}" — a ${business.industry} in ${business.city || business.address}.

Angle: Lead with one specific, surprising insight about what businesses in their industry typically overpay or miss on taxes and bookkeeping.

Rules:
- First line: Subject: <curiosity-driven subject line — ask a question or name a dollar amount>
- 2 punchy paragraphs only — open with the insight, close with a soft ask
- Offer a FREE 30-minute consultation: ${CALENDLY_URL}
- Do NOT include a sign-off or signature — it will be added automatically
- Write ONLY the email body. No filler openers.`;

  const prompt = variant === 'B' ? promptB : promptA;

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
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content[0].text.trim());
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Follow-up email ────────────────────────────────────────────────────────
async function generateFollowUpEmail(lead) {
  const daysAgo = Math.floor((Date.now() - new Date(lead.emailSentAt).getTime()) / 86400000);
  const prompt = `Write a very brief follow-up email from ${OWNER_NAME} at ${FIRM_NAME} to "${lead.name || (lead.industry + ' business')}" in ${lead.city}.

Context: We sent them a cold email ${daysAgo} days ago offering a free financial consultation and haven't heard back.

Rules:
- First line: Subject: Re: <short callback to original subject>
- 2 short paragraphs max — acknowledge they're busy, briefly restate the value of a free 30-min call
- Soft close: just ask if they're still open to a quick chat, link: ${CALENDLY_URL}
- Keep total email under 80 words
- Do NOT include a sign-off or signature — it will be added automatically
- Write ONLY the email body, no preamble`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content[0].text.trim());
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function generateSecondFollowUp(lead) {
  const prompt = `Write a very short 2nd follow-up email from ${OWNER_NAME}, CPA at ${FIRM_NAME} to a business that hasn't responded to two previous outreach emails about outsourced accounting.

Business: ${lead.name || 'the business'}
City: ${lead.city || ''}

Angle: Keep it extremely brief — 2-3 sentences max. Be genuine, not pushy. Acknowledge they're likely busy. Leave the door open without pressure. End with a soft offer for the free call: ${CALENDLY_URL}

Rules:
- First line: Subject: <short subject, different from previous emails>
- 2-3 sentences only
- Warm, human tone — not a sales pitch
- Do NOT include a sign-off or signature`;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content[0].text.trim());
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runFollowUps() {
  console.log('\n📬 Follow-up check — looking for unanswered emails...');
  const leads = loadLeads();
  const now = Date.now();
  const THREE_DAYS  = 3  * 24 * 60 * 60 * 1000;
  const FIVE_DAYS   = 5  * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS  = 7  * 24 * 60 * 60 * 1000;
  const TEN_DAYS    = 10 * 24 * 60 * 60 * 1000;

  // 1st follow-up: 3-5 days after initial email, no follow-up sent yet
  const first = leads.filter(l => {
    if (l.status !== 'emailed') return false;
    if (l.followUpSent || l.replied) return false;
    if (!l.emailSentAt || !l.email) return false;
    const age = now - new Date(l.emailSentAt).getTime();
    return age >= THREE_DAYS && age <= FIVE_DAYS;
  });

  // 2nd follow-up: 7-10 days after initial email, 1st follow-up sent but no reply
  const second = leads.filter(l => {
    if (l.replied || l.secondFollowUpSent) return false;
    if (!l.followUpSent || !l.followUpSentAt || !l.email) return false;
    const age = now - new Date(l.emailSentAt).getTime();
    return age >= SEVEN_DAYS && age <= TEN_DAYS;
  });

  console.log(`   ${first.length} leads ready for 1st follow-up`);
  console.log(`   ${second.length} leads ready for 2nd follow-up`);
  let sent = 0;

  for (const lead of first) {
    try {
      const content = await generateFollowUpEmail(lead);
      await sendColdEmail(lead.email, content, { ...lead, emailVariant: 'followup1' });
      saveLead({ ...lead, status: 'follow_up_sent', followUpSent: true, followUpSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      console.log(`   ✅ 1st follow-up → ${lead.name || lead.email}`);
      sent++;
      if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
    } catch (e) {
      console.log(`   ✗ 1st follow-up failed for ${lead.email}: ${e.message}`);
    }
  }

  for (const lead of second) {
    try {
      const content = await generateSecondFollowUp(lead);
      await sendColdEmail(lead.email, content, { ...lead, emailVariant: 'followup2' });
      saveLead({ ...lead, secondFollowUpSent: true, secondFollowUpSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      console.log(`   ✅ 2nd follow-up → ${lead.name || lead.email}`);
      sent++;
      if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
    } catch (e) {
      console.log(`   ✗ 2nd follow-up failed for ${lead.email}: ${e.message}`);
    }
  }

  console.log(`   Total follow-ups sent: ${sent}\n`);
  return sent;
}

// ── Send email ─────────────────────────────────────────────────────────────
async function sendColdEmail(toEmail, emailContent, business) {
  const lines = emailContent.split('\n');
  const subjectLine = lines.find(l => /^subject:/i.test(l));
  // Strip markdown bold (**) from subject
  const subject = (subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : `A quick note for ${business.name}`).replace(/\*\*/g, '');

  // Strip markdown bold from body
  const rawBody = lines.filter(l => !/^subject:/i.test(l)).join('\n').trim().replace(/\*\*/g, '');

  // Professional signature
  const sigText = `\n\n--\nAsante Muyungga, CPA\nFounder and CEO | Spectrum Financial Solutions\nasante@spectrumfinancialsolution.com\nspectrumfinancialsolution.com\nSchedule a free 30-min call: ${CALENDLY_URL}`;
  const sigHtml = `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
<table style="font-family:Arial,sans-serif;font-size:13px;color:#475569;border-collapse:collapse">
  <tr><td style="padding-bottom:10px"><a href="https://spectrumfinancialsolution.com"><img src="https://spectrumfinancialsolution.com/airo-assets/images/logo/horizontal" alt="Spectrum Financial Solutions" style="height:40px;width:auto;display:block" /></a></td></tr>
  <tr><td><strong style="font-size:14px;color:#1e293b">Asante Muyungga, CPA</strong></td></tr>
  <tr><td style="color:#64748b">Founder and CEO | Spectrum Financial Solutions</td></tr>
  <tr><td style="padding-top:4px"><a href="mailto:asante@spectrumfinancialsolution.com" style="color:#3b82f6;text-decoration:none">asante@spectrumfinancialsolution.com</a></td></tr>
  <tr><td><a href="https://spectrumfinancialsolution.com" style="color:#3b82f6;text-decoration:none">spectrumfinancialsolution.com</a></td></tr>
  <tr><td style="padding-top:6px"><a href="${CALENDLY_URL}" style="background:#3b82f6;color:#fff;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:12px">📅 Schedule a Free Consultation</a></td></tr>
</table>`;

  const body = rawBody + sigText;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:600px;margin:0 auto"><p>${rawBody.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</p>${sigHtml}</div>`;

  if (!RESEND_API_KEY) {
    console.log(`   [DRY RUN] Would send to ${toEmail} — Subject: ${subject}`);
    return true;
  }

  // Send via Resend API (no extra npm package needed)
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: `${OWNER_NAME} | ${FIRM_NAME} <outbound@spectrumfinancialsolution.com>`,
      to: [toEmail],
      reply_to: 'asante@spectrumfinancialsolution.com',
      bcc: ['snt.milla@gmail.com'],
      subject,
      text: body,
      html,
      tags: [
        { name: 'lead_id',  value: (business.id || 'unknown').slice(0, 50) },
        { name: 'variant',  value: business.emailVariant || 'A' },
        { name: 'type',     value: 'cold_outreach' },
      ],
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
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── INTENT-BASED LEAD SEARCH (Craigslist) ─────────────────────────────────
// Finds businesses actively posting for bookkeepers/accountants — warm leads

const CRAIGSLIST_MAP = {
  'Fairfield, CA': 'sfbay',    'San Francisco, CA': 'sfbay',
  'Oakland, CA': 'sfbay',      'San Jose, CA': 'sfbay',
  'Sacramento, CA': 'sacramento', 'Fresno, CA': 'fresno',
  'Los Angeles, CA': 'losangeles', 'San Diego, CA': 'sandiego',
  'Long Beach, CA': 'losangeles', 'Anaheim, CA': 'losangeles',
  'Riverside, CA': 'inlandempire', 'Bakersfield, CA': 'bakersfield',
  'Santa Rosa, CA': 'santabarbara', 'Stockton, CA': 'modesto',
  'Denver, CO': 'denver',      'Boulder, CO': 'boulder',
  'Miami, FL': 'miami',        'Orlando, FL': 'orlando',
  'Tampa, FL': 'tampa',        'Jacksonville, FL': 'jacksonville',
  'Atlanta, GA': 'atlanta',    'Chicago, IL': 'chicago',
  'Indianapolis, IN': 'indianapolis',
  'Boston, MA': 'boston',      'Detroit, MI': 'detroit',
  'Minneapolis, MN': 'minneapolis',
  'Kansas City, MO': 'kansascity', 'St. Louis, MO': 'stlouis',
  'Las Vegas, NV': 'lasvegas', 'Albuquerque, NM': 'albuquerque',
  'New York, NY': 'newyork',   'Charlotte, NC': 'charlotte',
  'Raleigh, NC': 'raleigh',    'Columbus, OH': 'columbus',
  'Cleveland, OH': 'cleveland', 'Oklahoma City, OK': 'oklahomacity',
  'Portland, OR': 'portland',  'Philadelphia, PA': 'philadelphia',
  'Pittsburgh, PA': 'pittsburgh',
  'Nashville, TN': 'nashville', 'Memphis, TN': 'memphis',
  'Houston, TX': 'houston',    'Dallas, TX': 'dallas',
  'San Antonio, TX': 'sanantonio', 'Austin, TX': 'austin',
  'Salt Lake City, UT': 'saltlakecity',
  'Seattle, WA': 'seattle',    'Milwaukee, WI': 'milwaukee',
};

const INTENT_KEYWORDS = [
  'bookkeeper', 'accountant', 'bookkeeping', 'accounting help',
  'controller', 'CFO', 'finance manager', 'tax preparer',
  'payroll', 'accounts payable', 'accounts receivable', 'CPA',
];

// ── Source: LinkedIn Jobs (public guest API) ───────────────────────────────
async function searchLinkedInJobs(city) {
  const results = [];
  try {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=bookkeeper+accountant+controller+CFO+payroll&location=${encodeURIComponent(city)}&start=0`;
    const html = await fetchUrl(url);
    const companyRe = /class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([^<]+)\s*<\/a>/g;
    const titleRe   = /class="base-search-card__title"[^>]*>\s*([^<]+)\s*</g;
    const linkRe    = /href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"?]+)/g;
    const companies = [], titles = [], links = [];
    let m;
    while ((m = companyRe.exec(html)) !== null) companies.push(m[1].trim());
    while ((m = titleRe.exec(html))   !== null) titles.push(m[1].trim());
    while ((m = linkRe.exec(html))    !== null) { if (!links.includes(m[1])) links.push(m[1]); }
    for (let i = 0; i < Math.min(companies.length, 5); i++) {
      if (!companies[i]) continue;
      results.push({
        title: titles[i] || 'Bookkeeper / Accountant',
        link: links[i] || url,
        desc: `${companies[i]} is actively hiring for ${titles[i] || 'an accounting role'} in ${city}.`,
        city, keyword: 'bookkeeper', companyName: companies[i],
      });
    }
    console.log(`   [LinkedIn] ${city}: ${results.length} listings`);
  } catch (e) { console.log(`   [LinkedIn] ${e.message}`); }
  return results;
}

// ── Source: Indeed Jobs ────────────────────────────────────────────────────
async function searchIndeedJobs(city) {
  const results = [];
  try {
    const url = `https://www.indeed.com/jobs?q=bookkeeper+accountant+controller+payroll+CFO&l=${encodeURIComponent(city)}&sort=date&fromage=14`;
    const html = await fetchUrl(url);
    const companyRe = /data-company-name="([^"]+)"/g;
    const titleRe   = /"jobTitle"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g;
    const idRe      = /data-jk="([a-f0-9]{16})"/g;
    const companies = [], titles = [], ids = [];
    let m;
    while ((m = companyRe.exec(html)) !== null) companies.push(m[1].trim());
    while ((m = titleRe.exec(html))   !== null) titles.push(m[1].trim());
    while ((m = idRe.exec(html))      !== null) { if (!ids.includes(m[1])) ids.push(m[1]); }
    for (let i = 0; i < Math.min(companies.length, 5); i++) {
      if (!companies[i]) continue;
      results.push({
        title: titles[i] || 'Bookkeeper / Accountant',
        link: ids[i] ? `https://www.indeed.com/viewjob?jk=${ids[i]}` : url,
        desc: `${companies[i]} posted a job for ${titles[i] || 'bookkeeper/accountant'} in ${city} on Indeed.`,
        city, keyword: 'bookkeeper', companyName: companies[i],
      });
    }
    console.log(`   [Indeed] ${city}: ${results.length} listings`);
  } catch (e) { console.log(`   [Indeed] ${e.message}`); }
  return results;
}

// ── Source: ZipRecruiter ───────────────────────────────────────────────────
async function searchZipRecruiter(city) {
  const results = [];
  try {
    const url = `https://www.ziprecruiter.com/candidate/search?search=bookkeeper+accountant&location=${encodeURIComponent(city)}&days=14`;
    const html = await fetchUrl(url);
    const companyRe = /class="[^"]*t_company_name[^"]*"[^>]*>([^<]+)</g;
    const titleRe   = /class="[^"]*job_title[^"]*"[^>]*>([^<]+)</g;
    const linkRe    = /href="(https:\/\/www\.ziprecruiter\.com\/c\/[^"]+)"/g;
    const companies = [], titles = [], links = [];
    let m;
    while ((m = companyRe.exec(html)) !== null) companies.push(m[1].trim());
    while ((m = titleRe.exec(html))   !== null) titles.push(m[1].trim());
    while ((m = linkRe.exec(html))    !== null) { if (!links.includes(m[1])) links.push(m[1]); }
    for (let i = 0; i < Math.min(companies.length, 5); i++) {
      if (!companies[i]) continue;
      results.push({
        title: titles[i] || 'Bookkeeper / Accountant',
        link: links[i] || url,
        desc: `${companies[i]} is hiring for ${titles[i] || 'an accounting role'} in ${city} via ZipRecruiter.`,
        city, keyword: 'bookkeeper', companyName: companies[i],
      });
    }
    console.log(`   [ZipRecruiter] ${city}: ${results.length} listings`);
  } catch (e) { console.log(`   [ZipRecruiter] ${e.message}`); }
  return results;
}

// ── Source: Reddit (public JSON API) ──────────────────────────────────────
async function searchReddit(city) {
  const results = [];
  try {
    const cityName = city.split(',')[0];
    const q = encodeURIComponent(`(bookkeeper OR accountant OR bookkeeping) "${cityName}"`);
    const url = `https://www.reddit.com/search.json?q=${q}&sort=new&t=month&limit=15`;
    const data = JSON.parse(await fetchUrl(url));
    const posts = data?.data?.children || [];
    for (const post of posts) {
      const d = post.data;
      const text = ((d.title || '') + ' ' + (d.selftext || '')).toLowerCase();
      // Only take posts where someone is looking to hire / find accounting help
      if (!/(looking for|need|hiring|want|seeking|recommend|hire|find).{0,40}(bookkeeper|accountant|accounting|bookkeeping)/.test(text)) continue;
      if (d.selftext && d.selftext.length < 30) continue;
      results.push({
        title: d.title,
        link: `https://www.reddit.com${d.permalink}`,
        desc: (d.selftext || '').slice(0, 300),
        city, keyword: 'reddit_intent',
        companyName: null, // extract from post content
        redditAuthor: d.author,
        subreddit: d.subreddit,
      });
    }
    console.log(`   [Reddit] ${city}: ${results.length} relevant posts`);
  } catch (e) { console.log(`   [Reddit] ${e.message}`); }
  return results;
}

// ── Source: Google (new businesses via Places "recently opened") ───────────
async function searchNewBusinesses(city) {
  // Uses existing Google Places but filters for recently opened businesses
  // (few reviews = likely new = needs accounting setup)
  if (!GOOGLE_API) return [];
  const results = [];
  try {
    const industries = ['restaurant', 'retail store', 'salon', 'law firm', 'medical clinic'];
    const industry = industries[Math.floor(Math.random() * industries.length)];
    const places = await searchGooglePlaces(industry, city);
    for (const p of places) {
      if ((p.userRatingsTotal || 999) <= 5) { // Very few reviews = newly opened
        results.push({
          title: `New ${industry} opened in ${city}`,
          link: `https://maps.google.com/?place_id=${p.placeId}`,
          desc: `${p.name} recently opened in ${city} and likely needs accounting setup.`,
          city, keyword: 'new_business',
          companyName: p.name,
          placeData: p,
        });
      }
    }
    console.log(`   [New Business] ${city}: ${results.length} recently opened`);
  } catch (e) { console.log(`   [New Business] ${e.message}`); }
  return results;
}

// ── Source: Glassdoor ──────────────────────────────────────────────────────
async function searchGlassdoor(city) {
  const results = [];
  try {
    const citySlug = city.split(',')[0].toLowerCase().replace(/\s+/g, '-');
    const keywords = ['bookkeeper', 'accountant', 'controller', 'CFO', 'payroll manager', 'finance manager'];
    for (const kw of keywords.slice(0, 3)) {
      const url = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(kw)}&locT=C&locId=0&typedLocation=${encodeURIComponent(city)}&fromAge=14`;
      try {
        const html = await fetchUrl(url);
        // Parse job card titles from Glassdoor HTML
        const titleRe = /<a[^>]+class="[^"]*jobLink[^"]*"[^>]*>([^<]+)<\/a>/gi;
        let m;
        let count = 0;
        while ((m = titleRe.exec(html)) !== null && count < 3) {
          const title = m[1].trim();
          if (!title || title.length < 4) continue;
          results.push({
            title: `${title} — Glassdoor job posting in ${city}`,
            link: url,
            desc: `Company on Glassdoor is hiring a ${title} in ${city}.`,
            city, keyword: kw,
          });
          count++;
        }
      } catch (_) {}
      await sleep(2000);
    }
    console.log(`   [Glassdoor] ${city}: ${results.length} listings`);
  } catch (e) { console.log(`   [Glassdoor] ${e.message}`); }
  return results;
}

// ── Source: Monster ────────────────────────────────────────────────────────
async function searchMonster(city) {
  const results = [];
  try {
    const citySlug = city.split(',')[0].toLowerCase().replace(/\s+/g, '-');
    const stateSlug = (city.split(',')[1] || '').trim().toLowerCase();
    const keywords = ['bookkeeper', 'accountant', 'controller', 'payroll', 'CFO', 'finance manager'];
    for (const kw of keywords.slice(0, 4)) {
      const url = `https://www.monster.com/jobs/search?q=${encodeURIComponent(kw)}&where=${encodeURIComponent(city)}&recency=14`;
      try {
        const html = await fetchUrl(url);
        // Monster job titles are in <h2 class="title"> or similar
        const titleRe = /class="[^"]*title[^"]*"[^>]*>\s*<[^>]+>\s*([A-Za-z][^<]{5,60})<\//gi;
        let m;
        let count = 0;
        while ((m = titleRe.exec(html)) !== null && count < 3) {
          const title = m[1].trim();
          if (!title || /class|script|style/i.test(title)) continue;
          results.push({
            title: `${title} — Monster job posting in ${city}`,
            link: url,
            desc: `Company on Monster.com is hiring a ${title} in ${city}.`,
            city, keyword: kw,
          });
          count++;
        }
      } catch (_) {}
      await sleep(2000);
    }
    console.log(`   [Monster] ${city}: ${results.length} listings`);
  } catch (e) { console.log(`   [Monster] ${e.message}`); }
  return results;
}

// ── Source: Accounting Software Buyers (Reddit/LinkedIn) ──────────────────
async function searchAccountingSoftwareBuyers(city) {
  const results = [];
  try {
    const cityName = city.split(',')[0];
    // Reddit: small businesses asking about QuickBooks / Xero → likely need help
    const queries = [
      `(QuickBooks OR Xero OR "accounting software") "${cityName}" (confused OR help OR mess OR behind OR overwhelmed)`,
      `(bookkeeping OR "catch up" OR "clean up books") "${cityName}"`,
    ];
    for (const q of queries) {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=month&limit=10`;
      try {
        const data = JSON.parse(await fetchUrl(url));
        const posts = data?.data?.children || [];
        for (const post of posts.slice(0, 3)) {
          const d = post.data;
          const text = ((d.title || '') + ' ' + (d.selftext || '')).toLowerCase();
          // Skip if it's someone offering services (we want buyers/seekers)
          if (/i offer|we offer|dm me|hire me|for hire/.test(text)) continue;
          results.push({
            title: d.title,
            link: `https://www.reddit.com${d.permalink}`,
            desc: (d.selftext || '').slice(0, 300),
            city, keyword: 'accounting_software_buyer',
            redditAuthor: d.author,
          });
        }
      } catch (_) {}
      await sleep(1500);
    }
    console.log(`   [Acctg Software] ${city}: ${results.length} signals`);
  } catch (e) { console.log(`   [Acctg Software] ${e.message}`); }
  return results;
}

// ── Source: Bark.com ───────────────────────────────────────────────────────
async function searchBark(city) {
  const results = [];
  try {
    const cityName = city.split(',')[0].trim();
    const stateAbr = (city.split(',')[1] || '').trim();
    // Bark.com service request pages for accounting/bookkeeping
    const services = ['bookkeeper', 'accountant', 'bookkeeping'];
    for (const svc of services.slice(0, 2)) {
      const url = `https://www.bark.com/en/us/${svc}/${cityName.toLowerCase().replace(/\s+/g, '-')}/`;
      try {
        const html = await fetchUrl(url);
        // Bark lists recent client requests with snippets like "Looking for a bookkeeper in Sacramento"
        const reqRe = /<[^>]+class="[^"]*request[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
        const titleRe = /<h\d[^>]*>([^<]{10,120})<\/h\d>/gi;
        let m, count = 0;
        while ((m = titleRe.exec(html)) !== null && count < 4) {
          const title = m[1].replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();
          if (!title || /nav|menu|footer|cookie|sign/i.test(title)) continue;
          results.push({
            title: `${title} — Bark.com request in ${city}`,
            link: url,
            desc: `A business in ${cityName} posted a service request for ${svc} help on Bark.com.`,
            city, keyword: svc,
          });
          count++;
        }
      } catch (_) {}
      await sleep(2000);
    }
    console.log(`   [Bark.com] ${city}: ${results.length} service requests`);
  } catch (e) { console.log(`   [Bark.com] ${e.message}`); }
  return results;
}

// ── Source: Fiverr Buyer Requests ──────────────────────────────────────────
async function searchFiverr(city) {
  // Fiverr buyer requests are behind login, so we search their community
  // and public brief posts for businesses seeking accounting help
  const results = [];
  try {
    const cityName = city.split(',')[0].trim();
    // Search Fiverr's public brief/request pages for accounting needs
    const keywords = ['bookkeeper', 'accountant', 'bookkeeping services'];
    for (const kw of keywords.slice(0, 2)) {
      const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(kw + ' ' + cityName)}&source=top-bar&acmpl=1`;
      try {
        const html = await fetchUrl(url);
        // Fiverr shows gig titles — businesses that HIRED from here likely need ongoing help
        // Look for buyer brief mentions or local service requests
        const titleRe = /aria-label="([^"]{15,100})"/gi;
        let m, count = 0;
        while ((m = titleRe.exec(html)) !== null && count < 3) {
          const title = m[1].trim();
          if (!/(bookkeep|account|quickbooks|xero|tax|payroll)/i.test(title)) continue;
          results.push({
            title: `${title} — Fiverr buyer request`,
            link: `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(kw)}`,
            desc: `Business on Fiverr seeking ${kw} help — likely needs a professional ongoing solution.`,
            city, keyword: kw,
          });
          count++;
        }
      } catch (_) {}
      await sleep(2000);
    }
    console.log(`   [Fiverr] ${city}: ${results.length} buyer signals`);
  } catch (e) { console.log(`   [Fiverr] ${e.message}`); }
  return results;
}

// ── Source: Craigslist Services Wanted (individuals seeking accounting help) ──
async function searchCraigslistServicesWanted(city) {
  const subdomain = CRAIGSLIST_MAP[city];
  if (!subdomain) return [];
  const results = [];
  const keywords = ['accountant', 'bookkeeper', 'tax', 'cpa', 'bookkeeping', 'payroll'];
  for (const kw of keywords.slice(0, 3)) {
    // Search "sss" (services offered) and "bbb" (barter) and general search for wanted posts
    const urls = [
      `https://${subdomain}.craigslist.org/search/sss?format=rss&query=${encodeURIComponent('need ' + kw)}`,
      `https://${subdomain}.craigslist.org/search/bbb?format=rss&query=${encodeURIComponent(kw)}`,
    ];
    for (const url of urls) {
      try {
        const html = await fetchUrl(url);
        const items = parseRssItems(html);
        for (const item of items.slice(0, 3)) {
          if (!/(need|looking|seeking|want|help|hire|find)/i.test(item.title + item.desc)) continue;
          results.push({ ...item, city, keyword: kw, isIndividual: true });
        }
      } catch (_) {}
      await sleep(800);
    }
  }
  if (results.length) console.log(`   [CL-Services] ${city}: ${results.length} individual requests`);
  return results;
}

// ── Source: Thumbtack Project Requests ────────────────────────────────────
async function searchThumbstack(city) {
  const results = [];
  try {
    const citySlug = city.split(',')[0].trim().toLowerCase().replace(/\s+/g, '-');
    const state = city.split(',')[1]?.trim().toLowerCase() || '';
    const services = ['bookkeeping', 'tax-preparation', 'accounting'];
    for (const svc of services.slice(0, 2)) {
      const url = `https://www.thumbtack.com/${state}/${citySlug}/${svc}/`;
      try {
        const html = await fetchUrl(url);
        // Extract professional listings — these are pros responding to individual requests
        const nameRe = /"name"\s*:\s*"([^"]{3,60})"/g;
        const reviewRe = /(\d+)\s*review/gi;
        let m, count = 0;
        const names = new Set();
        while ((m = nameRe.exec(html)) !== null && count < 4) {
          const name = m[1].trim();
          if (name.length < 4 || names.has(name)) continue;
          // Thumbtack pros serve local clients — these are warm leads (they serve the area)
          // We can reach out to the individuals who HIRED these pros
          names.add(name);
          results.push({
            title: `Individual seeking ${svc.replace('-', ' ')} — ${city}`,
            link: url,
            desc: `Active ${svc.replace('-', ' ')} requests on Thumbtack in ${city}. Local individuals actively seeking professional help.`,
            city, keyword: svc, isIndividual: true,
            companyName: null,
          });
          count++;
          break; // one signal per service is enough
        }
      } catch (_) {}
      await sleep(1500);
    }
    if (results.length) console.log(`   [Thumbtack] ${city}: ${results.length} service request signals`);
  } catch (e) { console.log(`   [Thumbtack] ${e.message}`); }
  return results;
}

// ── Source: Reddit Personal Finance (individuals seeking help) ────────────
async function searchRedditIndividuals(city) {
  const results = [];
  const cityName = city.split(',')[0].trim();
  const subs = ['personalfinance', 'tax', 'smallbusiness', 'Accounting'];
  const keywords = [`accountant ${cityName}`, `bookkeeper ${cityName}`, `cpa ${cityName}`, `tax help ${cityName}`, `payroll help ${cityName}`, `controller ${cityName}`];
  for (const kw of keywords.slice(0, 3)) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(kw)}&sort=new&t=month&limit=5`;
    try {
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw);
      const posts = (data.data?.children || []).map(c => c.data).filter(p =>
        /(need|looking|recommend|suggest|find|help|hire|advice)/i.test(p.title + ' ' + (p.selftext||''))
      );
      for (const p of posts.slice(0, 2)) {
        results.push({
          title: p.title,
          link: `https://reddit.com${p.permalink}`,
          desc: (p.selftext || '').slice(0, 300),
          city, keyword: kw, isIndividual: true,
          companyName: null,
        });
      }
    } catch (_) {}
    await sleep(1500);
  }
  if (results.length) console.log(`   [Reddit-Indiv] ${city}: ${results.length} individual posts`);
  return results;
}

// ── Aggregate all intent sources ───────────────────────────────────────────
async function searchAllIntentSources(city) {
  const sources = [
    { name: 'craigslist',         fn: searchCraigslist },
    { name: 'linkedin',           fn: searchLinkedInJobs },
    { name: 'indeed',             fn: searchIndeedJobs },
    { name: 'ziprecruiter',       fn: searchZipRecruiter },
    { name: 'glassdoor',          fn: searchGlassdoor },
    { name: 'monster',            fn: searchMonster },
    { name: 'bark',               fn: searchBark },
    // Fiverr removed — JS-rendered, always returns 0; buyer requests require login
    { name: 'reddit',             fn: searchReddit },
    { name: 'cl_services',        fn: searchCraigslistServicesWanted },
    { name: 'thumbtack',          fn: searchThumbstack },
    { name: 'reddit_indiv',       fn: searchRedditIndividuals },
    { name: 'acctg_software',     fn: searchAccountingSoftwareBuyers },
    { name: 'new_business',       fn: searchNewBusinesses },
  ];
  const all = [];
  for (const src of sources) {
    try {
      // Hard 20-second wall-clock timeout per source so one hanging site can't block the rest
      const items = await Promise.race([
        src.fn(city),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Source timeout')), 20000)),
      ]);
      all.push(...items.map(i => ({ ...i, intentSource: src.name })));
    } catch (e) {
      console.log(`   [Intent/${src.name}] Skipped: ${e.message}`);
    }
    await sleep(1000);
  }
  return all;
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([^<]*)<\\/${tag}>`).exec(block);
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title = get('title');
    const link  = get('link') || (/<link\s*\/?>(.*?)<\/link>/.exec(block) || [])[1] || '';
    const desc  = get('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (title && link) items.push({ title, link, desc });
  }
  return items;
}

async function searchCraigslist(city) {
  const subdomain = CRAIGSLIST_MAP[city];
  if (!subdomain) return [];

  const results = [];
  for (const kw of INTENT_KEYWORDS.slice(0, 2)) {
    const url = `https://${subdomain}.craigslist.org/search/acc?format=rss&query=${encodeURIComponent(kw)}`;
    try {
      const xml = await fetchUrl(url);
      const items = parseRssItems(xml);
      for (const item of items.slice(0, 4)) results.push({ ...item, city, keyword: kw });
    } catch (e) {
      // Craigslist may throttle — skip silently
    }
    await sleep(1500);
  }
  return results;
}

function intentAlreadyProcessed(listingUrl) {
  // Only block listings processed in the last 30 days — allows re-finding fresh postings
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const leads = loadLeads();
  return leads.some(l =>
    l.listingUrl === listingUrl &&
    (l.foundAt || l.updatedAt || '') >= cutoff
  );
}

async function generateIntentEmail(business, listingContext, variant = 'A') {
  // Individual seekers get a personal, warm email — not a business pitch
  if (business.isIndividual) {
    const need = (business.listingTitle || business.keyword || 'accounting help').replace(/[-_]/g, ' ');
    const promptIndiv = `Write a short, warm, personal email from ${OWNER_NAME}, CPA at ${FIRM_NAME} to someone who posted online looking for help with ${need}.

Context of their post: "${(listingContext || '').slice(0, 200)}"
City: ${business.city}

Rules:
- Subject line first: Subject: <friendly subject referencing their specific need>
- 2-3 sentences only — friendly, NOT salesy, like a neighbor who happens to be a CPA
- Acknowledge their specific need (${need})
- Mention ${FIRM_NAME} offers a FREE 30-minute consultation: ${CALENDLY_URL}
- Tone: warm, human, helpful — they're an individual not a corporate buyer
- Do NOT mention salary, hiring, or job postings
- Do NOT include a sign-off or signature — added automatically
- Write ONLY the email body`;
    const payload = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: promptIndiv }] });
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { const j = JSON.parse(data); if (j.error) return reject(new Error(j.error.message)); resolve(j.content[0].text.trim()); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.write(payload); req.end();
    });
  }

  // Extract a clean role title from the listing (e.g. "Senior Bookkeeper" from a long title)
  const roleTitle = (business.listingTitle || '')
    .replace(/\s*[-–|].*$/, '')       // strip everything after a dash or pipe
    .replace(/\s*\(.*?\)/g, '')        // strip parenthetical notes
    .trim()
    .slice(0, 60) || 'bookkeeper/accountant';

  const promptA = `Write a brief, warm outreach email from ${OWNER_NAME} at ${FIRM_NAME} to a business that posted a job listing for a "${roleTitle}".

Business name: ${business.name}
City: ${business.city}
Role they're hiring for: "${roleTitle}"
Listing context: "${listingContext.slice(0, 200)}"

Rules:
- First line must be: Subject: <subject referencing their specific "${roleTitle}" search>
- 3 short paragraphs, conversational tone, NOT salesy
- Mention their search for a "${roleTitle}" to show this is personal, not a mass email
- Position ${FIRM_NAME} as a smarter alternative to hiring full-time (outsourced/fractional accounting)
- Offer a FREE 30-minute consultation: ${CALENDLY_URL}
- Do NOT mention salary ranges or compensation figures
- Do NOT include a sign-off or signature — it will be added automatically
- Write ONLY the email body, no preamble, no sign-off`;

  const promptB = `Write a short, punchy outreach email from ${OWNER_NAME} at ${FIRM_NAME} to a business posting a "${roleTitle}" job.

Business name: ${business.name}
City: ${business.city}
Role they're posting for: "${roleTitle}"

Angle: We saw their listing — position ${FIRM_NAME} as the smarter, faster alternative to the full hiring cycle (posting, interviewing, onboarding takes months).

Rules:
- First line: Subject: <bold subject line referencing the "${roleTitle}" role they're hiring for>
- 2 paragraphs only — lead with empathy for the hiring burden, end with a soft ask
- Offer FREE 30-minute call: ${CALENDLY_URL}
- Do NOT mention salary ranges or compensation figures
- Do NOT include a sign-off or signature — it will be added automatically
- Write ONLY the email body`;

  const prompt = variant === 'B' ? promptB : promptA;

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
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content[0].text.trim());
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runIntentSearches(cities) {
  console.log('\n🎯 Intent Search — businesses AND individuals actively seeking accounting help');
  console.log('   Sources: Craigslist · LinkedIn · Indeed · ZipRecruiter · Glassdoor · Monster · Bark · Reddit · CL Services · Thumbtack · Reddit (Personal) · Acctg Software · New Businesses\n');
  let intentFound = 0, intentEmailed = 0;

  for (const city of cities) {
    const listings = await searchAllIntentSources(city);
    if (!listings.length) continue;
    console.log(`   [Intent] ${city}: ${listings.length} total signals across all sources`);

    for (const listing of listings.slice(0, 5)) {
      if (intentAlreadyProcessed(listing.link)) continue;

      // Use company name from source if available (LinkedIn/Indeed/ZipRecruiter provide it directly)
      // Otherwise extract from listing title (Craigslist)
      let companyName = listing.companyName || null;
      if (!companyName) {
        const nameMatch = listing.title.match(/(?:for|at|@|-)\s+(.{3,40})$/i);
        companyName = nameMatch
          ? nameMatch[1].replace(/[^\w\s&'.-]/g, '').trim()
          : listing.title.replace(/bookkeeper|accountant|needed|wanted|looking|hire|part.?time|full.?time/gi, '').trim().slice(0, 40);
      }

      const biz = {
        id: `il_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        name: companyName || 'Local Business',
        city: listing.city,
        industry: 'intent_lead',
        source: listing.intentSource || 'intent',
        listingUrl: listing.link,
        listingTitle: listing.title,
        placeId: `cl_${Buffer.from(listing.link).toString('base64').slice(0,16)}`,
        website: null, phone: null, email: null,
        status: 'found',
        foundAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Try to find their website + email via Google Places
      if (GOOGLE_API && companyName && companyName.length > 3) {
        try {
          const places = await searchGooglePlaces(companyName, city);
          if (places.length > 0) {
            const details = await getPlaceDetails(places[0].placeId);
            biz.website = details.website || places[0].website || null;
            biz.phone   = details.formatted_phone_number || places[0].phone || null;
          }
        } catch (_) {}
      }

      let email = null;
      if (biz.website) email = await findEmailOnWebsite(biz.website);

      if (!email) {
        biz.status = biz.website ? 'no_email' : 'no_website';
        saveLead(biz);
        console.log(`   ✗ [Intent] ${biz.name} — no email found`);
        continue;
      }

      if (alreadyEmailedAddress(email)) {
        console.log(`   ✗ [Intent] ${biz.name} — already emailed this address`);
        continue;
      }

      biz.email = email;
      biz.score = scoreLead(biz);
      biz.emailVariant = Math.random() < 0.5 ? 'A' : 'B';
      intentFound++;

      let emailContent;
      try {
        emailContent = await generateIntentEmail(biz, listing.desc, biz.emailVariant);
      } catch (err) {
        biz.status = 'error'; biz.error = err.message;
        saveLead(biz);
        continue;
      }

      try {
        await sendColdEmail(email, emailContent, biz);
        biz.status = 'emailed';
        biz.emailSentAt = new Date().toISOString();
        biz.emailContent = emailContent;
        await syncLeadToHubSpot(biz);
        console.log(`   ✅ [Intent] ${biz.name} → ${email} (actively seeking accounting help)`);
        intentEmailed++;
      } catch (err) {
        biz.status = 'send_error'; biz.error = err.message;
      }

      saveLead(biz);
      if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
    }
    await sleep(2000);
  }

  console.log(`   Intent search done — ${intentFound} leads found, ${intentEmailed} emailed\n`);
  return { intentFound, intentEmailed };
}

// ── Dashboard Command Queue ────────────────────────────────────────────────
const RAILWAY_HOSTNAME = 'accounting-agent-production-cf69.up.railway.app';

function railwayRequest(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: RAILWAY_HOSTNAME,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', e => { console.log('[Commands] HTTP error:', e.message); resolve({ status: 0, body: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function markCommand(id, status, result) {
  await railwayRequest('PATCH', `/api/commands/${id}`, { status, result });
}

async function runQueuedCommands() {
  console.log('[Commands] Checking for queued dashboard commands...');
  const res = await railwayRequest('GET', '/api/commands');
  if (!res.body || !Array.isArray(res.body)) {
    console.log('[Commands] Could not reach command queue — skipping');
    return;
  }
  const pending = res.body.filter(c => c.status === 'pending');
  if (!pending.length) { console.log('[Commands] No pending commands'); return; }
  console.log(`[Commands] Found ${pending.length} pending command(s)`);

  for (const cmd of pending) {
    console.log(`[Commands] ▶ ${cmd.type}: ${cmd.label}`);
    await markCommand(cmd.id, 'running', 'Agent picked up command…');
    try {
      let result = '';

      if (cmd.type === 'search-city') {
        const city = (cmd.params && cmd.params.city) || '';
        const individualsOnly = !!(cmd.params && cmd.params.individualsOnly);
        if (!city) { await markCommand(cmd.id, 'error', 'No city specified'); continue; }
        const { intentFound, intentEmailed } = await runIntentSearches([city]);
        result = `Found ${intentFound} leads, emailed ${intentEmailed} in ${city}`;
        const all = loadLeads();
        await syncLeadsToRailway(all);

      } else if (cmd.type === 'run-schedule') {
        await runFollowUps();
        const { intentFound, intentEmailed } = await runIntentSearches(ALL_CITIES);
        const all = loadLeads();
        await pushLeadsToGitHub(all);
        await syncLeadsToRailway(all);
        result = `Schedule complete — found ${intentFound} leads, emailed ${intentEmailed}, follow-ups sent`;

      } else if (cmd.type === 'send-followups') {
        await runFollowUps();
        result = 'Follow-up emails sent';

      } else if (cmd.type === 'sync-now') {
        const all = loadLeads();
        await syncLeadsToRailway(all);
        result = `Synced ${all.length} leads to dashboard`;

      } else if (cmd.type === 'text') {
        // Free-text that wasn't parsed on the frontend — try to interpret it
        const t = (cmd.params && cmd.params.text || '').toLowerCase();
        if (t.includes('follow')) {
          await runFollowUps();
          result = 'Follow-up emails sent';
        } else if (t.includes('sync')) {
          await syncLeadsToRailway(loadLeads());
          result = `Synced ${loadLeads().length} leads`;
        } else if (t.includes('run') || t.includes('schedule')) {
          await runFollowUps();
          const { intentFound, intentEmailed } = await runIntentSearches(ALL_CITIES);
          result = `Schedule done — found ${intentFound}, emailed ${intentEmailed}`;
        } else {
          result = `Command not understood: "${cmd.params && cmd.params.text}"`;
        }
      } else {
        result = `Unknown command type: ${cmd.type}`;
      }

      await markCommand(cmd.id, 'done', result);
      console.log(`[Commands] ✅ Done: ${result}`);
    } catch (e) {
      await markCommand(cmd.id, 'error', e.message);
      console.log(`[Commands] ❌ Error: ${e.message}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  // Handle --reset flag
  if (process.argv.includes('--reset')) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ completed: [], nextIndex: 0 }, null, 2));
    console.log('✅ Progress reset. Run again without --reset to start fresh.');
    return;
  }

  // Handle --run-commands flag (called by command-watcher.js for immediate execution)
  if (process.argv.includes('--run-commands')) {
    await runQueuedCommands();
    return;
  }

  // ── Check for queued dashboard commands before anything else ────────────
  await runQueuedCommands();

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Spectrum Financial Solutions — Outbound Agent       ║');
  console.log(`║  ${new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }).padEnd(52)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
  console.log(`🗺️  Coverage : All 50 US states (${ALL_CITIES.length} cities × ${INDUSTRIES.length} industries = ${(ALL_CITIES.length * INDUSTRIES.length).toLocaleString()} total searches)`);
  console.log(`📧 Mailer   : ${RESEND_API_KEY ? 'Resend live ✅' : 'DRY RUN (no RESEND_API_KEY)'}`);
  console.log(`🗺️  Google   : ${GOOGLE_API ? 'Places API ✅' : 'No key — Yellow Pages fallback'}\n`);

  // Intent-only mode: skip random industry searches, target only businesses
  // actively hiring accountants/bookkeepers on job boards
  const todayCities = ALL_CITIES;
  let totalFound = 0, totalEmailed = 0;

  // Send follow-ups to leads from 3-5 days ago
  await runFollowUps();

  // Run intent-based searches across all cities
  const { intentFound, intentEmailed } = await runIntentSearches(todayCities);
  totalFound += intentFound;
  totalEmailed += intentEmailed;

  const all = loadLeads();
  const totalEver = all.filter(l => l.status === 'emailed').length;
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  Today's run complete                                ║`);
  console.log(`║  New leads found      : ${String(totalFound).padEnd(28)}║`);
  console.log(`║  Emails sent today    : ${String(totalEmailed).padEnd(28)}║`);
  console.log(`║  Total leads in DB    : ${String(all.length).padEnd(28)}║`);
  console.log(`║  Total emailed ever   : ${String(totalEver).padEnd(28)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Sync leads to GitHub (persistence across Railway deploys)
  await pushLeadsToGitHub(all);

  // Push directly to live Railway server so dashboard updates immediately
  await syncLeadsToRailway(all);
}

// ── HubSpot CRM sync ───────────────────────────────────────────────────────
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || '';

function hubspotRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
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

async function syncLeadToHubSpot(lead) {
  if (!HUBSPOT_API_KEY) return;
  try {
    const nameParts = (lead.name || '').split(' ');
    const props = {
      email:          lead.email,
      firstname:      nameParts[0] || lead.name || '',
      lastname:       nameParts.slice(1).join(' ') || '',
      phone:          lead.phone || '',
      website:        lead.website || '',
      company:        lead.name || '',
      hs_lead_status: 'IN_PROGRESS',
      lifecyclestage: 'lead',
    };

    // Search for existing contact by email
    const search = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] }],
      properties: ['email', 'hs_object_id'],
    });

    let contactId;
    if (search.body.total > 0) {
      contactId = search.body.results[0].id;
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: props });
      console.log(`   [HubSpot] Updated contact ${contactId} for ${lead.name || lead.email}`);
    } else {
      const created = await hubspotRequest('POST', '/crm/v3/objects/contacts', { properties: props });
      if (created.body.id) {
        contactId = created.body.id;
        console.log(`   [HubSpot] Created contact ${contactId} for ${lead.name || lead.email}`);
      } else {
        console.log(`   [HubSpot] Contact creation failed (status ${created.status}): ${JSON.stringify(created.body)}`);
        return;
      }
    }

    // Create a deal if this lead was emailed
    if (lead.status === 'emailed' && contactId) {
      const dealName = `${lead.name || lead.email} — Outbound`;
      const dealSearch = await hubspotRequest('POST', '/crm/v3/objects/deals/search', {
        filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: dealName }] }],
      });
      if (dealSearch.body.total === 0) {
        const deal = await hubspotRequest('POST', '/crm/v3/objects/deals', {
          properties: {
            dealname:  dealName,
            pipeline:  'default',
            dealstage: 'appointmentscheduled',
            closedate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
        });
        if (deal.body.id) {
          // Associate deal to contact using v4 associations API
          await hubspotRequest('PUT',
            `/crm/v4/objects/deals/${deal.body.id}/associations/contacts/${contactId}/3`,
            null
          );
          console.log(`   [HubSpot] Deal created and linked to contact`);
        } else {
          console.log(`   [HubSpot] Deal creation failed: ${JSON.stringify(deal.body)}`);
        }
      }
    }
    console.log(`   [HubSpot] Sync complete for ${lead.name || lead.email}`);
  } catch (e) {
    console.log(`   [HubSpot] Sync error: ${e.message}`);
  }
}

// ── GitHub sync ────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'amuyungga';
const GITHUB_REPO  = 'accounting-agent';
const GITHUB_PATH  = 'outbound-leads.json';

async function pushLeadsToGitHub(leads) {
  console.log('[GitHub] Syncing leads to repo...');
  const content = JSON.stringify(leads);
  const encoded = Buffer.from(content).toString('base64');
  const emailed = leads.filter(l => l.status === 'emailed').length;

  return new Promise((resolve) => {
    // First GET to retrieve current SHA (needed for update, not needed for create)
    const getReq = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'spectrum-outbound-agent',
        'Accept': 'application/vnd.github.v3+json',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let sha;
        try { sha = JSON.parse(data).sha; } catch (_) {}
        const body = JSON.stringify({
          message: `data: sync ${leads.length} leads (${emailed} emailed)`,
          content: encoded,
          ...(sha ? { sha } : {}),
        });
        const putReq = https.request({
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`,
          method: 'PUT',
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'User-Agent': 'spectrum-outbound-agent',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
        }, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            if (r.statusCode === 200 || r.statusCode === 201) {
              const commit = JSON.parse(d).commit;
              console.log(`[GitHub] Synced ${leads.length} leads → commit ${commit && commit.sha && commit.sha.slice(0,7)}`); 
            } else {
              console.log(`[GitHub] Sync failed: HTTP ${r.statusCode}`);
            }
            resolve();
          });
        });
        putReq.on('error', e => { console.log('[GitHub] Error:', e.message); resolve(); });
        putReq.write(body);
        putReq.end();
      });
    });
    getReq.on('error', e => { console.log('[GitHub] Error:', e.message); resolve(); });
    getReq.end();
  });
}

// ── Railway sync ────────────────────────────────────────────────────────────
async function syncLeadsToRailway(leads) {
  const SYNC_SECRET = process.env.SYNC_SECRET || 'spectrum-sync';

  if (!leads.length) {
    console.log('[Railway] No leads to sync');
    return;
  }

  // Send in chunks of 100 to stay well under Railway proxy limits
  const CHUNK_SIZE = 100;
  const chunks = [];
  for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
    chunks.push(leads.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[Railway] Syncing ${leads.length} leads in ${chunks.length} chunk(s)...`);

  const postChunk = (chunk) => new Promise((resolve) => {
    const body = JSON.stringify(chunk);
    const req = https.request({
      hostname: 'accounting-agent-production-cf69.up.railway.app',
      path: '/outbound-leads/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-sync-key': SYNC_SECRET,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(d);
            console.log(`[Railway] ✅ Chunk synced — merged ${result.merged} new, total ${result.total}`);
          } catch {
            console.log(`[Railway] ✅ Chunk OK (HTTP 200)`);
          }
        } else {
          console.log(`[Railway] ❌ Chunk failed: HTTP ${res.statusCode} — ${d.slice(0, 200)}`);
        }
        resolve();
      });
    });
    req.on('error', e => { console.log('[Railway] ❌ Connection error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });

  try {
    for (const chunk of chunks) {
      await postChunk(chunk);
    }
  } catch (e) {
    console.log('[Railway] Error:', e.message);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────
run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
