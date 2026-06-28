// One-time backfill: pushes all emailed leads from outbound-leads.json to HubSpot
require('dotenv').config();
const fs   = require('fs');
const https = require('https');

const KEY  = process.env.HUBSPOT_API_KEY;
if (!KEY) { console.error('No HUBSPOT_API_KEY in .env'); process.exit(1); }

function hs(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com', path, method,
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const leads = JSON.parse(fs.readFileSync('./outbound-leads.json', 'utf8'))
    .filter(l => l.email && ['emailed','follow_up_sent','replied'].includes(l.status));

  console.log(`Syncing ${leads.length} leads to HubSpot...\n`);
  let created = 0, updated = 0, failed = 0;

  for (const lead of leads) {
    try {
      const nameParts = (lead.name || '').split(' ');
      const props = {
        email:          lead.email,
        firstname:      nameParts[0] || lead.name || '',
        lastname:       nameParts.slice(1).join(' ') || '',
        phone:          lead.phone || '',
        website:        lead.website || '',
        company:        lead.name || '',
        hs_lead_status: lead.replied ? 'CONNECTED' : lead.clicked ? 'IN_PROGRESS' : lead.openCount ? 'OPEN' : 'IN_PROGRESS',
        lifecyclestage: 'lead',
      };

      // Search for existing contact
      const search = await hs('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] }],
        properties: ['email'],
      });

      let contactId;
      if (search.body.total > 0) {
        contactId = search.body.results[0].id;
        await hs('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: props });
        updated++;
        console.log(`  ↻ Updated: ${lead.name} (${lead.email})`);
      } else {
        const created_res = await hs('POST', '/crm/v3/objects/contacts', { properties: props });
        if (created_res.body.id) {
          contactId = created_res.body.id;
          created++;
          console.log(`  ✅ Created: ${lead.name} (${lead.email})`);
        } else {
          failed++;
          console.log(`  ✗ Failed: ${lead.name} — ${JSON.stringify(created_res.body).slice(0,120)}`);
          continue;
        }
      }

      // Create deal if contact was created
      if (contactId && lead.status === 'emailed') {
        const dealName = `${lead.name || lead.email} — Outbound`;
        const dealSearch = await hs('POST', '/crm/v3/objects/deals/search', {
          filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: dealName }] }],
        });
        if (dealSearch.body.total === 0) {
          const deal = await hs('POST', '/crm/v3/objects/deals', {
            properties: {
              dealname:  dealName,
              pipeline:  'default',
              dealstage: 'appointmentscheduled',
              closedate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
            },
          });
          if (deal.body.id) {
            await hs('PUT', `/crm/v4/objects/deals/${deal.body.id}/associations/contacts/${contactId}/3`, null);
          }
        }
      }

      await sleep(150); // avoid rate limits
    } catch (e) {
      failed++;
      console.log(`  ✗ Error: ${lead.name} — ${e.message}`);
    }
  }

  console.log(`\nDone! Created: ${created}, Updated: ${updated}, Failed: ${failed}`);
}

run();
