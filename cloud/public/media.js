// Media previews on the Library page and in the playlist editor (src/pages/library.js thumbCell):
// the small pictures, the viewer a picture opens, and the Library's media bar (Delete selected,
// Add to playlist) and Find / Show / Sort.
//
// Small pictures. The server cannot decode a video, so a preview is made here, in the browser,
// the first time a page shows a file that has none. <img data-thumb="<media id>"> asks
// GET /library/<id>/thumb, which answers with the stored preview, or the picture itself for an
// image that has none yet, or 404 for a video that has none. In the last two cases this script
// draws the picture (or a frame a little way into the video) small on a canvas and stores it
// with PUT /library/<id>/thumb, one file at a time, so every later visit, on any device, loads
// a few kilobytes. Only an editor's page stores (data-thumb-put on the grid); a file this
// browser cannot decode (an mkv in Safari) keeps its NO PREVIEW tile until a browser that can
// opens the page. No CDN scripts, no inline handlers.
(function () {
  'use strict';

  var MAX_SIDE = 640;   // longest side of a stored preview, px: sharp on a phone's two-column grid
  var QUALITY = 0.8;
  var FRAME_AT = 3;     // seconds into a video the frame is taken (a quarter of a shorter one): past a fade-in
  var DARK = 12;        // mean brightness (0..255) under which a frame counts as black and a later one is tried
  var TIMEOUT = 20000;  // ms one video may take to give up a frame

  var canStore = !!document.querySelector('[data-thumb-put]');

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }

  // ------------------------------------------------------------ small pictures ---

  // `source` (an <img> or <video> showing w x h) drawn to fit MAX_SIDE, on black: what a
  // see-through logo looks like on the projector.
  function draw(source, w, h) {
    if (!w || !h) throw new Error('no picture');
    var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function isDark(canvas) {
    var small = document.createElement('canvas');
    small.width = 16; small.height = 16;
    var ctx = small.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 16, 16);
    var px = ctx.getImageData(0, 0, 16, 16).data;
    var sum = 0;
    for (var i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return sum / (px.length / 4 * 3) < DARK;
  }

  function toJpeg(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('no picture')); }, 'image/jpeg', QUALITY);
    });
  }

  // A frame of the video at `url` as a canvas. The frame is taken FRAME_AT seconds in (a quarter
  // of the way in, in a shorter one); when that one is black (a slow fade, a title card) the
  // middle of the video, always later, is tried once.
  function frameOf(url) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      var settled = false;
      var retried = false;
      function finish(err, canvas) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.pause();
        video.removeAttribute('src'); // lets the browser drop the download
        video.load();
        if (err) reject(err); else resolve(canvas);
      }
      var timer = setTimeout(function () { finish(new Error('timed out')); }, TIMEOUT);
      function grab() {
        var canvas;
        try { canvas = draw(video, video.videoWidth, video.videoHeight); } catch (e) { finish(e); return; }
        var length = isFinite(video.duration) ? video.duration : 0;
        if (!retried && length > 0 && isDark(canvas)) {
          retried = true;
          video.currentTime = length / 2; // 'seeked' calls grab again
          return;
        }
        finish(null, canvas);
      }
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.onerror = function () { finish(new Error('this browser cannot play it')); };
      video.onseeked = grab;
      // The first frame can be drawn from here on. Seek to the frame wanted, or take this one
      // when the video is too short to seek into.
      video.onloadeddata = function () {
        var length = isFinite(video.duration) ? video.duration : 0;
        var at = Math.min(FRAME_AT, length / 4);
        if (at > 0.05) video.currentTime = at; else grab();
      };
      video.src = url;
      // An iPhone loads no picture data until a video plays; muted and inline it may, unasked.
      var playing = video.play();
      if (playing && playing.then) playing.then(null, function () {});
    });
  }

  // A refusal is marked: signed out (the 303 to the sign-in page, opaque with redirect: manual)
  // or a stale token (403), no later store from this page would get through either.
  function store(id, blob) {
    return fetch('/library/' + id + '/thumb', {
      method: 'PUT', body: blob, redirect: 'manual',
      headers: { 'X-CSRF-Token': csrf(), 'Content-Type': 'image/jpeg' }
    }).then(function (r) {
      if (r.ok) return;
      var err = new Error('the preview was not stored (' + r.status + ')');
      err.refused = r.type === 'opaqueredirect' || r.status === 403;
      throw err;
    });
  }

  function tile(img) { return img.closest('.media-thumb') || img.parentNode; }

  // One preview at a time: a library of new uploads would otherwise open every video at once.
  var queue = [];
  var busy = false;
  var gaveUp = false; // a refused store, or three failed in a row, ends the making for this page
  var failed = 0;     // stores failed in a row: an outage must not have every visit download a frame of every video

  // A store that failed costs its own tile only (a file deleted meanwhile, a dropped connection).
  // After a refused one, or a run of failures, nothing more is made here: the waiting tiles say
  // NO PREVIEW instead of MAKING PREVIEW for ever.
  function giveUp() {
    gaveUp = true;
    queue.splice(0).forEach(function (img) {
      var link = tile(img);
      link.classList.remove('is-making');
      if (link.dataset.kind === 'video') link.classList.add('no-preview');
    });
  }

  function next() {
    if (busy || gaveUp || !queue.length) return;
    busy = true;
    var img = queue.shift();
    var link = tile(img);
    var isVideo = link.dataset.kind === 'video';
    var made = isVideo
      ? frameOf(link.href)
      : Promise.resolve().then(function () { return draw(img, img.naturalWidth, img.naturalHeight); });
    made.then(toJpeg).then(function (blob) {
      return store(img.dataset.thumb, blob).then(function () {
        failed = 0;
        if (!isVideo) return; // the picture itself is already on show
        img.src = URL.createObjectURL(blob);
        link.classList.remove('is-making');
      }, function (err) {
        if (err.refused || ++failed >= 3) giveUp();
        throw err;
      });
    }).then(null, function (err) {
      link.classList.remove('is-making');
      if (isVideo) link.classList.add('no-preview');
      if (window.console) console.warn('no preview for ' + (link.dataset.name || img.dataset.thumb) + ': ' + (err && err.message ? err.message : err));
    }).then(function () {
      busy = false;
      next();
    });
  }

  // What the thumb route sent: nothing (a video with no preview yet, or a picture this browser
  // cannot show), the picture itself (larger than any stored preview), or a stored preview.
  function settle(img) {
    if (!img.dataset || !img.dataset.thumb || img.dataset.settled) return;
    if (/^blob:/.test(img.src)) return; // the preview this script just made
    var link = tile(img);
    var failed = !img.naturalWidth;
    var isVideo = link.dataset.kind === 'video';
    if (!failed && Math.max(img.naturalWidth, img.naturalHeight) <= MAX_SIDE) return; // a stored preview, or a small picture
    img.dataset.settled = '1';
    var storing = canStore && !gaveUp;
    if (failed && !(isVideo && storing)) { link.classList.add('no-preview'); return; }
    if (!storing) return; // a viewer sees the picture itself
    if (failed) link.classList.add('is-making');
    queue.push(img);
    next();
  }

  // load and error do not bubble, so they are caught on the way down; a picture that finished
  // before this script ran is settled on the spot.
  document.addEventListener('load', function (e) { if (e.target.tagName === 'IMG') settle(e.target); }, true);
  document.addEventListener('error', function (e) { if (e.target.tagName === 'IMG') settle(e.target); }, true);
  Array.prototype.forEach.call(document.querySelectorAll('img[data-thumb]'), function (img) {
    if (img.complete && img.getAttribute('src')) settle(img);
  });

  // ------------------------------------------------------------------ viewer ---

  // A preview is a link to the file (a[data-view]): without <dialog> (Safari before 15.4) it
  // simply opens the file in a new tab; with it, the file opens large on this page, a video
  // with its controls, and Previous / Next walk the page's files in order.
  var dialog = null;
  var stage, nameEl, metaEl, closeBtn, prevBtn, nextBtn, deleteBtn, detailsLink, downloadLink;
  var current = null;
  var downOnBackdrop = false;

  // The previews on show, in page order: the cards Find hides are skipped.
  function links() {
    return Array.prototype.filter.call(document.querySelectorAll('a[data-view]'), function (a) { return !a.closest('[hidden]'); });
  }

  // The Delete button of the card a preview sits in (the Library, for editors), if any.
  function deleteOf(link) {
    var card = link.closest('.media-card');
    return card ? card.querySelector('button[name="one"]') : null;
  }

  function clearStage() {
    // Focus on what goes (the video, the note's link) would drop out of the dialog, and the arrow
    // keys with it: Close keeps it inside.
    if (stage.contains(document.activeElement)) closeBtn.focus();
    var playing = stage.querySelector('video');
    if (playing) { playing.pause(); playing.removeAttribute('src'); playing.load(); }
    stage.textContent = '';
  }

  function cannotShow(link) {
    clearStage();
    var p = document.createElement('p');
    p.className = 'viewer-note';
    p.textContent = 'Cannot show this file here. ';
    var a = document.createElement('a');
    a.href = link.href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'Open the file itself';
    p.appendChild(a);
    stage.appendChild(p);
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'viewer';
    // Named by the file shown: read out as the viewer opens, and again on each step (aria-live).
    dialog.setAttribute('aria-labelledby', 'viewer-name');
    dialog.innerHTML =
      '<div class="viewer-head"><span class="viewer-name" id="viewer-name" aria-live="polite"></span><button type="button" class="small" data-close>Close</button></div>' +
      '<div class="viewer-stage"></div>' +
      '<div class="viewer-foot"><span class="viewer-meta"></span><div class="action-buttons">' +
      '<button type="button" class="small" data-step="-1">Previous</button>' +
      '<button type="button" class="small" data-step="1">Next</button>' +
      '<a class="button small" data-details>Details</a>' +
      '<a class="button small" data-download>Download</a>' +
      '<button type="button" class="small danger" data-delete>Delete</button></div></div>';
    document.body.appendChild(dialog);
    stage = dialog.querySelector('.viewer-stage');
    nameEl = dialog.querySelector('.viewer-name');
    metaEl = dialog.querySelector('.viewer-meta');
    closeBtn = dialog.querySelector('[data-close]');
    prevBtn = dialog.querySelector('[data-step="-1"]');
    nextBtn = dialog.querySelector('[data-step="1"]');
    deleteBtn = dialog.querySelector('[data-delete]');
    detailsLink = dialog.querySelector('[data-details]');
    downloadLink = dialog.querySelector('[data-download]');
    // A click lands on the dialog itself from the dimmed page round it, but also when a press
    // inside (selecting the name, dragging the video's timeline) is let go out there: only a
    // press that started on the dimmed page closes it.
    dialog.addEventListener('pointerdown', function (e) { downOnBackdrop = e.target === dialog; });
    dialog.addEventListener('click', function (e) {
      if ((e.target === dialog && downOnBackdrop) || e.target.closest('[data-close]')) { dialog.close(); return; }
      var step = e.target.closest('[data-step]');
      if (step) { move(parseInt(step.dataset.step, 10)); return; }
      if (e.target.closest('[data-delete]') && current) remove(current);
    });
    dialog.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'VIDEO') return; // the arrows move through the video there
      if (e.key === 'ArrowLeft') move(-1);
      if (e.key === 'ArrowRight') move(1);
    });
    // Focus goes back to the file last shown, not the one the viewer opened on (where the browser
    // has just put it); to Find when Delete took the last file on show (the page has no other).
    dialog.addEventListener('close', function () {
      var shown = current;
      clearStage();
      current = null;
      var back = shown && shown.isConnected ? shown : document.getElementById('find-q');
      if (back) back.focus();
    });
  }

  // The newest row of a page's Recently deleted (media_trash.id, AUTOINCREMENT, listed newest
  // first), 0 when it has none.
  function newest(page) {
    var box = page.querySelector('details.trash input[name="trash_id"]');
    return box ? +box.value : 0;
  }

  // The Library page a delete came back to: its "N files" line and its Recently deleted (now with
  // the file just deleted) replace this page's; Media (N) is recount()'s. Two deletes' answers can
  // cross: a page older than the one shown is dropped. A failure here only leaves the line stale
  // until the next load, never undoes the delete.
  function freshen(r) {
    Promise.resolve().then(function () { return r.text(); }).then(function (html) {
      var fresh = new DOMParser().parseFromString(html, 'text/html');
      if (newest(fresh) < newest(document)) return;
      var line = document.querySelector('.page-head .page-meta');
      var freshLine = fresh.querySelector('.page-head .page-meta');
      if (line && freshLine) line.textContent = freshLine.textContent;
      var trash = document.querySelector('details.trash');
      var freshTrash = fresh.querySelector('details.trash');
      var form = document.getElementById('library-form');
      if (!freshTrash || !form) return;
      freshTrash = document.importNode(freshTrash, true);
      freshTrash.open = !!(trash && trash.open);
      form.parentNode.insertBefore(freshTrash, trash || form.nextSibling);
      if (trash) trash.parentNode.removeChild(trash);
    }).then(null, function () {});
  }

  // Delete asks the card's own question and posts the card's own route, from here: the page stays
  // where it was (a reload put a phone back at the top) and the viewer goes on to the next file.
  // Anything but the Library coming back reloads the page. A refusal (a stale token, an error) is
  // the POST's own answer, and the file is still there: said first. The sign-in page (signed out)
  // and the Library failing to load after the delete went through speak for themselves. The fetch
  // follows the redirect, so the "Deleted" notice is used up on the way.
  function remove(link) {
    var btn = deleteOf(link);
    var card = link.closest('.media-card');
    if (!btn || !confirm(btn.dataset.confirm)) return;
    fetch(btn.form.action, {
      method: 'POST', body: new URLSearchParams({ one: btn.value }), headers: { 'X-CSRF-Token': csrf() }
    }).then(function (r) {
      var path = new URL(r.url).pathname;
      if (path !== '/library' && path !== '/login') alert('The file was not deleted (error ' + r.status + '). Reloading the page.');
      if (!r.ok || path !== '/library') { location.reload(); return; }
      if (!card.parentNode) return; // pressed twice: the first one took it
      freshen(r);
      var all = links();
      var i = all.indexOf(link);
      var to = all[i + 1] || all[i - 1];
      card.parentNode.removeChild(card);
      recount();
      if (current !== link) { if (current) steps(current); return; } // the viewer has moved on, or closed
      if (to) show(to); else dialog.close();
    }).then(null, function () { location.reload(); });
  }

  function move(by) {
    var all = links();
    var to = all[all.indexOf(current) + by];
    if (to) show(to);
  }

  // Previous / Next for the file shown, among the previews on show now.
  function steps(link) {
    var all = links();
    var i = all.indexOf(link);
    var focused = document.activeElement;
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i < 0 || i >= all.length - 1;
    // A step button switched off while it has the focus would drop the focus out of the dialog
    // (and the arrow keys with it): hand it to the other one, or to Close.
    if ((focused === prevBtn || focused === nextBtn) && focused.disabled) {
      var other = focused === prevBtn ? nextBtn : prevBtn;
      (other.disabled ? closeBtn : other).focus();
    }
  }

  function show(link) {
    if (!dialog) build();
    current = link;
    clearStage();
    var el;
    if (link.dataset.kind === 'video') {
      el = document.createElement('video');
      el.controls = true;
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('aria-label', link.dataset.name || '');
    } else {
      el = new Image();
      el.alt = link.dataset.name || '';
    }
    // The file would not show. When the server has it, this browser cannot decode it: say so.
    // When it is gone (deleted elsewhere) or the session has ended, the page is stale: reloading
    // shows the files that are left, or the sign-in page.
    el.onerror = function () {
      if (current !== link) return;
      fetch(link.href, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        if (current !== link) return;
        if (r.ok) cannotShow(link); else location.reload();
      }, function () { if (current === link) cannotShow(link); });
    };
    el.src = link.href;
    stage.appendChild(el);
    nameEl.textContent = link.dataset.name || '';
    // One unbreakable piece per fact: a phone broke the upload date at its hyphen.
    metaEl.textContent = '';
    (link.dataset.meta || '').split(' · ').forEach(function (fact, n) {
      if (n) metaEl.appendChild(document.createTextNode(' · '));
      var span = document.createElement('span');
      span.className = 'nowrap';
      span.textContent = fact;
      metaEl.appendChild(span);
    });
    steps(link);
    deleteBtn.hidden = !deleteOf(link);
    detailsLink.hidden = !link.dataset.page || link.dataset.page === location.pathname; // not on the file's own page
    if (link.dataset.page) detailsLink.href = link.dataset.page;
    // Saved under the file's own name (same origin, so the browser takes it), with the stored
    // file's extension when the name has lost it.
    var name = link.dataset.name || '';
    var ext = (/\.\w+$/.exec(link.pathname) || [''])[0];
    downloadLink.setAttribute('href', link.getAttribute('href'));
    downloadLink.download = name.slice(-ext.length).toLowerCase() === ext.toLowerCase() ? name : name + ext;
    if (!dialog.open) dialog.showModal();
  }

  if (window.HTMLDialogElement && HTMLDialogElement.prototype.showModal) {
    document.addEventListener('click', function (e) {
      var link = e.target && e.target.closest ? e.target.closest('a[data-view]') : null;
      if (!link || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // a new tab was asked for
      e.preventDefault();
      show(link);
    });
  }

  // ---------------------------------------------------------------- media bar ---

  // The Library's grid form: Delete selected and Add to playlist count the ticked files and are
  // off while none is (Add also while no playlist is picked: the page would come back with the
  // ticks gone), and Delete selected asks about the files by name, up to three (app.js shows a
  // submit button's own data-confirm). One request takes at most data-max files (library.js
  // MAX_DELETE): Select all ticks that many from the top of what is shown.
  var form = document.getElementById('library-form');
  var bulk = form && form.querySelector('[data-delete-selected]');
  var all = form && form.querySelector('[data-select-all]');
  var add = form && form.querySelector('[data-add-selected]');
  var addTo = document.getElementById('add-to');
  var picked = form && form.querySelector('[data-picked]');
  var sync = function () {};
  // After the viewer's Delete took a card off the page: the counts again (Find's own version also
  // forgets the card).
  var recount = function () { sync(); };
  if (bulk && all) {
    var max = parseInt(form.dataset.max, 10) || Infinity;
    // The tick boxes of the cards on show: Find unticks the ones it hides.
    var boxes = function () {
      return Array.prototype.filter.call(form.querySelectorAll('input[name="media_id"]'), function (b) { return !b.closest('[hidden]'); });
    };
    var ticked = function (every) { return every.filter(function (b) { return b.checked; }); };
    var full = function (every, n) { return n > 0 && n >= Math.min(every.length, max); };
    sync = function () {
      var every = boxes();
      var on = ticked(every);
      var n = on.length;
      var names = on.slice(0, 3).map(function (b) { return b.closest('.media-card').dataset.name; });
      var last = names.pop();
      bulk.disabled = !n || n > max;
      bulk.textContent = n > max ? 'Delete at most ' + max : n ? 'Delete selected (' + n + ')' : 'Delete selected';
      bulk.dataset.confirm = n === 1
        ? 'Delete ' + last + '? It is removed from every playlist that uses it.'
        : 'Delete ' + (n > 3 || !n ? 'these ' + n + ' files' : names.join(', ') + ' and ' + last) + '? They are removed from every playlist that uses them.';
      if (add && addTo) {
        add.disabled = !n || n > max || !addTo.value;
        add.textContent = n > max ? 'Add at most ' + max : n ? 'Add to playlist (' + n + ')' : 'Add to playlist';
      }
      all.textContent = full(every, n) ? 'Select none' : 'Select all';
      // Said to a screen reader (role=status), once per change: pageshow syncs again unchanged.
      var said = n ? n + (n === 1 ? ' file selected' : ' files selected') : '';
      if (picked && picked.textContent !== said) picked.textContent = said;
    };
    form.addEventListener('change', sync);
    all.addEventListener('click', function () {
      var every = boxes();
      var n = ticked(every).length;
      if (full(every, n)) {
        every.forEach(function (b) { b.checked = false; });
      } else {
        every.forEach(function (b) { if (!b.checked && n < max) { b.checked = true; n++; } });
      }
      sync();
    });
    // Enter on a tick box would submit the form through its first submit button (the hidden
    // noop, which does nothing). Enter ticks the box instead, as Space does.
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.type === 'checkbox') { e.preventDefault(); e.target.click(); }
    });
    sync();
    window.addEventListener('pageshow', sync); // the back/forward cache brings the page back as it was
  }

  // --------------------------------------------------------------------- find ---

  // Find / Show / Sort over the Library's cards (library.js card()'s data-*), in the browser. A
  // card that does not match is hidden, and unticked so nothing out of sight is deleted or added;
  // the cards are put in the order picked, which is also the order Add to playlist appends them
  // in. The view is kept for this tab, so the reload after a delete or an add shows the same files,
  // and per signed-in user (usernames are unique): the next account on the tab starts afresh.
  var finder = document.getElementById('media-find');
  var grid = finder && document.querySelector('.media-grid');
  if (grid) {
    var q = document.getElementById('find-q');
    var showSel = document.getElementById('find-show');
    var sortSel = document.getElementById('find-sort');
    var count = document.getElementById('media-count');
    var KEY = 'p5k-library-find:' + ((document.querySelector('.topbar .username') || {}).textContent || '');
    // The server sends the newest first: i is that order.
    var cards = Array.prototype.map.call(grid.children, function (card, i) {
      var d = card.dataset;
      return {
        card: card, box: card.querySelector('input[name="media_id"]'), i: i,
        name: (d.name || '').toLowerCase(), kind: d.kind, use: d.use, size: +d.size || 0, length: +d.length || 0
      };
    });
    var ORDER = {
      '': function (a, b) { return a.i - b.i; },
      oldest: function (a, b) { return b.i - a.i; },
      name: function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }) || a.i - b.i; },
      size: function (a, b) { return b.size - a.size || a.i - b.i; },
      length: function (a, b) { return b.length - a.length || a.i - b.i; }
    };
    var apply = function (reorder) {
      if (reorder) cards.slice().sort(ORDER[sortSel.value] || ORDER['']).forEach(function (c) { grid.appendChild(c.card); });
      var words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      var show = showSel.value;
      var shown = 0;
      cards.forEach(function (c) {
        var hide = (show === 'video' || show === 'image' ? c.kind !== show : show && c.use !== show) ||
          !words.every(function (w) { return c.name.indexOf(w) >= 0; });
        c.card.hidden = !!hide;
        if (!hide) shown++;
        else if (c.box) c.box.checked = false;
      });
      // Said to a screen reader (the heading is aria-live), once per change: a key that leaves the
      // count as it was says nothing.
      var text = 'Media (' + (shown === cards.length ? shown : shown + ' of ' + cards.length) + ')';
      if (count.textContent !== text) count.textContent = text;
      try { sessionStorage.setItem(KEY, JSON.stringify({ q: q.value, show: show, sort: sortSel.value })); } catch (e) { /* storage off */ }
      sync();
    };
    try {
      var kept = JSON.parse(sessionStorage.getItem(KEY)) || {};
      q.value = kept.q || '';
      showSel.value = kept.show || '';
      sortSel.value = kept.sort || '';
    } catch (e) { /* nothing kept */ }
    // A kept choice this page does not offer (no Default playlist any more): back to the first.
    if (showSel.selectedIndex < 0) showSel.selectedIndex = 0;
    if (sortSel.selectedIndex < 0) sortSel.selectedIndex = 0;
    recount = function () {
      cards = cards.filter(function (c) { return c.card.parentNode; });
      apply(false);
    };
    q.addEventListener('input', function () { apply(false); });
    showSel.addEventListener('change', function () { apply(false); });
    sortSel.addEventListener('change', function () { apply(true); });
    finder.hidden = false;
    apply(!!sortSel.value);
  }
})();
