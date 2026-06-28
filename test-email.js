require('dotenv').config();
const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const payload = JSON.stringify({
  from: 'Asante | Spectrum Financial Solutions <onboarding@resend.dev>',
  to: ['snt.milla@gmail.com'],
  reply_to: 'asante@spectrumfinancialsolution.com',
  subject: 'Reputation test - Spectrum Financial Solutions',
  text: 'If you see this, the domain reputation fix works. Replies go to asante@spectrumfinancialsolution.com.',
  html: '<p>If you see this, the domain reputation fix works. Replies go to asante@spectrumfinancialsolution.com.</p>'
});

const req = https.request({
  hostname: 'api.resend.com',
  path: '/emails',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
    if (res.statusCode === 200) {
      console.log('\n✅ Email sent! Check snt.milla@gmail.com for the BCC copy.');
    } else {
      console.log('\n❌ Something went wrong. Check the response above.');
    }
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(payload);
req.end();
