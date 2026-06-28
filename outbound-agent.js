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
const DAILY_SEARCH_LIMIT = 10;   // city+industry combinations per run
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
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  return record;
}

function alreadyProcessed(placeId) {
  const leads = loadLeads();
  const lead = leads.find(l => l.placeId === placeId);
  return lead && lead.status !== 'found';
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
async function generateColdEmail(business) {
  const prompt = `Write a brief, warm cold outreach email from ${OWNER_NAME} at ${FIRM_NAME} (a CPA & financial advisory firm) to the owner/manager of "${business.name}" — a ${business.industry} in ${business.city || business.address}.

Rules:
- First line must be: Subject: <compelling, specific subject line>
- 3 short paragraphs max, conversational tone, NOT salesy or generic
- Mention their industry (${business.industry}) and a relevant financial pain point (e.g., tax deadlines, payroll complexity, cash flow, bookkeeping overhead)
- Offer a FREE 30-minute consultation
- Weave in this booking link naturally: ${CALENDLY_URL}
- Do NOT include a sign-off or signature — it will be added automatically
- Do NOT start with "I hope this email finds you well" or similar filler
- Write ONLY the email body. No preamble, no sign-off.`;

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
  const sigText = `\n\n--\nAsante Muyungga\nFounder and CEO | Spectrum Financial Solutions\nasante@spectrumfinancialsolution.com\nspectrumfinancialsolution.com\nSchedule a free 30-min call: ${CALENDLY_URL}`;
  const sigHtml = `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
<table style="font-family:Arial,sans-serif;font-size:13px;color:#475569">
  <tr><td><strong style="font-size:14px;color:#1e293b">Asante Muyungga</strong></td></tr>
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

const INTENT_KEYWORDS = ['bookkeeper', 'accountant', 'bookkeeping', 'accounting help'];

// ── Source: LinkedIn Jobs (public guest API) ───────────────────────────────
async function searchLinkedInJobs(city) {
  const results = [];
  try {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=bookkeeper+accountant&location=${encodeURIComponent(city)}&start=0`;
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
    const url = `https://www.indeed.com/jobs?q=bookkeeper+accountant&l=${encodeURIComponent(city)}&sort=date&fromage=14`;
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

// ── Aggregate all intent sources ───────────────────────────────────────────
async function searchAllIntentSources(city) {
  const sources = [
    { name: 'craigslist',    fn: searchCraigslist },
    { name: 'linkedin',      fn: searchLinkedInJobs },
    { name: 'indeed',        fn: searchIndeedJobs },
    { name: 'ziprecruiter',  fn: searchZipRecruiter },
    { name: 'reddit',        fn: searchReddit },
    { name: 'new_business',  fn: searchNewBusinesses },
  ];
  const all = [];
  for (const src of sources) {
    try {
      const items = await src.fn(city);
      all.push(...items.map(i => ({ ...i, intentSource: src.name })));
    } catch (e) {
      console.log(`   [Intent/${src.name}] Error: ${e.message}`);
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
  const leads = loadLeads();
  return leads.some(l => l.listingUrl === listingUrl);
}

async function generateIntentEmail(business, listingContext) {
  const prompt = `Write a brief, warm outreach email from ${OWNER_NAME} at ${FIRM_NAME} to a business that posted a job listing looking for a bookkeeper or accountant.

Business name: ${business.name}
City: ${business.city}
Their listing title: "${business.listingTitle}"
Listing context: "${listingContext.slice(0, 200)}"

Rules:
- First line must be: Subject: <specific subject line mentioning their search>
- 3 short paragraphs, conversational tone, NOT salesy
- Reference that we saw they're actively looking for bookkeeping/accounting help
- Position ${FIRM_NAME} as a smarter alternative to hiring full-time (outsourced/fractional, saves 40-60% vs employee)
- Offer a FREE 30-minute consultation and weave in: ${CALENDLY_URL}
- Do NOT include a sign-off or signature — it will be added automatically
- Write ONLY the email body, no preamble, no sign-off`;

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
  console.log('\n🎯 Intent Search — businesses actively seeking accounting help');
  console.log('   Sources: Craigslist · LinkedIn · Indeed · ZipRecruiter · Reddit · New Businesses\n');
  let intentFound = 0, intentEmailed = 0;

  for (const city of cities.slice(0, 3)) {
    const listings = await searchAllIntentSources(city);
    if (!listings.length) continue;
    console.log(`   [Intent] ${city}: ${listings.length} total signals across all sources`);

    for (const listing of listings.slice(0, 3)) {
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

      biz.email = email;
      intentFound++;

      let emailContent;
      try {
        emailContent = await generateIntentEmail(biz, listing.desc);
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

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  // Handle --reset flag
  if (process.argv.includes('--reset')) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ completed: [], nextIndex: 0 }, null, 2));
    console.log('✅ Progress reset. Run again without --reset to start fresh.');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Spectrum Financial Solutions — Outbound Agent       ║');
  console.log(`║  ${new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }).padEnd(52)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
  console.log(`🗺️  Coverage : All 50 US states (${ALL_CITIES.length} cities × ${INDUSTRIES.length} industries = ${(ALL_CITIES.length * INDUSTRIES.length).toLocaleString()} total searches)`);
  console.log(`📧 Mailer   : ${RESEND_API_KEY ? 'Resend live ✅' : 'DRY RUN (no RESEND_API_KEY)'}`);
  console.log(`🗺️  Google   : ${GOOGLE_API ? 'Places API ✅' : 'No key — Yellow Pages fallback'}\n`);

  const searches = getNextSearches(DAILY_SEARCH_LIMIT);
  // Also grab the cities from today's searches for intent targeting
  const todayCities = [...new Set(searches.map(s => s.city))];
  let totalFound = 0, totalEmailed = 0;

  for (const { city, industry } of searches) {
    console.log(`\n── ${industry} · ${city} ──`);

    let businesses = [];
    if (GOOGLE_API) {
      businesses = await searchGooglePlaces(industry, city);
      for (const biz of businesses.slice(0, MAX_LEADS_PER_SEARCH)) {
        if (!biz.website || !biz.phone) {
          const details = await getPlaceDetails(biz.placeId);
          biz.website = biz.website || details.website || null;
          biz.phone   = biz.phone   || details.formatted_phone_number || null;
        }
        await sleep(250);
      }
    } else {
      businesses = await searchYellowPages(industry, city);
    }

    businesses = businesses.slice(0, MAX_LEADS_PER_SEARCH);
    console.log(`   Found ${businesses.length} businesses`);

    for (const biz of businesses) {
      if (alreadyProcessed(biz.placeId)) { continue; }
      totalFound++;
      saveLead(biz);

      // Find email
      let email = null;
      if (biz.website) {
        email = await findEmailOnWebsite(biz.website);
      }

      if (!email) {
        saveLead({ ...biz, status: biz.website ? 'no_email' : 'no_website' });
        console.log(`   ✗ ${biz.name} — no email`);
        continue;
      }

      biz.email = email;
      saveLead({ ...biz, email, status: 'email_found' });

      // Generate email
      let emailContent;
      try {
        emailContent = await generateColdEmail(biz);
      } catch (err) {
        saveLead({ ...biz, status: 'error', error: err.message });
        console.log(`   ✗ ${biz.name} — Claude error: ${err.message}`);
        continue;
      }

      // Send
      try {
        await sendColdEmail(email, emailContent, biz);
        saveLead({ ...biz, status: 'emailed', emailSentAt: new Date().toISOString(), emailContent });
        console.log(`   ✅ ${biz.name} → ${email}`);
        totalEmailed++;
      } catch (err) {
        saveLead({ ...biz, status: 'send_error', error: err.message });
        console.log(`   ✗ ${biz.name} — send error: ${err.message}`);
      }

      if (RESEND_API_KEY) await sleep(EMAIL_DELAY_MS);
    }

    await sleep(1000);
  }

  // Run intent-based searches for today's cities
  const { intentFound, intentEmailed } = await runIntentSearches(todayCities);
  totalFound += intentFound;
  totalEmailed += intentEmailed;

  const all = loadLeads();
  const totalEver = all.filter(l => l.status === 'emailed').length;
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  Today's run complete                                ║`);
  console.log(`║  Searches run today   : ${String(searches.length).padEnd(28)}║`);
  console.log(`║  New leads found      : ${String(totalFound).padEnd(28)}║`);
  console.log(`║  Emails sent today    : ${String(totalEmailed).padEnd(28)}║`);
  console.log(`║  Total leads in DB    : ${String(all.length).padEnd(28)}║`);
  console.log(`║  Total emailed ever   : ${String(totalEver).padEnd(28)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Sync leads to GitHub so Railway always has current data after deploy
  await pushLeadsToGitHub(all);
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

run().catch(err => {
  console.error('\n[Fatal Error]', err.message);
  process.exit(1);
});
