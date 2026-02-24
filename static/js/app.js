'use strict';

/* =================================================================
   PowerDNS Web UI – Single-Page Application
   ================================================================= */

// ---- State -------------------------------------------------------
const state = {
  serverId: 'localhost',
  currentView: null,
  currentZone: null,   // full zone object when in records view
  zones: [],           // cached list for quick lookups
  rrsets: [],          // rrsets for current zone
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
  listZones:    ()        => http.get(`servers/${state.serverId}/zones`),
  getZone:      (id)      => http.get(`servers/${state.serverId}/zones/${enc(id)}`),
  createZone:   (data)    => http.post(`servers/${state.serverId}/zones`, data),
  updateZone:   (id, d)   => http.put(`servers/${state.serverId}/zones/${enc(id)}`, d),
  deleteZone:   (id)      => http.del(`servers/${state.serverId}/zones/${enc(id)}`),
  notifyZone:   (id)      => http.put(`servers/${state.serverId}/zones/${enc(id)}/notify`),
  exportZone:   (id)      => http.get(`servers/${state.serverId}/zones/${enc(id)}/export`),
  updateRRsets: (id, rrs) => http.patch(`servers/${state.serverId}/zones/${enc(id)}`, { rrsets: rrs }),
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

// ---- Views -------------------------------------------------------
const views = {

  // ----- Zones list -----
  async zones() {
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
        : `<tr><td colspan="5">
            <div class="empty-state">
              <i class="bi bi-inbox"></i>
              No zones found. Create your first zone to get started.
            </div></td></tr>`;

      ui.setContent(`
        <div class="page-header">
          <h2><i class="bi bi-globe2 me-2 text-primary"></i>Zones</h2>
          <span class="badge bg-secondary ms-1">${state.zones.length}</span>
          <div class="ms-auto">
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
            const relN = relativeName(rr.name, zone.name);
            const content = (rr.records || [])
              .map(r => `<div class="record-content ${r.disabled ? 'disabled-record' : ''}">${esc(r.content)}</div>`)
              .join('');
            return `
          <tr>
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
        : `<tr><td colspan="5"><div class="empty-state">
            <i class="bi bi-inbox"></i>No records in this zone.</div></td></tr>`;

      const notifyBtn = (zone.kind === 'Master' || zone.kind === 'Native') ? `
        <button class="btn btn-outline-warning" onclick="handlers.notifyCurrentZone()" title="Send NOTIFY to slaves">
          <i class="bi bi-broadcast me-1"></i>Notify Slaves
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
    case 'zones':    views.zones();           break;
    case 'records':  views.records(param);    break;
    case 'settings': views.settings();        break;
    default:         views.zones();
  }
}

// ---- Init --------------------------------------------------------
async function init() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    state.serverId = cfg.server_id || 'localhost';
  } catch (e) {
    console.warn('Could not fetch server config:', e);
  }
  navigate('zones');
}

document.addEventListener('DOMContentLoaded', init);
