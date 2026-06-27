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
- Sign off: ${OWNER_NAME} | ${FIRM_NAME}
- Do NOT start with "I hope this email finds you well" or similar filler
- Write ONLY the email. No preamble.`;

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
  const subject = subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : `A quick note for ${business.name}`;
  const body = lines.filter(l => !/^subject:/i.test(l)).join('\n').trim();
  const html = `<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:600px;margin:0 auto">${body.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')}</div>`;

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
const GITHUB_TOKEN = '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';
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
