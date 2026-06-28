var BASE = window.location.origin;
var chatLeads = [], outboundLeads = [], callLogs = [];
var crmContacts = [], crmDeals = [];
var obCurFilter = 'all', obCurSource = 'all', caCurFilter = 'all', crmCurFilter = 'all';

// ── Tab date filters ──────────────────────────────────────────────────────────
var tabDates = { ch: {from:null,to:null}, ob: {from:null,to:null}, ca: {from:null,to:null}, crm: {from:null,to:null} };
var tabSections = { ch: 's-chat', ob: 's-outbound', ca: 's-calls', crm: 's-crm' };

function setTabDate(tab, preset, btn) {
  var bar = btn.closest('.date-bar');
  bar.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  var now = new Date(), from = null, to = null;
  if (preset === 'today') {
    from = new Date(now); from.setHours(0,0,0,0);
    to   = new Date(now); to.setHours(23,59,59,999);
  } else if (preset === '7d') {
    from = new Date(now); from.setDate(from.getDate()-6); from.setHours(0,0,0,0);
    to   = new Date(now); to.setHours(23,59,59,999);
  } else if (preset === '30d') {
    from = new Date(now); from.setDate(from.getDate()-29); from.setHours(0,0,0,0);
    to   = new Date(now); to.setHours(23,59,59,999);
  } else if (preset === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date(now); to.setHours(23,59,59,999);
  }
  tabDates[tab] = { from:from, to:to };
  var fmt = function(d) { return d ? d.toISOString().slice(0,10) : ''; };
  var fi = document.getElementById(tab+'-from-date'), ti = document.getElementById(tab+'-to-date');
  if (fi) fi.value = fmt(from);
  if (ti) ti.value = fmt(to);
  tabRender(tab);
}

function applyTabDate(tab) {
  var fi = document.getElementById(tab+'-from-date'), ti = document.getElementById(tab+'-to-date');
  var from = null, to = null;
  if (fi && fi.value) { from = new Date(fi.value); from.setHours(0,0,0,0); }
  if (ti && ti.value) { to   = new Date(ti.value); to.setHours(23,59,59,999); }
  tabDates[tab] = { from:from, to:to };
  var bar = document.querySelector('#'+tabSections[tab]+' .date-bar');
  if (bar) bar.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  tabRender(tab);
}

function tabRender(tab) {
  if (tab === 'ch')  renderChat();
  else if (tab === 'ob')  renderOutbound();
  else if (tab === 'ca')  renderCalls();
  else if (tab === 'crm') renderCrmContacts();
}

function inDateRange(dateStr, from, to) {
  if (!from && !to) return true;
  if (!dateStr) return false;
  var d = new Date(dateStr);
  if (from && d < from) return false;
  if (to   && d > to)   return false;
  return true;
}

