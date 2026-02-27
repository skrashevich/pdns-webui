'use strict';

/* =================================================================
   PowerDNS Web UI – Single-Page Application
   ================================================================= */

// ---- State -------------------------------------------------------
const state = {
  serverId: 'localhost',
  uiVersion: 'n/a',
  pdnsVersion: 'n/a',
  currentView: null,
  currentZone: null,   // full zone object when in records view
  zones: [],           // cached list for quick lookups
  rrsets: [],          // rrsets for current zone
  selectedZones: new Set(),
  selectedRecords: new Set(),
  autoprimaries: [],
};

// ---- HTTP helpers ------------------------------------------------
const http = {
  async request(method, path, data) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data !== undefined && data !== null) {
      opts.body = JSON.stringify(data);
    }

    const resp = await fetch(`/api/pdns/${path}`, opts);

    if (resp.status === 204) return null;

    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { message: text }; }

    if (!resp.ok) {
      const msg = json?.error || json?.message || json?.result || `HTTP ${resp.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return json;
  },

  get:    (p)    => http.request('GET',    p),
  post:   (p, d) => http.request('POST',   p, d),
  put:    (p, d) => http.request('PUT',    p, d ?? {}),
  patch:  (p, d) => http.request('PATCH',  p, d),
  del:    (p)    => http.request('DELETE', p),
};

// ---- PowerDNS API wrappers ---------------------------------------
const pdns = {
  listZones:     ()        => http.get(`servers/${state.serverId}/zones`),
  getZone:       (id)      => http.get(`servers/${state.serverId}/zones/${enc(id)}`),
  getServerInfo: ()        => http.get(`servers/${state.serverId}`),
  createZone:    (data)    => http.post(`servers/${state.serverId}/zones`, data),
  updateZone:    (id, d)   => http.put(`servers/${state.serverId}/zones/${enc(id)}`, d),
  deleteZone:    (id)      => http.del(`servers/${state.serverId}/zones/${enc(id)}`),
  notifyZone:    (id)      => http.put(`servers/${state.serverId}/zones/${enc(id)}/notify`),
  exportZone:    (id)      => http.get(`servers/${state.serverId}/zones/${enc(id)}/export`),
  updateRRsets:  (id, rrs) => http.patch(`servers/${state.serverId}/zones/${enc(id)}`, { rrsets: rrs }),
  searchData:       (q)          => http.get(`servers/${state.serverId}/search-data?q=${encodeURIComponent(q)}&max=100&object_type=record`),
  axfrRetrieve:     (id)         => http.put(`servers/${state.serverId}/zones/${enc(id)}/axfr-retrieve`),
  getStatistics:    ()           => http.get(`servers/${state.serverId}/statistics`),
  getZoneMetadata:  (id)         => http.get(`servers/${state.serverId}/zones/${enc(id)}/metadata`),
  setZoneMeta:      (id, k, v)   => http.put(`servers/${state.serverId}/zones/${enc(id)}/metadata/${encodeURIComponent(k)}`, { kind: k, metadata: v }),
  deleteZoneMeta:   (id, k)      => http.del(`servers/${state.serverId}/zones/${enc(id)}/metadata/${encodeURIComponent(k)}`),
  listAutoprimaries:  ()         => http.get(`servers/${state.serverId}/autoprimaries`),
  createAutoprimary:  (data)     => http.post(`servers/${state.serverId}/autoprimaries`, data),
  deleteAutoprimary:  (ip, ns)   => http.del(`servers/${state.serverId}/autoprimaries/${encodeURIComponent(ip)}/${encodeURIComponent(ns)}`),
};

// Encode zone IDs for use in URL paths
function enc(id) {
  // Zone IDs are FQDNs like "example.com." – dots are safe but we still
  // need to encode any percent or space characters just in case.
  return id.replace(/%/g, '%25').replace(/ /g, '%20');
}

// ---- UI helpers --------------------------------------------------
const ui = {
  showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const id = `t${Date.now()}`;
    const icon = { success: 'check-circle-fill', danger: 'exclamation-triangle-fill',
                   warning: 'exclamation-circle-fill', info: 'info-circle-fill' }[type] || 'info-circle-fill';
    container.insertAdjacentHTML('beforeend', `
      <div id="${id}" class="toast align-items-center text-bg-${type} border-0" role="alert">
        <div class="d-flex">
          <div class="toast-body">
            <i class="bi bi-${icon} me-2"></i>${esc(message)}
          </div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>`);
    const el = document.getElementById(id);
    const toast = new bootstrap.Toast(el, { delay: 4500 });
    toast.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  },

  setLoading(on) {
    document.getElementById('global-spinner').style.display = on ? '' : 'none';
  },

  setContent(html) {
    document.getElementById('main-content').innerHTML = html;
  },

  setBreadcrumb(html) {
    document.getElementById('breadcrumb').innerHTML = html;
  },
};

function setFooterVersion(id, prefix, version) {
  const el = document.getElementById(id);
  if (!el) return;

  const raw = version == null ? '' : String(version).trim();
  el.textContent = `${prefix} ${raw || 'n/a'}`;
}

async function refreshPDNSVersion() {
  try {
    const info = await pdns.getServerInfo();
    state.pdnsVersion = info?.version || info?.daemon_version || info?.packageversion || 'n/a';
  } catch {
    state.pdnsVersion = 'n/a';
  }

  setFooterVersion('pdns-version', 'pdns', state.pdnsVersion);
}

// ---- Theme --------------------------------------------------------
const theme = {
  storageKey: 'pdns-ui-theme',
  mediaQuery: null,
  current: 'light',

  readStored() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored === 'light' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  },

  save(value) {
    try {
      localStorage.setItem(this.storageKey, value);
    } catch {
      // Ignore storage failures (private mode or blocked storage).
    }
  },

  apply(value) {
    this.current = value === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', this.current);
    document.documentElement.setAttribute('data-bs-theme', this.current);
    this.updateToggleButton();
  },

  updateToggleButton() {
    const icon = document.getElementById('theme-toggle-icon');
    const btn = document.getElementById('theme-toggle-btn');
    if (!icon || !btn) return;

    if (this.current === 'dark') {
      icon.className = 'bi bi-sun-fill';
      btn.setAttribute('title', 'Light mode');
      btn.setAttribute('aria-label', 'Switch to light mode');
      return;
    }

    icon.className = 'bi bi-moon-stars-fill';
    btn.setAttribute('title', 'Night mode');
    btn.setAttribute('aria-label', 'Switch to night mode');
  },

  init() {
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const stored = this.readStored();
    const initial = stored || (this.mediaQuery.matches ? 'dark' : 'light');
    this.apply(initial);

    const onChange = (event) => {
      if (this.readStored()) return;
      this.apply(event.matches ? 'dark' : 'light');
    };

    if (typeof this.mediaQuery.addEventListener === 'function') {
      this.mediaQuery.addEventListener('change', onChange);
    } else if (typeof this.mediaQuery.addListener === 'function') {
      this.mediaQuery.addListener(onChange);
    }
  },

  toggle() {
    const next = this.current === 'dark' ? 'light' : 'dark';
    this.save(next);
    this.apply(next);
  },
};

function toggleTheme() {
  theme.toggle();
}

// ---- Utility functions -------------------------------------------
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fqdn(name) {
  if (!name) return name;
  name = name.trim();
  return name.endsWith('.') ? name : name + '.';
}

function stripDot(name) {
  return (name && name.endsWith('.')) ? name.slice(0, -1) : (name || '');
}

function relativeName(name, zoneName) {
  const n = fqdn(name);
  const z = fqdn(zoneName);
  if (n === z) return '@';
  if (n.endsWith('.' + z)) return n.slice(0, -(z.length + 1));
  return n;
}

function absoluteName(name, zoneName) {
  if (!name || name === '@') return fqdn(zoneName);
  if (name.endsWith('.')) return name;
  return `${name}.${fqdn(zoneName)}`;
}

function kindBadge(kind) {
  const cls = { Native: 'badge-kind-native', Master: 'badge-kind-master', Slave: 'badge-kind-slave' }[kind] || 'badge-kind-native';
  return `<span class="badge ${cls}">${esc(kind)}</span>`;
}

function typeBadge(type) {
  const known = ['A','AAAA','CNAME','MX','NS','TXT','SOA','SRV','PTR','CAA'];
  const cls = known.includes(type) ? `badge-type-${type}` : 'badge-type-other';
  return `<span class="badge-type ${cls}">${esc(type)}</span>`;
}

function formatUptime(seconds) {
  const s = parseInt(seconds) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// ---- Checkbox helpers --------------------------------------------
function onZoneCheckboxChange() {
  state.selectedZones = new Set(
    [...document.querySelectorAll('.zone-select:checked')].map(el => el.value)
  );
  const selectAll = document.getElementById('select-all-zones');
  const allBoxes = document.querySelectorAll('.zone-select');
  if (selectAll) {
    selectAll.checked = allBoxes.length > 0 && state.selectedZones.size === allBoxes.length;
    selectAll.indeterminate = state.selectedZones.size > 0 && state.selectedZones.size < allBoxes.length;
  }
  const btn = document.getElementById('bulk-delete-zones-btn');
  if (btn) btn.style.display = state.selectedZones.size > 0 ? '' : 'none';
}

function onRecordCheckboxChange() {
  state.selectedRecords = new Set(
    [...document.querySelectorAll('.record-select:checked')].map(el => el.value)
  );
  const selectAll = document.getElementById('select-all-records');
  const allBoxes = document.querySelectorAll('.record-select:not(:disabled)');
  if (selectAll) {
    selectAll.checked = allBoxes.length > 0 && state.selectedRecords.size === allBoxes.length;
    selectAll.indeterminate = state.selectedRecords.size > 0 && state.selectedRecords.size < allBoxes.length;
  }
  const btn = document.getElementById('bulk-delete-records-btn');
  if (btn) btn.style.display = state.selectedRecords.size > 0 ? '' : 'none';
}

// ---- Statistics loader -------------------------------------------
async function loadStats() {
  const el = document.getElementById('stats-content');
  if (!el) return;
  try {
    const raw = await pdns.getStatistics();
    const map = {};
    (raw || []).forEach(item => { if (item.type === 'StatisticItem') map[item.name] = item.value; });

    const groups = [
      { title: 'Queries', icon: 'bi-question-circle', metrics: [
        { key: 'udp-queries',  label: 'UDP Queries' },
        { key: 'tcp-queries',  label: 'TCP Queries' },
        { key: 'udp6-queries', label: 'UDP6 Queries' },
        { key: 'tcp6-queries', label: 'TCP6 Queries' },
      ]},
      { title: 'Cache', icon: 'bi-lightning', metrics: [
        { key: 'cache-hits',       label: 'Cache Hits' },
        { key: 'cache-misses',     label: 'Cache Misses' },
        { key: 'packetcache-hit',  label: 'Packet Cache Hits' },
        { key: 'packetcache-miss', label: 'Packet Cache Misses' },
      ]},
      { title: 'Errors', icon: 'bi-exclamation-triangle', metrics: [
        { key: 'servfail-packets', label: 'SERVFAIL' },
        { key: 'timedout-packets', label: 'Timed Out' },
      ]},
      { title: 'System', icon: 'bi-cpu', metrics: [
        { key: 'uptime',            label: 'Uptime',           format: formatUptime },
        { key: 'real-memory-usage', label: 'Memory',           format: v => `${Math.round(parseInt(v) / 1024 / 1024)} MB` },
        { key: 'fd-usage',          label: 'File Descriptors' },
      ]},
    ];

    el.innerHTML = groups.map(g => `
      <div class="mb-4">
        <h6 class="text-muted mb-2"><i class="bi ${esc(g.icon)} me-1"></i>${esc(g.title)}</h6>
        <div class="stats-grid">
          ${g.metrics.map(m => {
            const rawVal = map[m.key];
            const val = rawVal == null ? '—' : (m.format ? m.format(rawVal) : rawVal);
            return `<div class="stat-card">
              <div class="stat-value">${esc(String(val))}</div>
              <div class="stat-label">${esc(m.label)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('');
  } catch (err) {
    el.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
}

// ---- Views -------------------------------------------------------
const views = {

  // ----- Zones list -----
  async zones() {
    state.selectedZones = new Set();
    ui.setBreadcrumb('Zones');
    ui.setContent(`<div class="d-flex justify-content-center align-items-center" style="height:50vh">
      <div class="spinner-border text-primary"></div></div>`);
    ui.setLoading(true);
    try {
      const zones = await pdns.listZones();
      state.zones = zones || [];
      ui.setLoading(false);

      const rows = state.zones.length
        ? state.zones
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((z, i) => `
          <tr>
            <td style="width:1%">
              <input type="checkbox" class="form-check-input zone-select" value="${esc(z.id)}"
                onchange="onZoneCheckboxChange()">
            </td>
            <td>
              <a href="#" class="fw-medium text-decoration-none"
                 onclick="navigate('records','${esc(z.id)}');return false;">
                ${esc(stripDot(z.name))}
              </a>
            </td>
            <td>${kindBadge(z.kind)}</td>
            <td class="font-monospace">${esc(z.serial ?? '—')}</td>
            <td class="text-muted small">${z.kind === 'Slave' ? esc((z.masters || []).join(', ') || '—') : '—'}</td>
            <td>
              <div class="btn-group btn-group-sm btn-group-actions">
                <button class="btn btn-outline-primary" title="Records"
                  onclick="navigate('records','${esc(z.id)}')">
                  <i class="bi bi-list-ul"></i>
                </button>
                ${z.kind === 'Master' || z.kind === 'Native' ? `
                <button class="btn btn-outline-warning" title="Notify slaves"
                  onclick="handlers.notifyZone(${i})">
                  <i class="bi bi-broadcast"></i>
                </button>` : ''}
                ${z.kind === 'Slave' ? `
                <button class="btn btn-outline-secondary" title="Retrieve from master (AXFR)"
                  onclick="handlers.axfrRetrieve(${i})">
                  <i class="bi bi-cloud-download"></i>
                </button>` : ''}
                <button class="btn btn-outline-secondary" title="Export zone"
                  onclick="handlers.exportZone(${i})">
                  <i class="bi bi-download"></i>
                </button>
                <button class="btn btn-outline-secondary" title="Edit"
                  onclick="handlers.showZoneEdit(${i})">
                  <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-outline-danger" title="Delete"
                  onclick="handlers.deleteZone(${i})">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </td>
          </tr>`)
            .join('')
        : `<tr><td colspan="6">
            <div class="empty-state">
              <i class="bi bi-inbox"></i>
              No zones found. Create your first zone to get started.
            </div></td></tr>`;

      ui.setContent(`
        <div class="page-header">
          <h2><i class="bi bi-globe2 me-2 text-primary"></i>Zones</h2>
          <span class="badge bg-secondary ms-1">${state.zones.length}</span>
          <div class="ms-auto d-flex gap-2">
            <button class="btn btn-outline-danger" id="bulk-delete-zones-btn" style="display:none"
              onclick="handlers.bulkDeleteZones()">
              <i class="bi bi-trash me-1"></i>Delete Selected
            </button>
            <button class="btn btn-primary" onclick="handlers.showZoneCreate()">
              <i class="bi bi-plus-lg me-1"></i>Add Zone
            </button>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th style="width:1%">
                    <input type="checkbox" id="select-all-zones" class="form-check-input"
                      onchange="document.querySelectorAll('.zone-select').forEach(cb=>cb.checked=this.checked);onZoneCheckboxChange()">
                  </th>
                  <th>Zone Name</th>
                  <th>Type</th>
                  <th>Serial</th>
                  <th>Masters</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`);
    } catch (err) {
      ui.setLoading(false);
      ui.setContent(`
        <div class="alert alert-danger shadow-sm">
          <h5 class="alert-heading"><i class="bi bi-exclamation-triangle me-2"></i>Connection error</h5>
          <p class="mb-2">${esc(err.message)}</p>
          <hr class="my-2">
          <p class="mb-0 small">Check that PowerDNS is running and the API settings are correct.
            <a href="#" onclick="navigate('settings');return false;">Open Settings</a></p>
        </div>`);
    }
  },

  // ----- Zone records -----
  async records(zoneId) {
    state.selectedRecords = new Set();
    ui.setBreadcrumb(`<a href="#" onclick="navigate('zones');return false;">Zones</a> / Loading…`);
    ui.setContent(`<div class="d-flex justify-content-center align-items-center" style="height:50vh">
      <div class="spinner-border text-primary"></div></div>`);
    ui.setLoading(true);
    try {
      const zone = await pdns.getZone(zoneId);
      state.currentZone = zone;

      const rrsets = (zone.rrsets || []).sort((a, b) => {
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return a.type < b.type ? -1 : 1;
      });
      state.rrsets = rrsets;
      ui.setLoading(false);

      ui.setBreadcrumb(
        `<a href="#" onclick="navigate('zones');return false;">Zones</a> / <strong>${esc(stripDot(zone.name))}</strong>`
      );

      const rows = rrsets.length
        ? rrsets.map((rr, i) => {
            const relN  = relativeName(rr.name, zone.name);
            const rrKey = `${rr.name}|${rr.type}`;
            const content = (rr.records || [])
              .map(r => `<div class="record-content ${r.disabled ? 'disabled-record' : ''}">${esc(r.content)}</div>`)
              .join('');
            return `
          <tr>
            <td style="width:1%">
              <input type="checkbox" class="form-check-input record-select" value="${esc(rrKey)}"
                onchange="onRecordCheckboxChange()"${rr.type === 'SOA' ? ' disabled' : ''}>
            </td>
            <td class="font-monospace">${esc(relN)}</td>
            <td>${typeBadge(rr.type)}</td>
            <td>${esc(rr.ttl)}</td>
            <td>${content}</td>
            <td>
              <div class="btn-group btn-group-sm btn-group-actions">
                <button class="btn btn-outline-secondary" title="Edit"
                  onclick="handlers.showRecordEdit(${i})">
                  <i class="bi bi-pencil"></i>
                </button>
                ${rr.type !== 'SOA' ? `
                <button class="btn btn-outline-danger" title="Delete"
                  onclick="handlers.deleteRecord(${i})">
                  <i class="bi bi-trash"></i>
                </button>` : ''}
              </div>
            </td>
          </tr>`;
          }).join('')
        : `<tr><td colspan="6"><div class="empty-state">
            <i class="bi bi-inbox"></i>No records in this zone.</div></td></tr>`;

      const notifyBtn = (zone.kind === 'Master' || zone.kind === 'Native') ? `
        <button class="btn btn-outline-warning" onclick="handlers.notifyCurrentZone()" title="Send NOTIFY to slaves">
          <i class="bi bi-broadcast me-1"></i>Notify Slaves
        </button>` : '';

      const axfrBtn = zone.kind === 'Slave' ? `
        <button class="btn btn-outline-secondary" onclick="handlers.axfrRetrieveCurrentZone()" title="Retrieve zone from master">
          <i class="bi bi-cloud-download me-1"></i>Retrieve
        </button>` : '';

      ui.setContent(`
        <div class="page-header">
          <button class="btn btn-sm btn-outline-secondary me-2" onclick="navigate('zones')">
            <i class="bi bi-arrow-left"></i>
          </button>
          <h2>${esc(stripDot(zone.name))}</h2>
          <span class="ms-2">${kindBadge(zone.kind)}</span>
          <div class="ms-auto d-flex gap-2">
            ${notifyBtn}
            ${axfrBtn}
            <button class="btn btn-outline-danger" id="bulk-delete-records-btn" style="display:none"
              onclick="handlers.bulkDeleteRecords()">
              <i class="bi bi-trash me-1"></i>Delete Selected
            </button>
            <button class="btn btn-outline-secondary" onclick="handlers.showZoneMetadata()" title="Zone metadata">
              <i class="bi bi-sliders me-1"></i>Metadata
            </button>
            <button class="btn btn-outline-secondary" onclick="handlers.exportCurrentZone()" title="Export zone file">
              <i class="bi bi-download me-1"></i>Export
            </button>
            <button class="btn btn-primary" onclick="handlers.showRecordCreate()">
              <i class="bi bi-plus-lg me-1"></i>Add Record
            </button>
          </div>
        </div>

        <div class="card shadow-sm mb-3">
          <div class="card-body py-2">
            <div class="zone-meta">
              <div class="zone-meta-item">
                <small>Serial</small>
                <span class="value font-monospace">${esc(zone.serial ?? '—')}</span>
              </div>
              <div class="zone-meta-item">
                <small>Last Check</small>
                <span class="value">${zone.last_check ? new Date(zone.last_check * 1000).toLocaleString() : '—'}</span>
              </div>
              <div class="zone-meta-item">
                <small>RRsets</small>
                <span class="value">${rrsets.length}</span>
              </div>
              <div class="zone-meta-item">
                <small>Account</small>
                <span class="value">${esc(zone.account || '—')}</span>
              </div>
              ${zone.kind === 'Slave' ? `
              <div class="zone-meta-item">
                <small>Masters</small>
                <span class="value font-monospace">${esc((zone.masters || []).join(', ') || '—')}</span>
              </div>` : ''}
            </div>
          </div>
        </div>

        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th style="width:1%">
                    <input type="checkbox" id="select-all-records" class="form-check-input"
                      onchange="document.querySelectorAll('.record-select:not(:disabled)').forEach(cb=>cb.checked=this.checked);onRecordCheckboxChange()">
                  </th>
                  <th>Name</th><th>Type</th><th>TTL</th><th>Content</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`);
    } catch (err) {
      ui.setLoading(false);
      ui.setContent(`
        <div class="alert alert-danger shadow-sm">
          <strong>Error loading zone:</strong> ${esc(err.message)}
          <div class="mt-2">
            <button class="btn btn-sm btn-outline-secondary" onclick="navigate('zones')">
              <i class="bi bi-arrow-left me-1"></i>Back to Zones
            </button>
          </div>
        </div>`);
    }
  },

  // ----- Autoprimaries -----
  async autoprimaries() {
    ui.setBreadcrumb('Autoprimaries');
    ui.setContent(`<div class="d-flex justify-content-center align-items-center" style="height:50vh">
      <div class="spinner-border text-primary"></div></div>`);
    ui.setLoading(true);
    try {
      const list = await pdns.listAutoprimaries();
      state.autoprimaries = list || [];
      ui.setLoading(false);

      const rows = state.autoprimaries.length
        ? state.autoprimaries.map((a, i) => `
          <tr>
            <td class="font-monospace">${esc(a.ip)}</td>
            <td class="font-monospace">${esc(a.nameserver)}</td>
            <td>${esc(a.account || '—')}</td>
            <td>
              <button class="btn btn-sm btn-outline-danger" onclick="handlers.deleteAutoprimary(${i})" title="Delete">
                <i class="bi bi-trash"></i>
              </button>
            </td>
          </tr>`).join('')
        : `<tr><td colspan="4"><div class="empty-state">
            <i class="bi bi-inbox"></i>No autoprimaries configured.</div></td></tr>`;

      ui.setContent(`
        <div class="page-header">
          <h2><i class="bi bi-hdd-network me-2 text-primary"></i>Autoprimaries</h2>
          <div class="ms-auto">
            <button class="btn btn-primary" onclick="handlers.showAutoprimaryCreate()">
              <i class="bi bi-plus-lg me-1"></i>Add Autoprimary
            </button>
          </div>
        </div>
        <div class="card shadow-sm mb-3">
          <div class="card-body text-muted small">
            Autoprimaries allow PowerDNS to automatically create secondary zones when it
            receives a NOTIFY from a trusted primary. The nameserver must match the NS record
            as seen in the zone from the primary.
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th>IP Address</th>
                  <th>Nameserver</th>
                  <th>Account</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`);
    } catch (err) {
      ui.setLoading(false);
      ui.setContent(`
        <div class="alert alert-danger shadow-sm">
          <h5 class="alert-heading"><i class="bi bi-exclamation-triangle me-2"></i>Error</h5>
          <p>${esc(err.message)}</p>
        </div>`);
    }
  },

  // ----- Search -----
  search() {
    ui.setBreadcrumb('Search');
    ui.setContent(`
      <div class="page-header">
        <h2><i class="bi bi-search me-2 text-primary"></i>Search</h2>
      </div>
      <div class="card shadow-sm mb-3">
        <div class="card-body">
          <div class="input-group">
            <input type="text" class="form-control" id="search-input" placeholder="Search records…"
              onkeydown="if(event.key==='Enter') handlers.runSearch()">
            <button class="btn btn-primary" onclick="handlers.runSearch()">
              <i class="bi bi-search me-1"></i>Search
            </button>
          </div>
        </div>
      </div>
      <div id="search-results"></div>`);
  },

  // ----- Statistics -----
  async statistics() {
    ui.setBreadcrumb('Statistics');
    ui.setContent(`
      <div class="page-header">
        <h2><i class="bi bi-bar-chart-line me-2 text-primary"></i>Statistics</h2>
        <div class="ms-auto">
          <button class="btn btn-outline-secondary" onclick="handlers.refreshStats()">
            <i class="bi bi-arrow-clockwise me-1"></i>Refresh
          </button>
        </div>
      </div>
      <div id="stats-content">
        <div class="d-flex justify-content-center align-items-center" style="height:40vh">
          <div class="spinner-border text-primary"></div>
        </div>
      </div>`);
    await loadStats();
  },

  // ----- Settings -----
  settings() {
    ui.setBreadcrumb('Settings');
    ui.setContent(`
      <div class="page-header"><h2><i class="bi bi-gear me-2 text-primary"></i>Settings</h2></div>

      <div class="card shadow-sm mb-4">
        <div class="card-header">PowerDNS Connection</div>
        <div class="card-body">
          <p class="text-muted mb-3">
            Connection parameters are configured via environment variables on the server.
            Restart the UI application after making changes.
          </p>
          <table class="table table-sm settings-table">
            <tbody>
              <tr>
                <td><code>PDNS_API_URL</code></td>
                <td>PowerDNS API base URL <span class="text-muted">(default: <code>http://localhost:8081</code>)</span></td>
              </tr>
              <tr>
                <td><code>PDNS_API_KEY</code></td>
                <td>API key (<code>api-key</code> in pdns.conf)</td>
              </tr>
              <tr>
                <td><code>PDNS_SERVER_ID</code></td>
                <td>Server identifier <span class="text-muted">(default: <code>localhost</code>)</span></td>
              </tr>
              <tr>
                <td><code>PORT</code></td>
                <td>UI listen port <span class="text-muted">(default: <code>8080</code>)</span></td>
              </tr>
            </tbody>
          </table>
          <div id="conn-status" class="mt-3">
            <span class="spinner-border spinner-border-sm me-2"></span>Testing connection…
          </div>
        </div>
      </div>

      <div class="card shadow-sm">
        <div class="card-header">About</div>
        <div class="card-body text-muted small">
          PowerDNS Web UI v1.0.0 &nbsp;·&nbsp; Targets PowerDNS Authoritative 4.6
        </div>
      </div>`);

    // async: check connection
    pdns.listZones()
      .then(zones => {
        document.getElementById('conn-status').innerHTML = `
          <span class="badge bg-success">
            <i class="bi bi-check-circle me-1"></i>Connected
          </span>
          <span class="text-muted ms-2 small">${(zones || []).length} zones on server <code>${esc(state.serverId)}</code></span>`;
      })
      .catch(err => {
        document.getElementById('conn-status').innerHTML = `
          <span class="badge bg-danger">
            <i class="bi bi-x-circle me-1"></i>Connection failed
          </span>
          <div class="text-danger mt-1 small">${esc(err.message)}</div>`;
      });
  },
};

// ---- Event handlers ----------------------------------------------
const handlers = {

  // === Zone list actions ===
  async notifyZone(idx) {
    const z = state.zones[idx];
    ui.setLoading(true);
    try {
      await pdns.notifyZone(z.id);
      ui.showToast(`NOTIFY sent for ${stripDot(z.name)}`, 'success');
    } catch (err) {
      ui.showToast(`Notify failed: ${err.message}`, 'danger');
    } finally { ui.setLoading(false); }
  },

  async axfrRetrieve(idx) {
    const z = state.zones[idx];
    ui.setLoading(true);
    try {
      await pdns.axfrRetrieve(z.id);
      ui.showToast(`AXFR retrieve started for ${stripDot(z.name)}`, 'success');
    } catch (err) {
      ui.showToast(`AXFR failed: ${err.message}`, 'danger');
    } finally { ui.setLoading(false); }
  },

  async exportZone(idx) {
    const z = state.zones[idx];
    await doExport(z.id, z.name);
  },

  showZoneCreate() {
    showZoneModal(null);
  },

  async showZoneEdit(idx) {
    const z = state.zones[idx];
    ui.setLoading(true);
    try {
      const full = await pdns.getZone(z.id);
      ui.setLoading(false);
      showZoneModal(full);
    } catch (err) {
      ui.setLoading(false);
      ui.showToast(`Cannot load zone: ${err.message}`, 'danger');
    }
  },

  deleteZone(idx) {
    const z = state.zones[idx];
    showConfirm(
      `Delete Zone "${stripDot(z.name)}"`,
      `This will permanently delete all records in <strong>${esc(stripDot(z.name))}</strong>. This action cannot be undone.`,
      async () => {
        ui.setLoading(true);
        try {
          await pdns.deleteZone(z.id);
          ui.showToast('Zone deleted', 'success');
          navigate('zones');
        } catch (err) {
          ui.showToast(`Delete failed: ${err.message}`, 'danger');
        } finally { ui.setLoading(false); }
      }
    );
  },

  bulkDeleteZones() {
    const count = state.selectedZones.size;
    if (!count) return;
    showConfirm(
      `Delete ${count} Zone${count > 1 ? 's' : ''}`,
      `Permanently delete <strong>${count}</strong> zone${count > 1 ? 's' : ''} and all their records? This cannot be undone.`,
      async () => {
        ui.setLoading(true);
        const ids = [...state.selectedZones];
        let failed = 0;
        for (const id of ids) {
          try { await pdns.deleteZone(id); } catch { failed++; }
        }
        ui.setLoading(false);
        if (failed) ui.showToast(`Deleted ${ids.length - failed} zones, ${failed} failed`, 'warning');
        else ui.showToast(`Deleted ${ids.length} zone${ids.length > 1 ? 's' : ''}`, 'success');
        navigate('zones');
      }
    );
  },

  // === Records view actions ===
  async notifyCurrentZone() {
    const z = state.currentZone;
    ui.setLoading(true);
    try {
      await pdns.notifyZone(z.id);
      ui.showToast(`NOTIFY sent for ${stripDot(z.name)}`, 'success');
    } catch (err) {
      ui.showToast(`Notify failed: ${err.message}`, 'danger');
    } finally { ui.setLoading(false); }
  },

  async axfrRetrieveCurrentZone() {
    const z = state.currentZone;
    ui.setLoading(true);
    try {
      await pdns.axfrRetrieve(z.id);
      ui.showToast(`AXFR retrieve started for ${stripDot(z.name)}`, 'success');
    } catch (err) {
      ui.showToast(`AXFR failed: ${err.message}`, 'danger');
    } finally { ui.setLoading(false); }
  },

  async exportCurrentZone() {
    const z = state.currentZone;
    await doExport(z.id, z.name);
  },

  showRecordCreate() {
    showRecordModal(null);
  },

  showRecordEdit(idx) {
    showRecordModal(state.rrsets[idx]);
  },

  deleteRecord(idx) {
    const rr = state.rrsets[idx];
    const zone = state.currentZone;
    const relN = relativeName(rr.name, zone.name);
    showConfirm(
      'Delete Record',
      `Delete <strong>${esc(rr.type)}</strong> record <strong>${esc(relN)}</strong>?`,
      async () => {
        ui.setLoading(true);
        try {
          await pdns.updateRRsets(zone.id, [{ name: rr.name, type: rr.type, changetype: 'DELETE' }]);
          ui.showToast('Record deleted', 'success');
          navigate('records', zone.id);
        } catch (err) {
          ui.showToast(`Delete failed: ${err.message}`, 'danger');
        } finally { ui.setLoading(false); }
      }
    );
  },

  bulkDeleteRecords() {
    const count = state.selectedRecords.size;
    if (!count) return;
    const zone = state.currentZone;
    showConfirm(
      `Delete ${count} Record${count > 1 ? 's' : ''}`,
      `Delete <strong>${count}</strong> selected record${count > 1 ? 's' : ''}?`,
      async () => {
        ui.setLoading(true);
        try {
          const rrsets = [...state.selectedRecords].map(key => {
            const sep = key.lastIndexOf('|');
            return { name: key.slice(0, sep), type: key.slice(sep + 1), changetype: 'DELETE' };
          });
          await pdns.updateRRsets(zone.id, rrsets);
          ui.showToast(`Deleted ${count} record${count > 1 ? 's' : ''}`, 'success');
          navigate('records', zone.id);
        } catch (err) {
          ui.showToast(`Delete failed: ${err.message}`, 'danger');
        } finally { ui.setLoading(false); }
      }
    );
  },

  // === Search ===
  async runSearch() {
    const q = document.getElementById('search-input')?.value?.trim();
    if (!q) return;
    const el = document.getElementById('search-results');
    if (!el) return;
    el.innerHTML = `<div class="d-flex justify-content-center py-4"><div class="spinner-border text-primary"></div></div>`;
    try {
      const results = await pdns.searchData(q);
      if (!results || results.length === 0) {
        el.innerHTML = `<div class="empty-state"><i class="bi bi-inbox"></i>No results found for &ldquo;${esc(q)}&rdquo;</div>`;
        return;
      }
      const rows = results.map(r => `
        <tr>
          <td class="font-monospace">${esc(r.name || '—')}</td>
          <td>${typeBadge(r.type || '')}</td>
          <td class="font-monospace small">${esc(r.content || '—')}</td>
          <td>
            <a href="#" onclick="navigate('records','${esc(r.zone_id || r.zone)}');return false;">
              ${esc(stripDot(r.zone || '—'))}
            </a>
          </td>
        </tr>`).join('');
      el.innerHTML = `
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr><th>Name</th><th>Type</th><th>Content</th><th>Zone</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  },

  // === Statistics ===
  refreshStats: () => loadStats(),

  // === Zone Metadata ===
  async showZoneMetadata() {
    const zone = state.currentZone;
    document.getElementById('modal-title').textContent = `Metadata – ${stripDot(zone.name)}`;
    document.getElementById('modal-body').innerHTML = `
      <div class="d-flex justify-content-center py-3">
        <div class="spinner-border text-primary"></div>
      </div>`;
    document.getElementById('modal-save-btn').textContent = 'Save Metadata';
    document.getElementById('modal-save-btn').onclick = () => saveZoneMetadata();
    new bootstrap.Modal(document.getElementById('app-modal')).show();

    try {
      const metaList = await pdns.getZoneMetadata(zone.id);
      const meta = {};
      (metaList || []).forEach(m => { meta[m.kind] = m.metadata || []; });

      const soaEditOpts = ['', 'DEFAULT', 'INCREASE', 'EPOCH', 'NOW', 'NONE'];
      const soaEditSel = (key, cur) => soaEditOpts.map(v =>
        `<option value="${v}"${cur === v ? ' selected' : ''}>${v || '(server default)'}</option>`
      ).join('');

      document.getElementById('modal-body').innerHTML = `
        <form id="meta-form" onsubmit="return false">
          <div class="mb-3">
            <label class="form-label fw-medium">ALLOW-AXFR-FROM</label>
            <textarea class="form-control font-monospace" id="meta-allow-axfr" rows="3"
              placeholder="AUTO&#10;0.0.0.0/0&#10;::/0">${esc((meta['ALLOW-AXFR-FROM'] || []).join('\n'))}</textarea>
            <div class="form-text">IP prefixes allowed to AXFR. One per line. Use <code>AUTO</code> to allow from configured masters.</div>
          </div>
          <div class="mb-3">
            <label class="form-label fw-medium">ALSO-NOTIFY</label>
            <textarea class="form-control font-monospace" id="meta-also-notify" rows="2"
              placeholder="192.168.1.100&#10;192.168.1.101">${esc((meta['ALSO-NOTIFY'] || []).join('\n'))}</textarea>
            <div class="form-text">Extra IPs to send NOTIFY to. One per line.</div>
          </div>
          <div class="mb-3">
            <label class="form-label fw-medium">AXFR-SOURCE</label>
            <input type="text" class="form-control font-monospace" id="meta-axfr-source"
              value="${esc((meta['AXFR-SOURCE'] || [])[0] || '')}" placeholder="192.168.1.1">
            <div class="form-text">Source IP address for outgoing AXFR requests.</div>
          </div>
          <div class="row mb-3">
            <div class="col-sm-6">
              <label class="form-label fw-medium">SOA-EDIT</label>
              <select class="form-select" id="meta-soa-edit">
                ${soaEditSel('SOA-EDIT', (meta['SOA-EDIT'] || [])[0] || '')}
              </select>
              <div class="form-text">SOA serial modification on zone change.</div>
            </div>
            <div class="col-sm-6">
              <label class="form-label fw-medium">SOA-EDIT-API</label>
              <select class="form-select" id="meta-soa-edit-api">
                ${soaEditSel('SOA-EDIT-API', (meta['SOA-EDIT-API'] || [])[0] || '')}
              </select>
              <div class="form-text">SOA serial modification on API change.</div>
            </div>
          </div>
        </form>`;
    } catch (err) {
      document.getElementById('modal-body').innerHTML =
        `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  },

  // === Autoprimaries ===
  showAutoprimaryCreate() {
    document.getElementById('modal-title').textContent = 'Add Autoprimary';
    document.getElementById('modal-body').innerHTML = `
      <form id="autoprimary-form" onsubmit="return false">
        <div class="mb-3">
          <label class="form-label fw-medium">IP Address <span class="text-danger">*</span></label>
          <input type="text" class="form-control font-monospace" id="ap-ip"
            placeholder="192.168.1.1" required>
          <div class="form-text">IP address of the primary server sending NOTIFYs.</div>
        </div>
        <div class="mb-3">
          <label class="form-label fw-medium">Nameserver <span class="text-danger">*</span></label>
          <input type="text" class="form-control font-monospace" id="ap-ns"
            placeholder="ns1.example.com." required>
          <div class="form-text">FQDN matching the NS record in the zone on the primary.</div>
        </div>
        <div class="mb-3">
          <label class="form-label fw-medium">Account</label>
          <input type="text" class="form-control" id="ap-account" placeholder="optional label">
          <div class="form-text">Optional label for grouping zones created by this autoprimary.</div>
        </div>
      </form>`;
    document.getElementById('modal-save-btn').textContent = 'Add Autoprimary';
    document.getElementById('modal-save-btn').onclick = () => saveAutoprimary();
    new bootstrap.Modal(document.getElementById('app-modal')).show();
  },

  deleteAutoprimary(idx) {
    const a = state.autoprimaries[idx];
    showConfirm(
      'Delete Autoprimary',
      `Remove autoprimary <strong>${esc(a.ip)}</strong> / <strong>${esc(a.nameserver)}</strong>?`,
      async () => {
        ui.setLoading(true);
        try {
          await pdns.deleteAutoprimary(a.ip, a.nameserver);
          ui.showToast('Autoprimary removed', 'success');
          navigate('autoprimaries');
        } catch (err) {
          ui.showToast(`Delete failed: ${err.message}`, 'danger');
        } finally { ui.setLoading(false); }
      }
    );
  },
};

// ---- Export helper -----------------------------------------------
async function doExport(zoneId, zoneName) {
  ui.setLoading(true);
  try {
    const data = await pdns.exportZone(zoneId);
    const text = typeof data === 'string' ? data : (data?.result ?? JSON.stringify(data, null, 2));
    document.getElementById('export-content').textContent = text;
    document.querySelector('#export-modal .modal-title').textContent =
      `Zone Export – ${stripDot(zoneName)}`;
    new bootstrap.Modal(document.getElementById('export-modal')).show();
  } catch (err) {
    ui.showToast(`Export failed: ${err.message}`, 'danger');
  } finally { ui.setLoading(false); }
}

function copyExport() {
  const text = document.getElementById('export-content').textContent;
  navigator.clipboard.writeText(text).then(() => {
    ui.showToast('Copied to clipboard', 'success');
  });
}

// ---- Zone Metadata save ------------------------------------------
async function saveZoneMetadata() {
  const zone = state.currentZone;
  const fields = [
    { kind: 'ALLOW-AXFR-FROM', values: () => document.getElementById('meta-allow-axfr').value.split('\n').map(s => s.trim()).filter(Boolean) },
    { kind: 'ALSO-NOTIFY',     values: () => document.getElementById('meta-also-notify').value.split('\n').map(s => s.trim()).filter(Boolean) },
    { kind: 'AXFR-SOURCE',     values: () => { const v = document.getElementById('meta-axfr-source').value.trim(); return v ? [v] : []; } },
    { kind: 'SOA-EDIT',        values: () => { const v = document.getElementById('meta-soa-edit').value; return v ? [v] : []; } },
    { kind: 'SOA-EDIT-API',    values: () => { const v = document.getElementById('meta-soa-edit-api').value; return v ? [v] : []; } },
  ];

  ui.setLoading(true);
  let errors = 0;
  for (const f of fields) {
    const values = f.values();
    try {
      if (values.length > 0) {
        await pdns.setZoneMeta(zone.id, f.kind, values);
      } else {
        await pdns.deleteZoneMeta(zone.id, f.kind);
      }
    } catch {
      if (values.length > 0) errors++;
    }
  }
  ui.setLoading(false);
  if (errors > 0) {
    ui.showToast('Some metadata could not be saved', 'warning');
  } else {
    ui.showToast('Metadata saved', 'success');
    bootstrap.Modal.getInstance(document.getElementById('app-modal')).hide();
  }
}

// ---- Autoprimary save --------------------------------------------
async function saveAutoprimary() {
  const ip      = document.getElementById('ap-ip').value.trim();
  const ns      = document.getElementById('ap-ns').value.trim();
  const account = document.getElementById('ap-account').value.trim();

  if (!ip) { ui.showToast('IP address is required', 'warning'); return; }
  if (!ns) { ui.showToast('Nameserver is required', 'warning'); return; }

  ui.setLoading(true);
  try {
    await pdns.createAutoprimary({ ip, nameserver: fqdn(ns), account });
    ui.showToast('Autoprimary added', 'success');
    bootstrap.Modal.getInstance(document.getElementById('app-modal')).hide();
    navigate('autoprimaries');
  } catch (err) {
    ui.showToast(`Error: ${err.message}`, 'danger');
  } finally { ui.setLoading(false); }
}

// ---- Zone modal --------------------------------------------------
function showZoneModal(zone) {
  const isEdit = zone !== null;
  document.getElementById('modal-title').textContent = isEdit ? 'Edit Zone' : 'Create Zone';

  const kind = isEdit ? zone.kind : 'Native';
  const masters = isEdit && zone.masters ? zone.masters.join('\n') : '';
  const account = isEdit ? (zone.account || '') : '';

  document.getElementById('modal-body').innerHTML = `
    <form id="zone-form" onsubmit="return false">
      <div class="mb-3">
        <label class="form-label fw-medium">Zone Name <span class="text-danger">*</span></label>
        <input type="text" class="form-control font-monospace" id="z-name"
          value="${isEdit ? esc(stripDot(zone.name)) : ''}"
          placeholder="example.com" ${isEdit ? 'readonly' : ''} required>
        <div class="form-text">Fully qualified domain name (trailing dot is added automatically)</div>
      </div>

      <div class="row mb-3">
        <div class="col-sm-6">
          <label class="form-label fw-medium">Zone Type <span class="text-danger">*</span></label>
          <select class="form-select" id="z-kind" onchange="onZoneKindChange(this.value)">
            <option value="Native" ${kind === 'Native' ? 'selected' : ''}>Native (no replication)</option>
            <option value="Master" ${kind === 'Master' ? 'selected' : ''}>Master (Primary)</option>
            <option value="Slave"  ${kind === 'Slave'  ? 'selected' : ''}>Slave (Secondary)</option>
          </select>
        </div>
        <div class="col-sm-6">
          <label class="form-label fw-medium">Account</label>
          <input type="text" class="form-control" id="z-account"
            value="${esc(account)}" placeholder="optional label">
        </div>
      </div>

      ${!isEdit ? `
      <div class="mb-3" id="ns-section">
        <label class="form-label fw-medium">Nameservers <span class="text-danger">*</span></label>
        <textarea class="form-control font-monospace" id="z-nameservers" rows="3"
          placeholder="ns1.example.com&#10;ns2.example.com"></textarea>
        <div class="form-text">One nameserver per line. NS records will be created automatically.</div>
      </div>` : ''}

      <div class="mb-3" id="masters-section" style="${kind !== 'Slave' ? 'display:none' : ''}">
        <label class="form-label fw-medium">Master Servers <span class="text-danger">*</span></label>
        <textarea class="form-control font-monospace" id="z-masters" rows="2"
          placeholder="192.168.1.1&#10;192.168.1.2">${esc(masters)}</textarea>
        <div class="form-text">IP addresses of master servers, one per line.</div>
      </div>
    </form>`;

  document.getElementById('modal-save-btn').onclick = () => saveZone(isEdit ? zone.id : null);
  document.getElementById('modal-save-btn').textContent = isEdit ? 'Save Changes' : 'Create Zone';
  new bootstrap.Modal(document.getElementById('app-modal')).show();
}

function onZoneKindChange(kind) {
  const ms = document.getElementById('masters-section');
  if (ms) ms.style.display = kind === 'Slave' ? '' : 'none';
}

async function saveZone(zoneId) {
  const nameVal = document.getElementById('z-name').value.trim();
  if (!nameVal) { ui.showToast('Zone name is required', 'warning'); return; }

  const kind    = document.getElementById('z-kind').value;
  const account = document.getElementById('z-account')?.value?.trim() || '';
  const name    = fqdn(nameVal);

  const data = { name, kind, account };

  if (!zoneId) {
    const nsEl = document.getElementById('z-nameservers');
    const nameservers = (nsEl?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (nameservers.length === 0 && kind !== 'Slave') {
      ui.showToast('At least one nameserver is required', 'warning');
      return;
    }
    data.nameservers = nameservers.map(fqdn);
  }

  const mastersEl = document.getElementById('z-masters');
  if (kind === 'Slave') {
    const masters = (mastersEl?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (masters.length === 0) {
      ui.showToast('At least one master server IP is required for Slave zones', 'warning');
      return;
    }
    data.masters = masters;
  }

  ui.setLoading(true);
  try {
    if (zoneId) {
      await pdns.updateZone(zoneId, data);
      ui.showToast('Zone updated successfully', 'success');
    } else {
      await pdns.createZone(data);
      ui.showToast('Zone created successfully', 'success');
    }
    bootstrap.Modal.getInstance(document.getElementById('app-modal')).hide();
    navigate('zones');
  } catch (err) {
    ui.showToast(`Error: ${err.message}`, 'danger');
  } finally { ui.setLoading(false); }
}

// ---- Record modal ------------------------------------------------
const RECORD_TYPES = ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];

function showRecordModal(rrset) {
  const isEdit = rrset !== null;
  const zone   = state.currentZone;
  const relN   = isEdit ? relativeName(rrset.name, zone.name) : '';
  const type   = isEdit ? rrset.type : 'A';
  const ttl    = isEdit ? rrset.ttl : 300;

  document.getElementById('modal-title').textContent = isEdit ? 'Edit Record' : 'Add Record';
  document.getElementById('modal-body').innerHTML = `
    <form id="record-form" onsubmit="return false">
      <div class="mb-3">
        <label class="form-label fw-medium">Name <span class="text-danger">*</span></label>
        <div class="input-group">
          <input type="text" class="form-control font-monospace" id="r-name"
            value="${esc(relN)}" placeholder="@ or subdomain"
            ${isEdit ? 'readonly' : ''} required>
          <span class="input-group-text text-muted">.${esc(stripDot(zone.name))}</span>
        </div>
        <div class="form-text">Use <code>@</code> for the zone apex.</div>
      </div>
      <div class="row mb-3">
        <div class="col-sm-5">
          <label class="form-label fw-medium">Type <span class="text-danger">*</span></label>
          <select class="form-select" id="r-type" onchange="onRecordTypeChange(this.value)"
            ${isEdit ? 'disabled' : ''}>
            ${RECORD_TYPES.map(t => `<option value="${t}" ${type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="col-sm-4">
          <label class="form-label fw-medium">TTL (s)</label>
          <input type="number" class="form-control" id="r-ttl" value="${esc(ttl)}" min="0" step="60">
        </div>
        <div class="col-sm-3 d-flex align-items-end">
          <div class="form-check mb-1">
            <input class="form-check-input" type="checkbox" id="r-disabled"
              ${isEdit && rrset.records?.[0]?.disabled ? 'checked' : ''}>
            <label class="form-check-label" for="r-disabled">Disabled</label>
          </div>
        </div>
      </div>
      <div id="record-fields">${renderRecordFields(type, isEdit ? rrset : null)}</div>
    </form>`;

  document.getElementById('modal-save-btn').onclick = () => saveRecord(isEdit ? rrset : null);
  document.getElementById('modal-save-btn').textContent = isEdit ? 'Save Changes' : 'Add Record';
  new bootstrap.Modal(document.getElementById('app-modal')).show();
}

function onRecordTypeChange(type) {
  document.getElementById('record-fields').innerHTML = renderRecordFields(type, null);
}

function renderRecordFields(type, rrset) {
  // For most types we allow multi-value (one content per line)
  const records = rrset?.records || [];
  const first   = records[0]?.content || '';

  switch (type) {
    case 'MX': {
      const p = first.split(' ');
      return `
        <div class="row mb-3">
          <div class="col-3">
            <label class="form-label">Priority</label>
            <input type="number" class="form-control" id="r-prio" value="${esc(p[0] || '10')}" min="0">
          </div>
          <div class="col-9">
            <label class="form-label">Mail Server <span class="text-danger">*</span></label>
            <input type="text" class="form-control font-monospace" id="r-mx"
              value="${esc(p.slice(1).join(' '))}" placeholder="mail.example.com." required>
          </div>
        </div>`;
    }

    case 'SRV': {
      const p = first.split(' ');
      return `
        <div class="row mb-3">
          <div class="col-3"><label class="form-label">Priority</label>
            <input type="number" class="form-control" id="r-srv-prio" value="${esc(p[0] || '10')}" min="0"></div>
          <div class="col-3"><label class="form-label">Weight</label>
            <input type="number" class="form-control" id="r-srv-w" value="${esc(p[1] || '0')}" min="0"></div>
          <div class="col-3"><label class="form-label">Port</label>
            <input type="number" class="form-control" id="r-srv-port" value="${esc(p[2] || '80')}" min="0" max="65535"></div>
          <div class="col-12 mt-2"><label class="form-label">Target <span class="text-danger">*</span></label>
            <input type="text" class="form-control font-monospace" id="r-srv-target"
              value="${esc(p[3] || '')}" placeholder="target.example.com." required></div>
        </div>`;
    }

    case 'CAA': {
      const p = first.split(' ');
      const val = (p.slice(2).join(' ')).replace(/^"|"$/g, '');
      return `
        <div class="row mb-3">
          <div class="col-2"><label class="form-label">Flags</label>
            <input type="number" class="form-control" id="r-caa-flags" value="${esc(p[0] || '0')}" min="0" max="255"></div>
          <div class="col-4"><label class="form-label">Tag</label>
            <select class="form-select" id="r-caa-tag">
              <option ${p[1] === 'issue' || !p[1] ? 'selected' : ''}>issue</option>
              <option ${p[1] === 'issuewild' ? 'selected' : ''}>issuewild</option>
              <option ${p[1] === 'iodef' ? 'selected' : ''}>iodef</option>
            </select></div>
          <div class="col-6"><label class="form-label">Value</label>
            <input type="text" class="form-control" id="r-caa-val" value="${esc(val)}"
              placeholder="letsencrypt.org" required></div>
        </div>`;
    }

    case 'TXT': {
      // Strip outer quotes for display; re-add on save
      const lines = records.map(r => r.content.replace(/^"|"$/g, '')).join('\n');
      return `
        <div class="mb-3">
          <label class="form-label">Content <span class="text-danger">*</span></label>
          <textarea class="form-control font-monospace" id="r-content" rows="3" required
            placeholder="v=spf1 include:example.com ~all">${esc(lines)}</textarea>
          <div class="form-text">One TXT string per line (quotes added automatically). Multiple lines create multiple records.</div>
        </div>`;
    }

    case 'SOA': {
      return `
        <div class="mb-3">
          <label class="form-label">SOA Content</label>
          <input type="text" class="form-control font-monospace" id="r-content" value="${esc(first)}"
            placeholder="ns1.example.com. hostmaster.example.com. 2024010101 3600 900 604800 300">
          <div class="form-text">primary-ns admin-email serial refresh retry expire minimum</div>
        </div>`;
    }

    default: {
      // Multi-value: one content per line
      const lines = records.length ? records.map(r => r.content).join('\n') : '';
      return `
        <div class="mb-3">
          <label class="form-label">Content <span class="text-danger">*</span></label>
          <textarea class="form-control font-monospace" id="r-content" rows="${Math.max(2, (records.length || 1) + 1)}"
            required placeholder="${type === 'A' ? '203.0.113.1' : type === 'AAAA' ? '2001:db8::1' : ''}"
            >${esc(lines)}</textarea>
          <div class="form-text">One value per line. Multiple lines create multiple records for the same name/type.</div>
        </div>`;
    }
  }
}

function buildRecordContent(type) {
  switch (type) {
    case 'MX': {
      const p = document.getElementById('r-prio').value;
      const t = document.getElementById('r-mx').value.trim();
      if (!t) throw new Error('Mail server is required');
      return [{ content: `${p} ${fqdn(t)}` }];
    }
    case 'SRV': {
      const p    = document.getElementById('r-srv-prio').value;
      const w    = document.getElementById('r-srv-w').value;
      const port = document.getElementById('r-srv-port').value;
      const t    = document.getElementById('r-srv-target').value.trim();
      if (!t) throw new Error('Target is required');
      return [{ content: `${p} ${w} ${port} ${fqdn(t)}` }];
    }
    case 'CAA': {
      const flags = document.getElementById('r-caa-flags').value;
      const tag   = document.getElementById('r-caa-tag').value;
      const val   = document.getElementById('r-caa-val').value.trim();
      return [{ content: `${flags} ${tag} "${val}"` }];
    }
    case 'TXT': {
      const lines = document.getElementById('r-content').value
        .split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('Content is required');
      return lines.map(l => ({ content: l.startsWith('"') ? l : `"${l}"` }));
    }
    case 'CNAME':
    case 'NS':
    case 'PTR': {
      const lines = document.getElementById('r-content').value
        .split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('Content is required');
      return lines.map(l => ({ content: fqdn(l) }));
    }
    default: {
      const lines = document.getElementById('r-content').value
        .split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('Content is required');
      return lines.map(l => ({ content: l }));
    }
  }
}

async function saveRecord(existingRRset) {
  const zone     = state.currentZone;
  const nameVal  = document.getElementById('r-name').value.trim();
  const typeEl   = document.getElementById('r-type');
  const type     = existingRRset ? existingRRset.type : typeEl.value;
  const ttl      = parseInt(document.getElementById('r-ttl').value) || 300;
  const disabled = document.getElementById('r-disabled').checked;

  if (!nameVal) { ui.showToast('Name is required', 'warning'); return; }

  const absName = absoluteName(nameVal, zone.name);

  let records;
  try {
    records = buildRecordContent(type).map(r => ({ ...r, disabled }));
  } catch (e) {
    ui.showToast(e.message, 'warning');
    return;
  }

  ui.setLoading(true);
  try {
    await pdns.updateRRsets(zone.id, [{
      name: absName,
      type,
      ttl,
      changetype: 'REPLACE',
      records,
    }]);
    ui.showToast(existingRRset ? 'Record updated' : 'Record created', 'success');
    bootstrap.Modal.getInstance(document.getElementById('app-modal')).hide();
    navigate('records', zone.id);
  } catch (err) {
    ui.showToast(`Error: ${err.message}`, 'danger');
  } finally { ui.setLoading(false); }
}

// ---- Confirm dialog ----------------------------------------------
function showConfirm(title, message, onConfirm) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').innerHTML = message;
  const btn = document.getElementById('confirm-btn');
  // Remove old listener
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('confirm-modal')).hide();
    onConfirm();
  });
  new bootstrap.Modal(document.getElementById('confirm-modal')).show();
}

// ---- Router ------------------------------------------------------
function navigate(view, param) {
  state.currentView  = view;
  state.currentParam = param;

  // Update nav active state
  document.querySelectorAll('[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  switch (view) {
    case 'zones':          views.zones();           break;
    case 'records':        views.records(param);    break;
    case 'search':         views.search();          break;
    case 'statistics':     views.statistics();      break;
    case 'autoprimaries':  views.autoprimaries();   break;
    case 'settings':       views.settings();        break;
    default:               views.zones();
  }
}

// ---- Init --------------------------------------------------------
async function init() {
  theme.init();

  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    state.serverId = cfg.server_id || 'localhost';
    state.uiVersion = cfg.ui_version || 'n/a';
  } catch (e) {
    console.warn('Could not fetch server config:', e);
  }

  setFooterVersion('ui-version', 'ui', state.uiVersion);
  setFooterVersion('pdns-version', 'pdns', 'loading...');
  void refreshPDNSVersion();

  navigate('zones');
}

document.addEventListener('DOMContentLoaded', init);
