// Media previews on the Library page and in the playlist editor (src/pages/library.js thumbCell):
// the small pictures, the viewer a picture opens, and the Library's "Delete selected".
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

  // A frame of the video at `url` as a canvas. The frame is taken FRAME_AT seconds in; when
  // that one is black (a slow fade, a title card) the middle of the video is tried once.
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
        if (!retried && length > 2 * FRAME_AT && isDark(canvas)) {
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

  function store(id, blob) {
    return fetch('/library/' + id + '/thumb', {
      method: 'PUT', body: blob, redirect: 'manual',
      headers: { 'X-CSRF-Token': csrf(), 'Content-Type': 'image/jpeg' }
    }).then(function (r) {
      if (!r.ok) throw new Error('the preview was not stored (' + r.status + ')');
    });
  }

  function tile(img) { return img.closest('.media-thumb') || img.parentNode; }

  // One preview at a time: a library of new uploads would otherwise open every video at once.
  var queue = [];
  var busy = false;
  var gaveUp = false; // a refused store (signed out, a stale token) ends the making for this page

  // After a refused store nothing more is made here: the waiting tiles say NO PREVIEW instead of
  // MAKING PREVIEW for ever.
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
        if (!isVideo) return; // the picture itself is already on show
        img.src = URL.createObjectURL(blob);
        link.classList.remove('is-making');
      }, function (err) { giveUp(); throw err; });
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
  var stage, nameEl, metaEl, closeBtn, prevBtn, nextBtn, deleteBtn;
  var current = null;
  var downOnBackdrop = false;

  function links() { return Array.prototype.slice.call(document.querySelectorAll('a[data-view]')); }

  // The Delete button of the card a preview sits in (the Library, for editors), if any.
  function deleteOf(link) {
    var card = link.closest('.media-card');
    return card ? card.querySelector('button[name="one"]') : null;
  }

  function clearStage() {
    var playing = stage.querySelector('video');
    if (playing) { playing.pause(); playing.removeAttribute('src'); playing.load(); }
    stage.textContent = '';
  }

  function cannotShow(link) {
    clearStage();
    var p = document.createElement('p');
    p.className = 'viewer-note';
    p.textContent = 'This browser cannot show this file. It still plays on the projector. ';
    var a = document.createElement('a');
    a.href = link.href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'Open the file itself';
    p.appendChild(a);
    stage.appendChild(p);
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'viewer';
    dialog.setAttribute('aria-label', 'Preview');
    dialog.innerHTML =
      '<div class="viewer-head"><span class="viewer-name"></span><button type="button" class="small" data-close>Close</button></div>' +
      '<div class="viewer-stage"></div>' +
      '<div class="viewer-foot"><span class="viewer-meta"></span><div class="action-buttons">' +
      '<button type="button" class="small" data-step="-1">Previous</button>' +
      '<button type="button" class="small" data-step="1">Next</button>' +
      '<button type="button" class="small danger" data-delete>Delete</button></div></div>';
    document.body.appendChild(dialog);
    stage = dialog.querySelector('.viewer-stage');
    nameEl = dialog.querySelector('.viewer-name');
    metaEl = dialog.querySelector('.viewer-meta');
    closeBtn = dialog.querySelector('[data-close]');
    prevBtn = dialog.querySelector('[data-step="-1"]');
    nextBtn = dialog.querySelector('[data-step="1"]');
    deleteBtn = dialog.querySelector('[data-delete]');
    // A click lands on the dialog itself from the dimmed page round it, but also when a press
    // inside (selecting the name, dragging the video's timeline) is let go out there: only a
    // press that started on the dimmed page closes it.
    dialog.addEventListener('pointerdown', function (e) { downOnBackdrop = e.target === dialog; });
    dialog.addEventListener('click', function (e) {
      if ((e.target === dialog && downOnBackdrop) || e.target.closest('[data-close]')) { dialog.close(); return; }
      var step = e.target.closest('[data-step]');
      if (step) { move(parseInt(step.dataset.step, 10)); return; }
      // Delete presses the card's own button: one question, one route, whichever way it is reached.
      if (e.target.closest('[data-delete]') && current && deleteOf(current)) deleteOf(current).click();
    });
    dialog.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'VIDEO') return; // the arrows move through the video there
      if (e.key === 'ArrowLeft') move(-1);
      if (e.key === 'ArrowRight') move(1);
    });
    dialog.addEventListener('close', function () { clearStage(); current = null; });
  }

  function move(by) {
    var all = links();
    var to = all[all.indexOf(current) + by];
    if (to) show(to);
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
    } else {
      el = new Image();
      el.alt = link.dataset.name || '';
    }
    el.onerror = function () { if (current === link) cannotShow(link); };
    el.src = link.href;
    stage.appendChild(el);
    nameEl.textContent = link.dataset.name || '';
    metaEl.textContent = link.dataset.meta || '';
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
    deleteBtn.hidden = !deleteOf(link);
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

  // --------------------------------------------------------- delete selected ---

  // The Library's grid form: the button counts the ticked files, is off while none is, and
  // asks about that many (app.js shows a submit button's own data-confirm). One delete takes at
  // most data-max files (library.js MAX_DELETE): Select all ticks that many from the top.
  var form = document.getElementById('library-form');
  var bulk = form && form.querySelector('[data-delete-selected]');
  var all = form && form.querySelector('[data-select-all]');
  if (bulk && all) {
    var max = parseInt(form.dataset.max, 10) || Infinity;
    var boxes = function () { return Array.prototype.slice.call(form.querySelectorAll('input[name="media_id"]')); };
    var ticked = function (every) { return every.filter(function (b) { return b.checked; }).length; };
    var full = function (every, n) { return n > 0 && n >= Math.min(every.length, max); };
    var sync = function () {
      var every = boxes();
      var n = ticked(every);
      bulk.disabled = !n || n > max;
      bulk.textContent = n > max ? 'Delete at most ' + max : n ? 'Delete selected (' + n + ')' : 'Delete selected';
      bulk.dataset.confirm = n === 1
        ? 'Delete the selected file? It is removed from every playlist that uses it.'
        : 'Delete these ' + n + ' files? They are removed from every playlist that uses them.';
      all.textContent = full(every, n) ? 'Select none' : 'Select all';
    };
    form.addEventListener('change', sync);
    all.addEventListener('click', function () {
      var every = boxes();
      var n = ticked(every);
      if (full(every, n)) {
        every.forEach(function (b) { b.checked = false; });
      } else {
        every.forEach(function (b) { if (!b.checked && n < max) { b.checked = true; n++; } });
      }
      sync();
    });
    // Enter on a tick box would submit the form with its first enabled submit button: with
    // Delete selected off, that is the first card's own Delete, a file nobody pointed at. Enter
    // ticks the box instead, as Space does.
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.type === 'checkbox') { e.preventDefault(); e.target.click(); }
    });
    sync();
    window.addEventListener('pageshow', sync); // the back/forward cache brings the page back as it was
  }
})();