document.getElementById('call-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.getElementById('m-close').addEventListener('click', closeModal);
function closeModal() { document.getElementById('call-modal').classList.remove('open'); }

function switchTab(btn, name) {
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('s-' + name).classList.add('active');
  btn.classList.add('active');
}

function animateCount(id, target) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!target || isNaN(target)) { el.textContent = target || '0'; return; }
  var duration = 700;
  var startTime = null;
  function step(ts) {
    if (!startTime) startTime = ts;
    var p = Math.min((ts - startTime) / duration, 1);
    var eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(eased * target);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function loadAll() {
  Promise.all([loadChat(), loadOutbound(), loadCalls(), loadCrm()]).then(function() {
    updateOverview();
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  });
}

function loadChat() {
  return fetch(BASE + '/leads').then(function(r) { return r.json(); }).then(function(d) {
    chatLeads = d; renderChatStats(); renderChat();
  }).catch(function(e) {
    document.getElementById('ch-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">⚠️</span>Error: ' + e.message + '</td></tr>';
  });
}

function renderChatStats() {
  var today = new Date().toDateString();
  var wk = Date.now() - 7 * 24 * 60 * 60 * 1000;
  animateCount('ch-total', chatLeads.length);
  animateCount('ch-today', chatLeads.filter(function(l) { return new Date(l.capturedAt).toDateString() === today; }).length);
  animateCount('ch-week', chatLeads.filter(function(l) { return new Date(l.capturedAt) > wk; }).length);
  var counts = {};
  chatLeads.forEach(function(l) { if (l.service) counts[l.service] = (counts[l.service] || 0) + 1; });
  var entries = Object.keys(counts).map(function(k) { return [k, counts[k]]; });
  entries.sort(function(a, b) { return b[1] - a[1]; });
  document.getElementById('ch-top').textContent = entries.length ? entries[0][0] : '—';
}

function renderChat() {
  var q = (document.getElementById('ch-s').value || '').toLowerCase();
  var d = tabDates['ch'];
  var leads = chatLeads.slice().reverse().filter(function(l) { return inDateRange(l.capturedAt, d.from, d.to); });
  if (q) leads = leads.filter(function(l) {
    return (l.name || '').toLowerCase().indexOf(q) >= 0 ||
           (l.email || '').toLowerCase().indexOf(q) >= 0 ||
           (l.service || '').toLowerCase().indexOf(q) >= 0;
  });
  if (!leads.length) {
    document.getElementById('ch-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">💬</span>No chat leads yet. They will appear here once your widget captures them.</td></tr>';
    return;
  }
  document.getElementById('ch-tbody').innerHTML = leads.map(function(l) {
    var bc = chatBadge(l.service);
    return '<tr>' +
      '<td><strong>' + E(l.name || '-') + '</strong></td>' +
      '<td><a href="mailto:' + E(l.email || '') + '">' + E(l.email || '-') + '</a></td>' +
      '<td>' + E(l.phone || '-') + '</td>' +
      '<td><span class="badge ' + bc + '">' + E(l.service || '-') + '</span></td>' +
      '<td class="td-sm">' + E(l.notes || '-') + '</td>' +
      '<td class="td-xs">' + D(l.capturedAt) + '</td>' +
      '</tr>';
  }).join('');
}

function chatBadge(s) {
  s = (s || '').toLowerCase();
  if (s.indexOf('tax') >= 0) return 'badge b-tax';
  if (s.indexOf('book') >= 0) return 'badge b-book';
  if (s.indexOf('cfo') >= 0 || s.indexOf('advis') >= 0) return 'badge b-cfo';
  if (s.indexOf('payroll') >= 0) return 'badge b-pay';
  return 'badge b-other';
}

function loadOutbound() {
  return fetch(BASE + '/outbound-leads').then(function(r) { return r.json(); }).then(function(d) {
    outboundLeads = d;
    outboundLeads.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    renderObStats(); renderHotLeads(); renderOutbound();
  }).catch(function(e) {
    document.getElementById('ob-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">⚠️</span>Error: ' + e.message + '</td></tr>';
  });
}

function renderHotLeads() {
  var hot = outboundLeads.filter(function(l) { return l.replied || l.clicked || (l.openCount && l.openCount >= 2); });
  var wrap = document.getElementById('ob-hot-wrap');
  var el = document.getElementById('ob-hot');
  if (!wrap || !el) return;
  if (!hot.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  el.innerHTML = hot.map(function(l) {
    var signals = [];
    if (l.replied)   signals.push('<span class="hc-sig" style="background:rgba(63,185,80,.15);color:#3fb950">💬 Replied</span>');
    if (l.clicked)   signals.push('<span class="hc-sig" style="background:rgba(248,81,73,.15);color:#f85149">🔥 Clicked Calendly</span>');
    if (l.openCount) signals.push('<span class="hc-sig" style="background:rgba(227,179,65,.15);color:#e3b341">👁 Opened ' + l.openCount + 'x</span>');
    if (l.secondFollowUpSent) signals.push('<span class="hc-sig" style="background:rgba(88,166,255,.12);color:#58a6ff">📬 2nd Follow-up</span>');
    else if (l.followUpSent)  signals.push('<span class="hc-sig" style="background:rgba(88,166,255,.12);color:#58a6ff">📬 Followed Up</span>');
    var replyBtn = l.id
      ? (!l.replied
          ? '<button onclick="markReplied(\'' + l.id + '\',this)" style="margin-top:8px;font-size:11px;padding:3px 10px;border:1px solid #3fb950;color:#3fb950;border-radius:6px;background:transparent;cursor:pointer">Mark Replied</button>'
          : '<span style="font-size:11px;color:#16a34a;margin-top:8px;display:inline-block">✓ Replied</span> <button onclick="undoReplied(\'' + l.id + '\',this)" style="font-size:10px;padding:1px 6px;border:1px solid #94a3b8;border-radius:4px;background:transparent;color:#94a3b8;cursor:pointer">Undo</button>')
      : '';
    return '<div class="hot-card">' +
      '<div class="hc-name">' + E(l.name || '-') + '</div>' +
      '<div class="hc-email">' + (l.email ? '<a href="mailto:' + E(l.email) + '">' + E(l.email) + '</a>' : '-') + '</div>' +
      '<div class="hc-signals">' + signals.join('') + '</div>' +
      replyBtn +
      '</div>';
  }).join('');
}

function renderObStats() {
  animateCount('ob-total', outboundLeads.length);
  animateCount('ob-emailed', outboundLeads.filter(function(l) { return l.status === 'emailed'; }).length);
  animateCount('ob-found', outboundLeads.filter(function(l) { return l.status === 'email_found'; }).length);
  animateCount('ob-noemail', outboundLeads.filter(function(l) { return l.status === 'no_email' || l.status === 'no_website'; }).length);

  // Source breakdown chips + dropdown
  var sourceCounts = {};
  outboundLeads.forEach(function(l) {
    var src = l.source || l.intentSource || (l.placeId ? 'google_places' : null);
    if (src) sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  });
  var srcNames = { linkedin: 'LinkedIn', indeed: 'Indeed', ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', monster: 'Monster', craigslist: 'Craigslist', reddit: 'Reddit', acctg_software: 'Acctg Software', new_business: 'New Business', google_places: 'Google Places', intent: 'Intent' };
  var srcIcons = { linkedin: '💼', indeed: '🔍', ziprecruiter: '⚡', glassdoor: '🪟', monster: '👾', craigslist: '📋', reddit: '🔴', acctg_software: '📊', new_business: '🏪', google_places: '📍', intent: '🎯' };
  var sortedSrcs = Object.keys(sourceCounts).sort(function(a, b) { return sourceCounts[b] - sourceCounts[a]; });

  // Populate source dropdown — preserve current selection
  var sel = document.getElementById('ob-source-sel');
  if (sel) {
    var prev = sel.value || 'all';
    sel.innerHTML = '<option value="all">All Sources (' + outboundLeads.length + ')</option>' +
      sortedSrcs.map(function(s) {
        return '<option value="' + s + '">' + (srcIcons[s] || '') + ' ' + (srcNames[s] || s) + ' (' + sourceCounts[s] + ')</option>';
      }).join('');
    sel.value = prev; // restore selection
  }
}

function obFilter(btn, f) {
  obCurFilter = f;
  document.querySelectorAll('#s-outbound .toolbar:first-of-type .filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderOutbound();
}

function obSourceFilter(src) {
  obCurSource = src;
  renderOutbound();
}

function renderOutbound() {
  var q = (document.getElementById('ob-s').value || '').toLowerCase();
  var d = tabDates['ob'];
  var leads = outboundLeads.filter(function(l) { return inDateRange(l.emailSentAt || l.foundAt || l.updatedAt, d.from, d.to); });
  if (obCurFilter !== 'all') leads = leads.filter(function(l) { return l.status === obCurFilter; });
  if (obCurSource !== 'all') leads = leads.filter(function(l) { var s = l.source || l.intentSource || (l.placeId ? 'google_places' : null); return s === obCurSource; });
  if (q) leads = leads.filter(function(l) {
    return (l.name || '').toLowerCase().indexOf(q) >= 0 ||
           (l.email || '').toLowerCase().indexOf(q) >= 0 ||
           (l.industry || '').toLowerCase().indexOf(q) >= 0;
  });
  if (!leads.length) {
    document.getElementById('ob-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">📧</span>No outbound leads yet. Run the outbound agent to start finding prospects.</td></tr>';
    return;
  }
  document.getElementById('ob-tbody').innerHTML = leads.map(function(l) {
    var prev = (l.emailContent || '').replace(/Subject:[^\n]+\n?/, '').trim().slice(0, 180);
    var contact = l.email ? '<a href="mailto:' + E(l.email) + '">' + E(l.email) + '</a>' : '<span class="td-muted">-</span>';
    if (l.phone) contact += '<div class="bs">' + E(l.phone) + '</div>';
    if (l.website) contact += '<div class="bs"><a href="' + E(l.website) + '" target="_blank">website ↗</a></div>';

    // Score badge
    var score = l.score || 0;
    var scoreColor = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#64748b';
    var scoreBadge = l.score != null ? '<span style="font-size:11px;font-weight:700;color:' + scoreColor + ';background:' + scoreColor + '1a;padding:2px 6px;border-radius:10px;margin-left:4px">' + score + '</span>' : '';

    // Hot signals
    var signals = '';
    if (l.replied)    signals += '<span title="Replied" style="font-size:13px">💬</span> ';
    if (l.clicked)    signals += '<span title="Clicked Calendly" style="font-size:13px">🔥</span> ';
    if (l.openCount)  signals += '<span title="Opened ' + l.openCount + 'x" style="font-size:13px">👁 ' + l.openCount + '</span> ';
    if (l.followUpSent && !l.replied) signals += '<span title="Follow-up sent" style="font-size:13px">📬</span> ';
    if (l.emailVariant) signals += '<span style="font-size:10px;color:#94a3b8">v' + l.emailVariant + '</span> ';

    // Row highlight for hot leads
    var rowStyle = l.clicked ? 'background:rgba(239,68,68,0.06)' : l.openCount ? 'background:rgba(245,158,11,0.05)' : '';

    // Reply button
    var replyBtn = (l.status === 'emailed' || l.status === 'follow_up_sent') && !l.replied && l.id
      ? '<button onclick="markReplied(\'' + l.id + '\',this)" style="font-size:11px;padding:2px 7px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer;margin-top:4px">Mark Replied</button>'
      : (l.replied ? '<span style="font-size:11px;color:#16a34a">✓ Replied</span>' : '');

    return '<tr style="' + rowStyle + '">' +
      '<td><div class="bn">' + E(l.name || '-') + scoreBadge + '</div><div class="bs">' + E(l.address || '') + '</div></td>' +
      '<td>' + contact + '</td>' +
      '<td><span class="badge b-' + (l.status || 'other') + '">' + obLabel(l.status) + '</span><div style="margin-top:4px">' + signals + '</div>' + replyBtn + '</td>' +
      '<td>' + (l.industry ? '<span class="bi">' + E(l.industry) + '</span>' : '-') + '</td>' +
      '<td><div class="ep">' + E(prev || '-') + '</div></td>' +
      '<td class="td-xs">' + D(l.emailSentAt || l.foundAt) + '</td>' +
      '</tr>';
  }).join('');
  document.querySelectorAll('.ep').forEach(function(el) {
    el.addEventListener('click', function() { this.classList.toggle('open'); });
  });
}

function markReplied(id, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  fetch(BASE + '/outbound-leads/' + id + '/reply', { method: 'PATCH' })
    .then(function(r) { return r.json(); })
    .then(function() {
      // Replace button with "✓ Replied" + Undo link — no full reload needed
      var cell = btn.parentNode;
      cell.innerHTML = (cell.innerHTML || '').replace(/<button[^>]*Mark Replied[^<]*<\/button>/, '');
      var wrap = document.createElement('span');
      wrap.innerHTML = '<span style="font-size:11px;color:#16a34a">✓ Replied</span> ' +
        '<button onclick="undoReplied(\'' + id + '\',this)" style="font-size:10px;padding:1px 6px;border:1px solid #94a3b8;border-radius:4px;background:transparent;color:#94a3b8;cursor:pointer;margin-left:4px">Undo</button>';
      cell.appendChild(wrap);
    })
    .catch(function() { btn.disabled = false; btn.textContent = 'Mark Replied'; });
}

function undoReplied(id, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  fetch(BASE + '/outbound-leads/' + id + '/unreply', { method: 'PATCH' })
    .then(function(r) { return r.json(); })
    .then(function() { loadOutbound(); })
    .catch(function() { btn.disabled = false; btn.textContent = 'Undo'; });
}

function obLabel(s) {
  var map = { emailed: 'Emailed', found: 'Found', email_found: 'Email Found', no_email: 'No Email', no_website: 'No Website', follow_up_sent: 'Follow-up Sent', error: 'Error' };
  return map[s] || (s || '-');
}

function loadCalls() {
  return fetch(BASE + '/calls').then(function(r) { return r.json(); }).then(function(d) {
    callLogs = Array.isArray(d) ? d : (d.results || []);
    renderCaStats(); renderCalls();
  }).catch(function(e) {
    document.getElementById('ca-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">⚠️</span>Error: ' + e.message + '</td></tr>';
  });
}

function renderCaStats() {
  var ans = callLogs.filter(function(c) { return caStatus(c) === 'ended'; }).length;
  var durs = callLogs.filter(function(c) { return c.duration > 0; }).map(function(c) { return c.duration; });
  var avg = durs.length ? durs.reduce(function(a, b) { return a + b; }, 0) / durs.length : 0;
  var cost = callLogs.reduce(function(s, c) { return s + (c.cost || 0); }, 0);
  animateCount('ca-total', callLogs.length);
  animateCount('ca-answered', ans);
  document.getElementById('ca-duration').textContent = avg ? dur(avg) : '—';
  document.getElementById('ca-cost').textContent = '$' + cost.toFixed(2);
}

function caFilter(btn, f) {
  caCurFilter = f;
  document.querySelectorAll('#s-calls .filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderCalls();
}

function renderCalls() {
  var d = tabDates['ca'];
  var logs = callLogs.filter(function(c) { return inDateRange(c.startedAt || c.createdAt, d.from, d.to); });
  if (caCurFilter !== 'all') logs = logs.filter(function(c) { return caStatus(c) === caCurFilter; });
  if (!logs.length) {
    document.getElementById('ca-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">📞</span>No calls yet. Calls from your Vapi receptionist will appear here.</td></tr>';
    return;
  }
  document.getElementById('ca-tbody').innerHTML = logs.map(function(c) {
    var st = caStatus(c);
    var caller = (c.customer && (c.customer.number || c.customer.name)) || 'Unknown';
    var reason = (c.endedReason || '-').replace(/-/g, ' ');
    var statusMap = { ended: 'b-answered', missed: 'b-missed', 'in-progress': 'b-live' };
    var labelMap = { ended: 'Answered', missed: 'Missed', 'in-progress': 'Live' };
    var bc = statusMap[st] || 'b-other';
    var bl = labelMap[st] || st;
    return '<tr class="call-row" data-id="' + c.id + '">' +
      '<td><strong>' + E(caller) + '</strong></td>' +
      '<td class="td-sm">' + D(c.startedAt || c.createdAt) + '</td>' +
      '<td>' + dur(c.duration) + '</td>' +
      '<td><span class="badge ' + bc + '">' + bl + '</span></td>' +
      '<td class="td-cap">' + E(reason) + '</td>' +
      '<td class="td-grey">' + (c.cost ? '$' + c.cost.toFixed(3) : '-') + '</td>' +
      '</tr>';
  }).join('');
  document.querySelectorAll('.call-row').forEach(function(row) {
    row.style.cursor = 'pointer';
    row.addEventListener('click', function() { openModal(this.dataset.id); });
  });
}

function caStatus(c) {
  if (c.status === 'in-progress') return 'in-progress';
  if (!c.endedAt) return 'missed';
  var r = (c.endedReason || '').toLowerCase();
  if (r.indexOf('no-answer') >= 0 || r.indexOf('voicemail') >= 0 || r.indexOf('busy') >= 0) return 'missed';
  return 'ended';
}

function openModal(id) {
  var c = callLogs.find(function(x) { return x.id === id; });
  if (!c) return;
  var caller = (c.customer && (c.customer.number || c.customer.name)) || 'Unknown';
  document.getElementById('m-title').textContent = 'Call from ' + caller;
  document.getElementById('m-meta').textContent = D(c.startedAt || c.createdAt) + ' — ' + dur(c.duration);
  var summary = c.summary || (c.analysis && c.analysis.summary);
  document.getElementById('m-summary').innerHTML = summary || '<span class="nd">No summary available</span>';
  document.getElementById('m-sum-wrap').style.display = summary ? '' : 'none';
  var tx = c.transcript || ((c.messages || []).map(function(m) { return m.role + ': ' + m.message; }).join('\n'));
  document.getElementById('m-transcript').innerHTML = tx || '<span class="nd">No transcript available</span>';
  document.getElementById('call-modal').classList.add('open');
}

function updateOverview() {
  var em      = outboundLeads.filter(function(l) { return l.status === 'emailed' || l.status === 'follow_up_sent'; }).length;
  var opened  = outboundLeads.filter(function(l) { return l.openCount > 0; }).length;
  var clicked = outboundLeads.filter(function(l) { return l.clicked; }).length;
  var replied = outboundLeads.filter(function(l) { return l.replied; }).length;
  animateCount('ov-chat', chatLeads.length);
  animateCount('ov-emailed', em);
  animateCount('ov-calls', callLogs.length);
  animateCount('ov-crm', crmContacts.length);
  animateCount('ov-total', chatLeads.length + em + callLogs.length);

  renderOverviewChart();

  // Email funnel
  var funnelEl = document.getElementById('ov-funnel');
  if (funnelEl && outboundLeads.length) {
    var pct = function(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; };
    var steps = [
      { lbl: 'Found',   val: outboundLeads.length, color: '#58a6ff', pct: null },
      { lbl: 'Emailed', val: em,      color: '#3fb950', pct: pct(em, outboundLeads.length) },
      { lbl: 'Opened',  val: opened,  color: '#e3b341', pct: pct(opened, em) },
      { lbl: 'Clicked', val: clicked, color: '#bc8cff', pct: pct(clicked, em) },
      { lbl: 'Replied', val: replied, color: '#f85149', pct: pct(replied, em) },
    ];
    funnelEl.innerHTML = steps.map(function(s) {
      return '<div class="funnel-step">' +
        '<div class="fs-val" style="color:' + s.color + '">' + s.val + '</div>' +
        '<div class="fs-lbl">' + s.lbl + '</div>' +
        (s.pct ? '<div class="fs-pct" style="color:' + s.color + '">' + s.pct + '</div>' : '') +
        '</div>';
    }).join('');
  }
  var ev = [].concat(
    chatLeads.map(function(l) { return { t: 'Chat', n: l.name || 'Unknown', c: l.email || '', d: l.service || '-', dt: l.capturedAt }; }),
    outboundLeads.filter(function(l) { return l.status === 'emailed'; }).map(function(l) { return { t: 'Email', n: l.name || 'Unknown', c: l.email || '', d: l.industry || '-', dt: l.emailSentAt || l.foundAt }; }),
    callLogs.map(function(c) { return { t: 'Call', n: (c.customer && (c.customer.number || c.customer.name)) || 'Unknown', c: '', d: (c.endedReason || '-').replace(/-/g, ' '), dt: c.startedAt || c.createdAt }; })
  ).sort(function(a, b) { return new Date(b.dt) - new Date(a.dt); }).slice(0, 20);
  var typeClass = { Chat: 'type-chat', Email: 'type-email', Call: 'type-call' };
  var typeIcon = { Chat: '💬', Email: '📧', Call: '📞' };
  document.getElementById('ov-tbody').innerHTML = ev.length
    ? ev.map(function(e) {
        var cls = typeClass[e.t] || 'type-chat';
        var ico = typeIcon[e.t] || '';
        return '<tr>' +
          '<td><span class="' + cls + '">' + ico + ' ' + e.t + '</span></td>' +
          '<td><strong>' + E(e.n) + '</strong></td>' +
          '<td class="td-sm">' + E(e.c) + '</td>' +
          '<td class="td-cap">' + E(e.d) + '</td>' +
          '<td class="td-xs">' + D(e.dt) + '</td>' +
          '</tr>';
      }).join('')
    : '<tr><td colspan="5" class="empty"><span class="empty-icon">⚡</span>No activity yet. Activity will appear here once leads start coming in.</td></tr>';
}

function E(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function D(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}
function dur(s) {
  if (!s) return '—';
  var m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
}

// ── CRM ──────────────────────────────────────────────────────────────────────

function loadCrm() {
  return fetch(BASE + '/hubspot-contacts').then(function(r) { return r.json(); }).then(function(d) {
    crmContacts = d.contacts || [];
    crmDeals = d.deals || [];
    renderCrmStats();
    renderCrmPipeline();
    renderCrmContacts();
  }).catch(function(e) {
    document.getElementById('crm-tbody').innerHTML = '<tr><td colspan="7" class="empty"><span class="empty-icon">⚠️</span>Error loading CRM: ' + e.message + '</td></tr>';
  });
}

function renderCrmStats() {
  animateCount('crm-total', crmContacts.length);
  var opp = crmContacts.filter(function(c) { return c.hs_lead_status === 'CONNECTED'; }).length;
  var inp = crmContacts.filter(function(c) { return c.hs_lead_status === 'IN_PROGRESS' || c.hs_lead_status === 'OPEN'; }).length;
  animateCount('crm-opp', opp);
  animateCount('crm-inprog', inp);
  animateCount('crm-deals', crmDeals.length);
}

function renderCrmPipeline() {
  var stages = {};
  crmDeals.forEach(function(d) {
    var s = d.dealstage || 'Unknown';
    stages[s] = (stages[s] || 0) + 1;
  });
  var stageColors = {
    appointmentscheduled: '#3b82f6',
    qualifiedtobuy: '#8b5cf6',
    presentationscheduled: '#f59e0b',
    decisionmakerboughtin: '#10b981',
    contractsent: '#06b6d4',
    closedwon: '#16a34a',
    closedlost: '#ef4444'
  };
  var stageLabels = {
    appointmentscheduled: 'Appointment Scheduled',
    qualifiedtobuy: 'Qualified to Buy',
    presentationscheduled: 'Presentation Scheduled',
    decisionmakerboughtin: 'Decision Maker Bought In',
    contractsent: 'Contract Sent',
    closedwon: 'Closed Won',
    closedlost: 'Closed Lost',
    prospect: 'Prospect',
    opportunity: 'Opportunity'
  };
  var el = document.getElementById('crm-pipeline');
  if (!Object.keys(stages).length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:14px;padding:20px">No deals in pipeline yet.</div>';
    return;
  }
  el.innerHTML = Object.keys(stages).map(function(s) {
    var color = stageColors[s] || '#64748b';
    var label = stageLabels[s] || s;
    return '<div style="background:' + color + '1a;border:1.5px solid ' + color + '33;border-radius:10px;padding:14px 18px;min-width:130px;text-align:center">' +
      '<div style="font-size:22px;font-weight:800;color:' + color + '">' + stages[s] + '</div>' +
      '<div style="font-size:11px;color:#64748b;margin-top:4px;white-space:nowrap">' + E(label) + '</div>' +
      '</div>';
  }).join('');
}

function crmFilter(btn, f) {
  crmCurFilter = f;
  document.querySelectorAll('#s-crm .filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderCrmContacts();
}

function renderCrmContacts() {
  var q = (document.getElementById('crm-s').value || '').toLowerCase();
  var d = tabDates['crm'];
  var contacts = crmContacts.filter(function(c) { return inDateRange(c.lastmodifieddate || c.createdate, d.from, d.to); });
  if (crmCurFilter !== 'all') contacts = contacts.filter(function(c) { return c.hs_lead_status === crmCurFilter; });
  if (q) contacts = contacts.filter(function(c) {
    return (c.firstname + ' ' + c.lastname).toLowerCase().indexOf(q) >= 0 ||
           (c.email || '').toLowerCase().indexOf(q) >= 0 ||
           (c.company || '').toLowerCase().indexOf(q) >= 0;
  });
  if (!contacts.length) {
    document.getElementById('crm-tbody').innerHTML = '<tr><td colspan="7" class="empty"><span class="empty-icon">🏢</span>No contacts found. HubSpot contacts will sync here as leads are emailed.</td></tr>';
    return;
  }
  // Build a map of deals by contact email for quick lookup
  var dealMap = {};
  crmDeals.forEach(function(d) {
    if (d._contactEmail) dealMap[d._contactEmail] = d;
  });
  document.getElementById('crm-tbody').innerHTML = contacts.map(function(c) {
    var name = [c.firstname, c.lastname].filter(Boolean).join(' ') || '-';
    var status = c.hs_lead_status || 'NEW';
    var statusColors = { CONNECTED: '#16a34a', IN_PROGRESS: '#d97706', OPEN: '#3b82f6', NEW: '#64748b', UNQUALIFIED: '#ef4444' };
    var statusBg = statusColors[status] || '#64748b';
    var deal = dealMap[c.email] || null;
    var stageLabels = { appointmentscheduled: 'Appt. Scheduled', qualifiedtobuy: 'Qualified', presentationscheduled: 'Presentation', decisionmakerboughtin: 'Decision Maker', contractsent: 'Contract Sent', closedwon: '✅ Won', closedlost: '❌ Lost', prospect: 'Prospect', opportunity: 'Opportunity' };
    var stageCell = deal ? (stageLabels[deal.dealstage] || deal.dealstage || '-') : '-';
    var lastMod = c.lastmodifieddate || c.hs_lastmodifieddate || null;
    return '<tr>' +
      '<td><strong>' + E(name) + '</strong></td>' +
      '<td>' + (c.email ? '<a href="mailto:' + E(c.email) + '">' + E(c.email) + '</a>' : '-') + '</td>' +
      '<td>' + E(c.company || '-') + '</td>' +
      '<td>' + E(c.phone || '-') + '</td>' +
      '<td><span style="font-size:11px;font-weight:700;color:' + statusBg + ';background:' + statusBg + '1a;padding:2px 8px;border-radius:10px">' + E(status) + '</span></td>' +
      '<td>' + E(stageCell) + '</td>' +
      '<td class="td-xs">' + D(lastMod) + '</td>' +
      '</tr>';
  }).join('');
}

// ── KPI Section ───────────────────────────────────────────────────────────────

var kpiFrom = null, kpiTo = null;

function setKpiPreset(preset, btn) {
  document.querySelectorAll('.kpi-toolbar .filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  var now = new Date();
  var from, to = new Date(now);
  to.setHours(23, 59, 59, 999);
  if (preset === 'today') {
    from = new Date(now); from.setHours(0, 0, 0, 0);
  } else if (preset === '7d') {
    from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
  } else if (preset === '30d') {
    from = new Date(now); from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0);
  } else if (preset === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    from = null; to = null;
  }
  kpiFrom = from; kpiTo = to;
  var fmt = function(d) { return d ? d.toISOString().slice(0, 10) : ''; };
  document.getElementById('kpi-from').value = fmt(from);
  document.getElementById('kpi-to').value = fmt(to);
  renderKpi();
}

function kpiLeads() {
  // Read custom date inputs if they changed directly
  var fromInput = document.getElementById('kpi-from').value;
  var toInput   = document.getElementById('kpi-to').value;
  if (fromInput) { kpiFrom = new Date(fromInput); kpiFrom.setHours(0, 0, 0, 0); }
  if (toInput)   { kpiTo   = new Date(toInput);   kpiTo.setHours(23, 59, 59, 999); }

  return outboundLeads.filter(function(l) {
    if (!l.emailSentAt) return false;
    var d = new Date(l.emailSentAt);
    if (kpiFrom && d < kpiFrom) return false;
    if (kpiTo   && d > kpiTo)   return false;
    return true;
  });
}

function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '0%'; }
function pctNum(a, b) { return b ? Math.round(a / b * 100) : 0; }

function renderKpi() {
  var leads = kpiLeads();
  var sent    = leads.length;
  var opened  = leads.filter(function(l) { return l.openCount > 0; }).length;
  var clicked = leads.filter(function(l) { return l.clicked; }).length;
  var replied = leads.filter(function(l) { return l.replied; }).length;
  var fu1     = leads.filter(function(l) { return l.followUpSent; }).length;
  var fu2     = leads.filter(function(l) { return l.secondFollowUpSent; }).length;

  // KPI cards
  document.getElementById('kpi-sent').textContent  = sent;
  document.getElementById('kpi-sent-sub').textContent = sent ? 'in selected period' : 'no emails in range';
  document.getElementById('kpi-open').textContent   = pct(opened, sent);
  document.getElementById('kpi-open-sub').textContent  = opened + ' of ' + sent + ' opened';
  document.getElementById('kpi-click').textContent  = pct(clicked, sent);
  document.getElementById('kpi-click-sub').textContent = clicked + ' clicked Calendly';
  document.getElementById('kpi-reply').textContent  = pct(replied, sent);
  document.getElementById('kpi-reply-sub').textContent = replied + ' replied';
  document.getElementById('kpi-fu1').textContent    = fu1;
  document.getElementById('kpi-fu1-sub').textContent   = pct(fu1, sent) + ' of sent';
  document.getElementById('kpi-fu2').textContent    = fu2;
  document.getElementById('kpi-fu2-sub').textContent   = pct(fu2, sent) + ' of sent';

  // Source performance chart
  var srcNames = { linkedin: 'LinkedIn', indeed: 'Indeed', ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', monster: 'Monster', craigslist: 'Craigslist', reddit: 'Reddit', acctg_software: 'Acctg Software', new_business: 'New Business', google_places: 'Google Places', intent: 'Intent' };
  var srcMap = {};
  leads.forEach(function(l) {
    var src = l.source || l.intentSource || (l.placeId ? 'google_places' : 'other');
    if (!srcMap[src]) srcMap[src] = { sent: 0, opened: 0, replied: 0 };
    srcMap[src].sent++;
    if (l.openCount > 0) srcMap[src].opened++;
    if (l.replied)       srcMap[src].replied++;
  });
  var srcKeys = Object.keys(srcMap).sort(function(a, b) { return srcMap[b].sent - srcMap[a].sent; });

  // A/B stats
  function abStats(arr) {
    return { sent: arr.length, opened: arr.filter(function(l) { return l.openCount > 0; }).length, clicked: arr.filter(function(l) { return l.clicked; }).length, replied: arr.filter(function(l) { return l.replied; }).length };
  }
  var sA = abStats(leads.filter(function(l) { return l.emailVariant === 'A'; }));
  var sB = abStats(leads.filter(function(l) { return l.emailVariant === 'B'; }));

  // Draw charts
  renderKpiActivityChart(leads);
  if (srcKeys.length) renderSourceChart(srcKeys, srcMap, srcNames);
  renderABChart(sA, sB);
}

// ── Chart.js helpers ──────────────────────────────────────────────────────────

var chartOverview = null, chartKpiActivity = null, chartSources = null, chartAB = null;

function chartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = '#30363d';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
}
chartDefaults();

function makeGradient(ctx, color, alpha1, alpha2) {
  var g = ctx.createLinearGradient(0, 0, 0, 220);
  g.addColorStop(0, color.replace('1)', alpha1 + ')'));
  g.addColorStop(1, color.replace('1)', alpha2 + ')'));
  return g;
}

var TOOLTIP_OPTS = {
  backgroundColor: '#1c2333',
  borderColor: '#30363d',
  borderWidth: 1,
  padding: 10,
  titleColor: '#e6edf3',
  bodyColor: '#8b949e',
  cornerRadius: 8,
};

function areaDataset(label, data, hexColor, grad) {
  return { label: label, data: data, borderColor: hexColor, backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: hexColor, borderWidth: 2 };
}

function lineChartOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 8, padding: 18, usePointStyle: true, pointStyleWidth: 8 } },
      tooltip: TOOLTIP_OPTS,
    },
    scales: {
      x: { grid: { color: '#21262d' }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
      y: { grid: { color: '#21262d' }, beginAtZero: true, ticks: { precision: 0 } }
    }
  };
}

function buildDailyData(leads, days) {
  var sent = {}, opened = {}, replied = {};
  days.forEach(function(d) { sent[d] = 0; opened[d] = 0; replied[d] = 0; });
  leads.forEach(function(l) {
    var d = (l.emailSentAt || '').slice(0, 10);
    if (sent[d] !== undefined) {
      sent[d]++;
      if (l.openCount > 0) opened[d]++;
      if (l.replied) replied[d]++;
    }
  });
  return { sent: sent, opened: opened, replied: replied };
}

function dayLabels(days) {
  return days.map(function(d) {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
}

// Overview: 14-day activity area chart
function renderOverviewChart() {
  if (!window.Chart) return;
  var canvas = document.getElementById('ov-chart');
  if (!canvas) return;

  var days = [];
  var now = new Date();
  for (var i = 13; i >= 0; i--) {
    var d = new Date(now); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  var daily = buildDailyData(outboundLeads, days);
  var labels = dayLabels(days);
  var ctx = canvas.getContext('2d');

  if (chartOverview) { chartOverview.destroy(); chartOverview = null; }

  chartOverview = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        areaDataset('Emails Sent', days.map(function(d) { return daily.sent[d]; }),   '#58a6ff', makeGradient(ctx, 'rgba(88,166,255,1)',   0.28, 0.02)),
        areaDataset('Opened',      days.map(function(d) { return daily.opened[d]; }), '#e3b341', makeGradient(ctx, 'rgba(227,179,65,1)',    0.22, 0.01)),
        areaDataset('Replied',     days.map(function(d) { return daily.replied[d]; }),'#3fb950', makeGradient(ctx, 'rgba(63,185,80,1)',     0.22, 0.01)),
      ]
    },
    options: lineChartOptions()
  });
}

// KPI: activity line chart for selected period
function renderKpiActivityChart(leads) {
  if (!window.Chart) return;
  var canvas = document.getElementById('kpi-activity-chart');
  if (!canvas) return;

  // Build day range from kpiFrom → kpiTo (cap at 90 days)
  var from = kpiFrom || new Date(Date.now() - 29 * 86400000);
  var to   = kpiTo   || new Date();
  var days = [], cur = new Date(from);
  while (cur <= to && days.length < 90) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }

  var daily = buildDailyData(leads, days);
  var labels = dayLabels(days);
  var ctx = canvas.getContext('2d');

  if (chartKpiActivity) { chartKpiActivity.destroy(); chartKpiActivity = null; }

  chartKpiActivity = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        areaDataset('Emails Sent', days.map(function(d) { return daily.sent[d]; }),   '#58a6ff', makeGradient(ctx, 'rgba(88,166,255,1)',   0.28, 0.02)),
        areaDataset('Opened',      days.map(function(d) { return daily.opened[d]; }), '#e3b341', makeGradient(ctx, 'rgba(227,179,65,1)',    0.22, 0.01)),
        areaDataset('Replied',     days.map(function(d) { return daily.replied[d]; }),'#3fb950', makeGradient(ctx, 'rgba(63,185,80,1)',     0.22, 0.01)),
      ]
    },
    options: lineChartOptions()
  });
}

// KPI: source horizontal bar chart
function renderSourceChart(srcKeys, srcMap, srcNames) {
  if (!window.Chart) return;
  var canvas = document.getElementById('kpi-source-chart');
  if (!canvas) return;

  // Set container height dynamically: ~48px per source, min 200
  var h = Math.max(200, srcKeys.length * 52);
  canvas.parentElement.style.minHeight = h + 'px';

  if (chartSources) { chartSources.destroy(); chartSources = null; }

  chartSources = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: srcKeys.map(function(k) { return srcNames[k] || k; }),
      datasets: [
        { label: 'Sent',    data: srcKeys.map(function(k) { return srcMap[k].sent; }),    backgroundColor: 'rgba(88,166,255,0.65)',  borderColor: '#58a6ff', borderWidth: 1, borderRadius: 4 },
        { label: 'Opened',  data: srcKeys.map(function(k) { return srcMap[k].opened; }),  backgroundColor: 'rgba(227,179,65,0.7)',   borderColor: '#e3b341', borderWidth: 1, borderRadius: 4 },
        { label: 'Replied', data: srcKeys.map(function(k) { return srcMap[k].replied; }), backgroundColor: 'rgba(63,185,80,0.7)',    borderColor: '#3fb950', borderWidth: 1, borderRadius: 4 },
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 8, padding: 14, usePointStyle: true, pointStyleWidth: 8 } },
        tooltip: TOOLTIP_OPTS,
      },
      scales: {
        x: { grid: { color: '#21262d' }, beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { color: 'transparent' } }
      }
    }
  });
}

