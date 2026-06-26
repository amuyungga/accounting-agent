# Deployment Guide — Railway

---

## Before you start

You need:
- A [GitHub](https://github.com) account (free)
- A [Railway](https://railway.app) account (free trial, then ~$5/month)
- Your Anthropic API key (`sk-ant-...`)
- Your Calendly link (e.g. `https://calendly.com/yourname/30min`)

---

## Step 1 — Push the project to GitHub

Open a terminal **in this project folder** and run:

```bash
# If you haven't initialized git yet:
git init
git add .
git commit -m "Initial commit"

# Create a new repo at github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

> Already have a repo? Just run `git add . && git commit -m "Add Railway config" && git push`

---

## Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and log in
2. Click **New Project → Deploy from GitHub repo**
3. Authorize Railway to access your GitHub account
4. Select your repo from the list
5. Railway will detect Node.js and start building automatically

---

## Step 3 — Set environment variables

In your Railway project dashboard:

1. Click your service → **Variables** tab
2. Add these two variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (your key) |
| `CALENDLY_URL` | `https://calendly.com/yourname/30min` |

3. Click **Deploy** (Railway restarts with the new vars)

---

## Step 4 — Get your public URL

1. In Railway, click your service → **Settings** tab
2. Under **Domains**, click **Generate Domain**
3. You'll get a URL like: `https://accounting-firm-ai-agent-production.up.railway.app`

Copy that URL — you'll need it in Step 5.

---

## Step 5 — Update the chat widget

Open `widget.html` and find this line near the top of the `<script>` block:

```js
const API_URL = 'http://localhost:3000/chat';
```

Change it to your Railway URL:

```js
const API_URL = 'https://YOUR-APP.up.railway.app/chat';
```

Save the file, then commit and push so Railway redeploys:

```bash
git add widget.html
git commit -m "Update API_URL to production"
git push
```

---

## Step 6 — Embed on GoDaddy

1. Log in to GoDaddy → **Website Builder** → **Edit Site**
2. Add an **HTML / Embed Code** block where you want the chat bubble
3. Open `widget.html`, copy **everything inside the two comment markers**
4. Paste it into the GoDaddy HTML block
5. Save and publish

---

## Verify it's working

- Visit your Railway URL in a browser — you should see a 404 or blank page (that's fine, it means the server is up)
- Go to `https://YOUR-APP.up.railway.app/dashboard.html` to see the leads dashboard
- Test a conversation via your GoDaddy site and confirm the lead shows up in the dashboard

---

## Useful endpoints

| Endpoint | What it does |
|---|---|
| `POST /chat` | AI chat (used by widget) |
| `GET /leads` | All leads as JSON |
| `GET /leads/export.csv` | Download leads as CSV |
| `GET /dashboard.html` | Visual leads dashboard |

---

## Local development (optional)

Copy `.env.example` to `.env` and fill in your keys:

```
ANTHROPIC_API_KEY=sk-ant-...
CALENDLY_URL=https://calendly.com/yourname/30min
```

Then:

```bash
npm install
node server.js
```

Open `http://localhost:3000/dashboard.html` to test locally.
