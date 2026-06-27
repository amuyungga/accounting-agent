var BASE = window.location.origin;
var chatLeads = [], outboundLeads = [], callLogs = [];
var obCurFilter = 'all', caCurFilter = 'all';

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

function loadAll() {
  Promise.all([loadChat(), loadOutbound(), loadCalls()]).then(function() {
    updateOverview();
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  });
}

function loadChat() {
  return fetch(BASE + '/leads').then(function(r) { return r.json(); }).then(function(d) {
    chatLeads = d; renderChatStats(); renderChat();
  }).catch(function(e) {
    document.getElementById('ch-tbody').innerHTML = '<tr><td colspan="6" class="empty">Error: ' + e.message + '</td></tr>';
  });
}

function renderChatStats() {
  var today = new Date().toDateString();
  var wk = Date.now() - 7 * 24 * 60 * 60 * 1000;
  document.getElementById('ch-total').textContent = chatLeads.length;
  document.getElementById('ch-today').textContent = chatLeads.filter(function(l) { return new Date(l.capturedAt).toDateString() === today; }).length;
  document.getElementById('ch-week').textContent = chatLeads.filter(function(l) { return new Date(l.capturedAt) > wk; }).length;
  var counts = {};
  chatLeads.forEach(function(l) { if (l.service) counts[l.service] = (counts[l.service] || 0) + 1; });
  var entries = Object.keys(counts).map(function(k) { return [k, counts[k]]; });
  entries.sort(function(a, b) { return b[1] - a[1]; });
  document.getElementById('ch-top').textContent = entries.length ? entries[0][0] : '-';
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
    document.getElementById('ch-tbody').innerHTML = '<tr><td colspan="6" class="empty">No leads yet.</td></tr>';
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
    document.getElementById('ob-tbody').innerHTML = '<tr><td colspan="6" class="empty">Error: ' + e.message + '</td></tr>';
  });
}

function renderObStats() {
  document.getElementById('ob-total').textContent = outboundLeads.length;
  document.getElementById('ob-emailed').textContent = outboundLeads.filter(function(l) { return l.status === 'emailed'; }).length;
  document.getElementById('ob-found').textContent = outboundLeads.filter(function(l) { return l.status === 'email_found'; }).length;
  document.getElementById('ob-noemail').textContent = outboundLeads.filter(function(l) { return l.status === 'no_email' || l.status === 'no_website'; }).length;
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
    document.getElementById('ob-tbody').innerHTML = '<tr><td colspan="6" class="empty">No leads yet.</td></tr>';
    return;
  }
  document.getElementById('ob-tbody').innerHTML = leads.map(function(l) {
    var prev = (l.emailContent || '').replace(/Subject:[^\n]+\n?/, '').trim().slice(0, 180);
    var contact = l.email ? '<a href="mailto:' + E(l.email) + '">' + E(l.email) + '</a>' : '<span class="td-muted">-</span>';
    if (l.phone) contact += '<div class="bs">' + E(l.phone) + '</div>';
    if (l.website) contact += '<div class="bs"><a href="' + E(l.website) + '" target="_blank">website</a></div>';
    return '<tr>' +
      '<td><div class="bn">' + E(l.name || '-') + '</div><div class="bs">' + E(l.address || '') + '</div></td>' +
      '<td>' + contact + '</td>' +
      '<td><span class="badge b-' + (l.status || 'other') + '">' + obLabel(l.status) + '</span></td>' +
      '<td>' + (l.industry ? '<span class="bi">' + E(l.industry) + '</span>' : '-') + '</td>' +
      '<td><div class="ep">' + E(prev || '-') + '</div></td>' +
      '<td class="td-xs">' + D(l.emailSentAt || l.foundAt) + '</td>' +
      '</tr>';
  }).join('');
  document.querySelectorAll('.ep').forEach(function(el) {
    el.addEventListener('click', function() { this.classList.toggle('open'); });
  });
}