// KPI: A/B grouped bar chart
function renderABChart(sA, sB) {
  if (!window.Chart) return;
  var canvas = document.getElementById('kpi-ab-chart');
  if (!canvas) return;

  if (chartAB) { chartAB.destroy(); chartAB = null; }

  chartAB = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Sent', 'Opened', 'Clicked', 'Replied'],
      datasets: [
        { label: 'Variant A', data: [sA.sent, sA.opened, sA.clicked, sA.replied], backgroundColor: 'rgba(88,166,255,0.7)',  borderColor: '#58a6ff', borderWidth: 1, borderRadius: 5 },
        { label: 'Variant B', data: [sB.sent, sB.opened, sB.clicked, sB.replied], backgroundColor: 'rgba(188,140,255,0.7)', borderColor: '#bc8cff', borderWidth: 1, borderRadius: 5 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 8, padding: 14, usePointStyle: true, pointStyleWidth: 8 } },
        tooltip: TOOLTIP_OPTS,
      },
      scales: {
        x: { grid: { color: '#21262d' } },
        y: { grid: { color: '#21262d' }, beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

// Initialize KPI date range to last 30 days on page load
(function() {
  var now = new Date();
  var from = new Date(now); from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0);
  kpiFrom = from; kpiTo = new Date(now); kpiTo.setHours(23, 59, 59, 999);
  var fmt = function(d) { return d.toISOString().slice(0, 10); };
  document.addEventListener('DOMContentLoaded', function() {
    var fi = document.getElementById('kpi-from');
    var ti = document.getElementById('kpi-to');
    if (fi) fi.value = fmt(from);
    if (ti) ti.value = fmt(kpiTo);
  });
})();

function exportObCsv() {
  var cols = ['name', 'email', 'phone', 'website', 'industry', 'city', 'status', 'score', 'source',
              'emailSentAt', 'openCount', 'clicked', 'replied', 'followUpSent', 'secondFollowUpSent'];
  var header = cols.join(',');
  var rows = outboundLeads.map(function(l) {
    return cols.map(function(c) {
      var v = l[c] == null ? '' : String(l[c]);
      return v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0
        ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',');
  });
  var csv = [header].concat(rows).join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'outbound-leads-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

loadAll();
setInterval(loadAll, 60000);
