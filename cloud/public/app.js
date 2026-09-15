// Shared page behaviour. No names are ever interpolated into inline JS: destructive forms
// carry data-confirm="..." and selects that used to be onchange="this.form.submit()" carry
// data-autosubmit, both handled here so every submit goes through the same confirm + CSRF path.
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

  // Playlist editor: drag rows of #sortable-body (rendered with data-item-id) and save the order.
  function initSortable() {
    var body = document.getElementById('sortable-body');
    if (!body || !window.Sortable || body.dataset.readonly) return;
    var playlistId = parseInt(body.dataset.playlistId, 10);
    Sortable.create(body, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onEnd: function () {
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
    });
  }

  window.piplayer = { csrf: csrf, postJson: postJson };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSortable);
  else initSortable();
})();