function obLabel(s) {
  var map = { emailed: 'Emailed', found: 'Found', email_found: 'Email Found', no_email: 'No Email', no_website: 'No Website', error: 'Error' };
  return map[s] || (s || '-');
}

function loadCalls() {
  return fetch(BASE + '/calls').then(function(r) { return r.json(); }).then(function(d) {
    callLogs = Array.isArray(d) ? d : (d.results || []);
    renderCaStats(); renderCalls();
  }).catch(function(e) {
    document.getElementById('ca-tbody').innerHTML = '<tr><td colspan="6" class="empty">Error: ' + e.message + '</td></tr>';
  });
}

function renderCaStats() {
  var ans = callLogs.filter(function(c) { return caStatus(c) === 'ended'; }).length;
  var durs = callLogs.filter(function(c) { return c.duration > 0; }).map(function(c) { return c.duration; });
  var avg = durs.length ? durs.reduce(function(a, b) { return a + b; }, 0) / durs.length : 0;
  var cost = callLogs.reduce(function(s, c) { return s + (c.cost || 0); }, 0);
  document.getElementById('ca-total').textContent = callLogs.length;
  document.getElementById('ca-answered').textContent = ans;
  document.getElementById('ca-duration').textContent = avg ? dur(avg) : '-';
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
    document.getElementById('ca-tbody').innerHTML = '<tr><td colspan="6" class="empty">No calls yet.</td></tr>';
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
  document.getElementById('m-meta').textContent = D(c.startedAt || c.createdAt) + ' - ' + dur(c.duration);
  var summary = c.summary || (c.analysis && c.analysis.summary);
  document.getElementById('m-summary').innerHTML = summary || '<span class="nd">No summary</span>';
  document.getElementById('m-sum-wrap').style.display = summary ? '' : 'none';
  var tx = c.transcript || ((c.messages || []).map(function(m) { return m.role + ': ' + m.message; }).join('\n'));
  document.getElementById('m-transcript').innerHTML = tx || '<span class="nd">No transcript</span>';
  document.getElementById('call-modal').classList.add('open');
}

function updateOverview() {
  var em = outboundLeads.filter(function(l) { return l.status === 'emailed'; }).length;
  document.getElementById('ov-chat').textContent = chatLeads.length;
  document.getElementById('ov-emailed').textContent = em;
  document.getElementById('ov-calls').textContent = callLogs.length;
  document.getElementById('ov-total').textContent = chatLeads.length + em + callLogs.length;
  var ev = [].concat(
    chatLeads.map(function(l) { return { t: 'Chat', n: l.name || 'Unknown', c: l.email || '', d: l.service || '-', dt: l.capturedAt }; }),
    outboundLeads.filter(function(l) { return l.status === 'emailed'; }).map(function(l) { return { t: 'Email', n: l.name || 'Unknown', c: l.email || '', d: l.industry || '-', dt: l.emailSentAt || l.foundAt }; }),
    callLogs.map(function(c) { return { t: 'Call', n: (c.customer && (c.customer.number || c.customer.name)) || 'Unknown', c: '', d: (c.endedReason || '-').replace(/-/g, ' '), dt: c.startedAt || c.createdAt }; })
  ).sort(function(a, b) { return new Date(b.dt) - new Date(a.dt); }).slice(0, 20);
  document.getElementById('ov-tbody').innerHTML = ev.length
    ? ev.map(function(e) {
        return '<tr>' +
          '<td>' + e.t + '</td>' +
          '<td><strong>' + E(e.n) + '</strong></td>' +
          '<td class="td-sm">' + E(e.c) + '</td>' +
          '<td class="td-cap">' + E(e.d) + '</td>' +
          '<td class="td-xs">' + D(e.dt) + '</td>' +
          '</tr>';
      }).join('')
    : '<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
}

function E(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function D(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}
function dur(s) {
  if (!s) return '-';
  var m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
}

loadAll();
setInterval(loadAll, 60000);
