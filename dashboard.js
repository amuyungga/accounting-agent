var BASE = window.location.origin;
var chatLeads = [], outboundLeads = [], callLogs = [];
var crmContacts = [], crmDeals = [];
var obCurFilter = 'all', caCurFilter = 'all', crmCurFilter = 'all';

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
  var leads = chatLeads.slice().reverse();
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
    renderObStats(); renderOutbound();
  }).catch(function(e) {
    document.getElementById('ob-tbody').innerHTML = '<tr><td colspan="6" class="empty"><span class="empty-icon">⚠️</span>Error: ' + e.message + '</td></tr>';
  });
}

function renderObStats() {
  animateCount('ob-total', outboundLeads.length);
  animateCount('ob-emailed', outboundLeads.filter(function(l) { return l.status === 'emailed'; }).length);
  animateCount('ob-found', outboundLeads.filter(function(l) { return l.status === 'email_found'; }).length);
  animateCount('ob-noemail', outboundLeads.filter(function(l) { return l.status === 'no_email' || l.status === 'no_website'; }).length);
}

function obFilter(btn, f) {
  obCurFilter = f;
  document.querySelectorAll('#s-outbound .filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderOutbound();
}

function renderOutbound() {
  var q = (document.getElementById('ob-s').value || '').toLowerCase();
  var leads = outboundLeads;
  if (obCurFilter !== 'all') leads = leads.filter(function(l) { return l.status === obCurFilter; });
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
    .then(function() { loadOutbound(); })
    .catch(function() { btn.disabled = false; btn.textContent = 'Mark Replied'; });
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
  var logs = callLogs;
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
  var em = outboundLeads.filter(function(l) { return l.status === 'emailed'; }).length;
  animateCount('ov-chat', chatLeads.length);
  animateCount('ov-emailed', em);
  animateCount('ov-calls', callLogs.length);
  animateCount('ov-crm', crmContacts.length);
  animateCount('ov-total', chatLeads.length + em + callLogs.length);
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
  var contacts = crmContacts;
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

loadAll();
setInterval(loadAll, 60000);
