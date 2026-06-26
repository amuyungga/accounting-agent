# AI Marketing & Sales Agent — Setup Guide
Accounting Firm Edition

---

## What you're getting

| File | Purpose |
|---|---|
| `server.js` | Node.js backend — powers the AI, stores leads |
| `widget.html` | Embeddable chat widget for your GoDaddy site |
| `dashboard.html` | Lead viewer (open via your browser) |
| `package.json` | Node.js dependencies list |
| `leads.json` | Auto-created when first lead is captured |

---

## Step 1 — Install Node.js

Download and install from: https://nodejs.org (choose the LTS version)

Verify it works by opening a terminal and running:
```
node --version
```

---

## Step 2 — Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to **API Keys** → **Create Key**
4. Copy your key (starts with `sk-ant-...`)

---

## Step 3 — Configure the server

Open `server.js` in a text editor and update these two lines near the top:

```js
const API_KEY      = 'sk-ant-YOUR_KEY_HERE';
const CALENDLY_URL = 'https://calendly.com/YOUR_CALENDLY_LINK';
```

If you don't have Calendly yet, sign up free at https://calendly.com and create a
"30-minute intro call" event. Paste that link in place of the placeholder.

---

## Step 4 — Install dependencies & run

Open a terminal in the project folder, then run:

```bash
npm install
node server.js
```

You should see:
```
✅ Accounting Firm AI Agent running on http://localhost:3000
```

**Leave this terminal window open while testing.**

---

## Step 5 — Test the chatbot locally

Open `widget.html` in your browser. Click the blue chat bubble in the bottom-right
corner and have a test conversation. The AI should greet you and start qualifying you
as a lead.

After chatting, open your browser and go to:
```
http://localhost:3000/dashboard.html
```

You should see your test lead appear in the dashboard.

---

## Step 6 — Embed on your GoDaddy website

1. Log in to GoDaddy → **Website Builder** → **Edit Site**
2. Find a section where you want the chat widget (usually the footer or a blank section)
3. Add an **HTML block** / **Embed Code** widget
4. Open `widget.html`, copy **everything between the two comment lines**:

```
<!-- ══════════════════════════════════════
     CHAT WIDGET  —  Paste the code below
     ...
     ══════════════════════════════════════ -->

... (paste everything here) ...

</script>
```

5. Before pasting, update the `API_URL` in the script to your **deployed server URL**
   (see Step 7 for deployment options):

```js
const API_URL = 'https://your-server.com/chat';
```

6. Save and publish your site.

---

## Step 7 — Deploy the server (so it's always on)

The server needs to run 24/7. Easiest free/cheap options:

### Option A — Railway (recommended, ~$5/month)
1. Go to https://railway.app and sign up
2. Click **New Project → Deploy from GitHub** (push your files to a GitHub repo first)
   OR use **Deploy from local** with the Railway CLI
3. Add environment variables in Railway's dashboard:
   - `ANTHROPIC_API_KEY` = your key
   - `CALENDLY_URL` = your Calendly link
4. Railway gives you a public URL like `https://your-app.railway.app`
5. Update `API_URL` in the widget to that URL

### Option B — Render (free tier available)
1. Go to https://render.com
2. New → Web Service → connect your repo
3. Set build command: `npm install`
4. Set start command: `node server.js`
5. Add env vars: `ANTHROPIC_API_KEY`, `CALENDLY_URL`

### Option C — Run on your own computer (testing only)
Use ngrok to expose your local server temporarily:
```bash
npx ngrok http 3000
```
This gives you a public URL for testing. Not suitable for permanent production use.

---

## Viewing & exporting leads

- **Dashboard**: http://localhost:3000/dashboard.html (or your-deployed-url/dashboard.html)
- **Export CSV**: http://localhost:3000/leads/export.csv
- **Raw JSON**: http://localhost:3000/leads

> **Security tip**: Before going live, add basic authentication to the `/leads` and
> `/dashboard.html` routes in `server.js` to prevent anyone from viewing your leads.

---

## Customizing the AI

Open `server.js` and find the `SYSTEM_PROMPT` section. You can:
- Add your firm's name and location
- List specific team members or partners
- Add office hours
- Adjust the tone (more formal, more casual)
- Add FAQ answers about your services

---

## Need help?

Common issues:

**"Cannot connect to server"** — Make sure `node server.js` is still running in your terminal.

**"AI key error"** — Double-check your API key is correct in `server.js` or as an env variable.

**Widget not showing on GoDaddy** — Make sure you updated `API_URL` in the widget to your deployed server address (not localhost).
