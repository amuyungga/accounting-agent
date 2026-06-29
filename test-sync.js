// Quick test — sends one dummy lead to Railway sync endpoint and shows the response
const https = require('https');

const testLead = {
  id: 'test_' + Date.now(),
  name: 'Test Business',
  email: 'test@example.com',
  status: 'emailed',
  source: 'linkedin',
  foundAt: new Date().toISOString(),
  emailSentAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const body = JSON.stringify([testLead]);
const RAILWAY = 'accounting-agent-production-cf69.up.railway.app';
const SECRET  = 'spectrum-sync';

console.log('Sending test lead to Railway sync endpoint...');
console.log('Payload size:', Buffer.byteLength(body), 'bytes');

const req = https.request({
  hostname: RAILWAY,
  path: '/outbound-leads/sync',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-sync-key': SECRET,
  }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    console.log('Response:', d);
    if (res.statusCode === 200) {
      console.log('\n✅ Sync endpoint is working!');
    } else {
      console.log('\n❌ Sync endpoint returned an error.');
    }
  });
});

req.on('error', e => {
  console.log('❌ Connection error:', e.message);
  console.log('This usually means Railway is down or blocking the request.');
});

req.write(body);
req.end();
