# AI Marketing & Sales Agent — Project Status
Last updated: June 23, 2026

## ✅ What's Done

### Backend (Railway)
- Node.js + Express server running live on Railway
- Claude Haiku AI powering the chat
- Lead capture: saves name, email, phone, service to leads.json
- Leads dashboard: https://accounting-agent-production-cf69.up.railway.app/dashboard.html
- Leads CSV export: https://accounting-agent-production-cf69.up.railway.app/leads/export.csv
- ANTHROPIC_API_KEY set in Railway Variables

### Frontend
- Chat widget (widget.js) embedded on spectrumfinancialsolution.com via Airo
- Blue chat bubble appears on all pages
- Mobile responsive
- Quick reply buttons
- Typing indicator

### GitHub
- Repo: https://github.com/amuyungga/accounting-agent
- Files on GitHub: server.js, package.json, dashboard.html, widget.js
- Railway auto-deploys when GitHub is updated

---

## 🔲 Still To Do

1. **Add Calendly link** — go to Railway → accounting-agent → Variables → add:
   - Name: `CALENDLY_URL`
   - Value: your Calendly booking link (e.g. https://calendly.com/yourname/30min)
   - Click Deploy

2. **Upload missing files to GitHub** (optional but good practice):
   - railway.json
   - .gitignore
   - .env.example
   - DEPLOY.md
   - widget.html

3. **Secure the leads dashboard** — currently anyone with the URL can see leads. Add a password.

4. **Email notifications** — get an email when a new lead is captured.

5. **Customize AI persona** — update the system prompt in server.js to use Spectrum Financial Solutions branding, specific services, and tone.

---

## 🔑 Key Details

| Item | Value |
|---|---|
| Live site | spectrumfinancialsolution.com |
| Railway URL | https://accounting-agent-production-cf69.up.railway.app |
| GitHub repo | https://github.com/amuyungga/accounting-agent |
| Railway project | heartfelt-nature |
| GitHub username | amuyungga |
| Project folder | C:\Users\sntmi\Claude\Projects\Ai Marketing and Sales agent |

---

## 📝 How to Push Updates to GitHub

1. Make changes to files in the project folder
2. Go to https://github.com/amuyungga/accounting-agent
3. Click "Add file" → "Upload files"
4. Drag and drop the updated file(s)
5. Click "Commit changes"
6. Railway auto-deploys within 60 seconds

(The push-to-github.bat file is currently blocked by GitHub secret scanning — use manual upload instead)
