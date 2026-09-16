// Projection5000 console behaviour. No inline event handlers anywhere in the
// templates: everything hangs off ids / data-attributes from here.
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.content : '';

  // One delegated confirm handler: names are never interpolated into inline JS.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.dataset && form.dataset.confirm && !confirm(form.dataset.confirm)) {
      e.preventDefault();
    }
  });

  // <select data-autosubmit> posts its form as soon as a value is picked.
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('select[data-autosubmit]') || !el.form) return;
    if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
  });

  // Phone nav: the ≡ button in the top bar.
  var toggle = document.querySelector('.nav-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var bar = toggle.closest('.topbar');
      var open = bar.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Library: XHR upload with progress, plus drag-and-drop onto the panel.
  var form = document.getElementById('upload-form');
  if (form) {
    var input = document.getElementById('file-input');
    var progress = document.getElementById('upload-progress');
    var status = document.getElementById('upload-status');
    var zone = form.closest('.dropzone');

    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle('is-error', !!isError);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.action);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      progress.hidden = false;
      progress.value = 0;
      setStatus('uploading...');

      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        var pct = (ev.loaded / ev.total) * 100;
        progress.value = pct;
        setStatus('uploading ' + (ev.loaded / 1024 / 1024).toFixed(1) + ' / ' +
                  (ev.total / 1024 / 1024).toFixed(1) + ' MB (' + pct.toFixed(0) + '%)');
        if (pct >= 100) setStatus('upload received, checking the file (ffprobe)...');
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 400) {
          setStatus('upload complete, reloading...');
          window.location.reload();
        } else {
          var msg = xhr.responseText;
          try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (err) { /* plain text */ }
          setStatus('error: ' + msg, true);
          progress.hidden = true;
        }
      };
      xhr.onerror = function () {
        setStatus('network error during upload', true);
        progress.hidden = true;
      };
      xhr.send(data);
    });

    if (zone && input) {
      ['dragenter', 'dragover'].forEach(function (name) {
        zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (name) {
        zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
      });
      zone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          input.files = e.dataTransfer.files;
          setStatus(e.dataTransfer.files[0].name + ' ready');
        }
      });
    }
  }

  // Playlist editor: drag rows (or move them with the arrow keys on a focused
  // handle) and POST the new order.
  var body = document.getElementById('sortable-body');
  if (body && !body.dataset.readonly) {
    var playlistId = body.dataset.playlistId;

    function saveOrder() {
      var rows = Array.from(body.querySelectorAll('tr[data-item-id]'));
      var ids = rows.map(function (tr) { return parseInt(tr.dataset.itemId, 10); });
      // Optimistic position renumber
      rows.forEach(function (tr, idx) {
        var cell = tr.querySelector('.position-cell');
        if (cell) cell.textContent = idx + 1;
      });
      fetch('/playlists/' + playlistId + '/items/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ order: ids }),
        redirect: 'manual'
      }).then(function (r) {
        // An expired session answers with a redirect to /login; never treat that as saved.
        if (r.type === 'opaqueredirect' || r.redirected) {
          alert('Your session has expired; the new order was not saved. Please sign in again.');
          window.location.reload();
          return;
        }
        if (!r.ok) {
          alert('Reorder not saved (HTTP ' + r.status + '); reloading');
          window.location.reload();
        }
      }).catch(function (err) {
        alert('Reorder error: ' + err);
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

  // Dashboard: All / Faults filter on the monitor wall.
  var filters = document.getElementById('wall-filters');
  var wall = document.getElementById('monitor-wall');
  if (filters && wall) {
    filters.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      wall.classList.toggle('faults-only', btn.dataset.filter === 'faults');
      filters.querySelectorAll('button[data-filter]').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  }

  // Schedule form: fold the day checkboxes into the hidden days_of_week field.
  var days = document.getElementById('days-hidden');
  if (days && days.form) {
    days.form.addEventListener('submit', function () {
      var checks = days.form.querySelectorAll('input[name="days_of_week_chk"]:checked');
      days.value = Array.from(checks).map(function (c) { return c.value; }).join('');
    });
  }
})();
