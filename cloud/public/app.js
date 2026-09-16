// Shared page behaviour for the Projection5000 console. No names are ever interpolated into
// inline JS: destructive forms carry data-confirm="...", selects that used to be
// onchange="this.form.submit()" carry data-autosubmit, and every other behaviour hangs off an
// id or data attribute handled here. upload.js (library) and sortable.min.js (playlist
// editor) are loaded per page.
(function () {
  'use strict';

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.dataset && form.dataset.confirm && !confirm(form.dataset.confirm)) {
      e.preventDefault();
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.form && el.dataset && el.dataset.autosubmit !== undefined) {
      // requestSubmit fires the submit event (so data-confirm applies); the hidden csrf_token
      // input is rendered into every form server-side.
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
  });

  // Masked secrets (the enrollment key): <button data-reveal="<input id>"> toggles the
  // input between password and text and relabels itself Show / Hide.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-reveal]') : null;
    var input = btn && document.getElementById(btn.dataset.reveal);
    if (!input) return;
    var hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Hide' : 'Show';
  });

  // Camera live view (Devices page): <button data-live-frame="<iframe id>"> loads the iframe's
  // data-src on first click (never on page load) and toggles it.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-live-frame]') : null;
    var frame = btn && document.getElementById(btn.dataset.liveFrame);
    if (!frame) return;
    if (!frame.getAttribute('src') && frame.dataset.src) frame.src = frame.dataset.src;
    frame.hidden = !frame.hidden;
    btn.textContent = frame.hidden ? 'Show live' : 'Hide live';
  });

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }

  // POST JSON with the CSRF header. Resolves with the Response; an expired session (redirect
  // to /login) is reported as an error so callers never treat it as saved.
  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify(body),
      redirect: 'manual'
    }).then(function (r) {
      if (r.type === 'opaqueredirect' || r.redirected) {
        throw new Error('Your session has expired; please sign in again.');
      }
      return r;
    });
  }

  // Phone nav: the menu button in the top bar.
  function initNav() {
    var toggle = document.querySelector('.nav-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var bar = toggle.closest('.topbar');
      var open = bar.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Playlist editor: drag rows of #sortable-body (rendered with data-item-id), or move a
  // focused handle with the arrow keys, and save the order.
  function initSortable() {
    var body = document.getElementById('sortable-body');
    if (!body || body.dataset.readonly) return;
    var playlistId = parseInt(body.dataset.playlistId, 10);

    function saveOrder() {
      var rows = Array.prototype.slice.call(body.querySelectorAll('tr[data-item-id]'));
      var ids = rows.map(function (tr) { return parseInt(tr.dataset.itemId, 10); });
      // Optimistic position renumber
      rows.forEach(function (tr, idx) {
        var cell = tr.querySelector('.position-cell');
        if (cell) cell.textContent = idx + 1;
      });
      postJson('/playlists/' + playlistId + '/items/reorder', { order: ids }).then(function (r) {
        if (!r.ok) {
          alert('Reorder not saved (HTTP ' + r.status + '); reloading');
          window.location.reload();
        }
      }).catch(function (err) {
        alert('Reorder error: ' + err.message);
        window.location.reload();
      });
    }

    if (window.Sortable) {
      Sortable.create(body, {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: saveOrder
      });
    }

    body.addEventListener('keydown', function (e) {
      var handle = e.target.closest && e.target.closest('.drag-handle [role="button"]');
      if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      var row = handle.closest('tr');
      var other = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
      if (!other) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') body.insertBefore(row, other); else body.insertBefore(other, row);
      handle.focus();
      saveOrder();
    });
  }

  // Dashboard: All / Faults filter on the monitor wall.
  function initWallFilter() {
    var filters = document.getElementById('wall-filters');
    var wall = document.getElementById('monitor-wall');
    if (!filters || !wall) return;
    filters.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      wall.classList.toggle('faults-only', btn.dataset.filter === 'faults');
      filters.querySelectorAll('button[data-filter]').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  }

  // Library: dropping files on the panel fills the file input (upload.js drives the queue).
  function initDropzone() {
    var input = document.getElementById('file-input');
    var zone = input && input.closest('.dropzone');
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  // Schedule form: fold the checked days into the hidden days_of_week field ("0123456" subset).
  function initDays() {
    var days = document.getElementById('days-hidden');
    if (!days || !days.form) return;
    days.form.addEventListener('submit', function () {
      var checks = days.form.querySelectorAll('input[name="days_of_week_chk"]:checked');
      days.value = Array.prototype.map.call(checks, function (c) { return c.value; }).join('');
    });
  }

  function init() {
    initNav();
    initSortable();
    initWallFilter();
    initDropzone();
    initDays();
  }

  window.piplayer = { csrf: csrf, postJson: postJson };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
