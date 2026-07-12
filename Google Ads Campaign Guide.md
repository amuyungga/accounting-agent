# Google Ads Campaign Guide
## Spectrum Financial Solutions — Inbound Lead Generation

**Landing page URL:** `https://accounting-agent-production-cf69.up.railway.app/landing.html`
**Calendly:** `https://calendly.com/asante-spectrumfinancialsolution/30min`

---

## Campaign Structure

Run **2 separate campaigns** — one per audience. This keeps budgets, keywords, and ad copy clean and lets you see which converts better.

```
Campaign 1: Nonprofits & FQHCs
  Ad Group 1A: FQHC / Community Health Centers
  Ad Group 1B: Nonprofit Accounting

Campaign 2: Small Businesses
  Ad Group 2A: Fractional CFO
  Ad Group 2B: Small Business Accounting
```

---

## Campaign 1: Nonprofits & FQHCs

### Ad Group 1A — FQHC / Community Health Centers

**Keywords (Broad Match Modifier / Phrase Match):**
```
"FQHC accounting services"
"community health center CFO"
"federally qualified health center accounting"
"FQHC financial management"
"community health center bookkeeping"
"HRSA grant accounting"
"health center financial services"
"nonprofit health center CFO"
```

**Negative keywords:** employee, job, salary, hire, degree, free software, quickbooks

---

**Ad Copy — Ad 1A-1:**
```
Headline 1: FQHC Accounting Specialists
Headline 2: Fractional CFO for Health Centers
Headline 3: Free Consultation — No Commitment
Description 1: Expert accounting for federally qualified health centers. HRSA compliance, UDS reporting & grant management handled.
Description 2: Get senior CFO-level financial leadership without the full-time cost. 24-hour response guaranteed.
```

**Ad Copy — Ad 1A-2 (test against 1A-1):**
```
Headline 1: Struggling With HRSA Compliance?
Headline 2: FQHC Financial Experts Ready to Help
Headline 3: Book a Free 30-Min Strategy Call
Description 1: We specialize in FQHC financial management — grant compliance, cost reporting, UDS, and board-ready statements.
Description 2: Fractional CFO services built for community health centers. Talk to an expert today.
```

---

### Ad Group 1B — Nonprofit Accounting

**Keywords:**
```
"nonprofit accounting services"
"nonprofit CFO services"
"fractional CFO nonprofit"
"nonprofit bookkeeping"
"nonprofit financial management"
"outsourced CFO nonprofit"
"nonprofit grant accounting"
"accounting firm for nonprofits"
```

**Ad Copy — Ad 1B-1:**
```
Headline 1: Nonprofit Accounting Experts
Headline 2: Fractional CFO for Nonprofits
Headline 3: Free Consultation Available
Description 1: Board-ready financial statements, grant compliance, and audit prep for nonprofits. Focus on your mission — we'll handle the numbers.
Description 2: Spectrum Financial Solutions specializes in nonprofit accounting. Senior CFO expertise at a fraction of the cost.
```

---

## Campaign 2: Small Businesses

### Ad Group 2A — Fractional CFO

**Keywords:**
```
"fractional CFO services"
"outsourced CFO small business"
"part time CFO"
"hire fractional CFO"
"small business CFO services"
"fractional chief financial officer"
"on demand CFO"
"virtual CFO services"
```

**Ad Copy — Ad 2A-1:**
```
Headline 1: Fractional CFO Services
Headline 2: Senior Financial Leadership On-Demand
Headline 3: Free Strategy Call — Book Today
Description 1: Get CFO-level financial strategy without a $200K salary. Cash flow forecasting, investor prep, and monthly reporting done right.
Description 2: Spectrum Financial Solutions gives growing businesses access to senior financial expertise when they need it most.
```

---

### Ad Group 2B — Small Business Accounting

**Keywords:**
```
"small business accounting services"
"small business bookkeeping"
"outsourced accounting services"
"accounting firm small business"
"small business financial services"
"business bookkeeping services"
"monthly bookkeeping services"
"accounting services near me"
```

**Ad Copy — Ad 2B-1:**
```
Headline 1: Small Business Accounting
Headline 2: Clean Books. Clear Financials.
Headline 3: Get a Free Consultation Today
Description 1: Monthly bookkeeping, clean financials, and tax-ready records for growing small businesses. We handle the numbers so you can focus on growth.
Description 2: No long-term contracts. Senior-level accounting at prices small businesses can actually afford.
```

---

## Campaign Settings

| Setting | Recommendation |
|---|---|
| Campaign type | Search (not Display or Performance Max to start) |
| Bidding strategy | **Maximize Conversions** (once you have 10+ conversions) — start with **Manual CPC** |
| Starting bid | $3–6 per click |
| Daily budget | $10–15/day per campaign ($20–30 total) |
| Location | United States (or target specific states: CA, TX, MO, WA, AZ) |
| Schedule | Mon–Fri, 8am–6pm local time |
| Device | All devices (mobile is important) |
| Ad rotation | Rotate evenly for first 30 days, then optimize |

---

## Conversion Tracking (Critical — Set This Up First)

Without conversion tracking, Google can't optimize. Set up a conversion action for **form submissions** on your landing page.

1. In Google Ads → Tools → Conversions → New conversion action
2. Choose **Website**
3. Category: **Submit lead form**
4. Value: $50 (estimated lead value)
5. Add the Google tag to your `landing.html` `<head>` section
6. Fire the conversion event when the success message appears (after form submit)

Add this snippet to `landing.html` after a successful form submission:
```javascript
// After res.ok in the fetch success handler, add:
if (typeof gtag !== 'undefined') {
  gtag('event', 'conversion', { 'send_to': 'AW-XXXXXXXXX/XXXXXXX' });
}
```
*(Replace AW-XXXXXXXXX/XXXXXXX with your actual conversion ID from Google Ads)*

---

## Budget Recommendation

**Start small, prove it works, then scale:**

| Month | Daily Budget | Expected Clicks | Expected Leads |
|---|---|---|---|
| Month 1 | $15/day (~$450) | 75–150 | 3–8 |
| Month 2 | $25/day (~$750) | 125–250 | 6–15 |
| Month 3+ | $40–50/day | Scale based on cost-per-lead |

At $15/day, one closed client typically covers 6–12 months of ad spend. The math works.

---

## First 30 Days — What to Watch

- **Click-Through Rate (CTR):** Should be 3–8%. Below 2% = rewrite headlines.
- **Cost Per Click (CPC):** Expect $4–12 for these keywords.
- **Conversion Rate:** 5–15% of clicks should fill the form. Below 3% = landing page issue.
- **Impression Share:** If below 40%, your budget is too low or bids too conservative.

---

## Quick-Start Checklist

- [ ] Create Google Ads account at ads.google.com
- [ ] Link to Google Analytics (if you have it)
- [ ] Set up conversion tracking (form submission event)
- [ ] Create Campaign 1 (Nonprofits & FQHCs) with the keywords and ad copy above
- [ ] Create Campaign 2 (Small Businesses) with the keywords and ad copy above
- [ ] Add your landing page URL to all ads
- [ ] Set location targeting (start with your strongest states)
- [ ] Run for 2 weeks before making major changes — Google needs data
