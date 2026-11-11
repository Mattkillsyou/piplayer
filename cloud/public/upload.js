// Library upload queue: for each selected file read its metadata in the browser, hash it
// (sha256.js, 8 MiB slices) and drive the chunk protocol of src/uploads.js:
// POST init -> PUT parts (skipping the ones the server already has, PARALLEL at a time so
// the round trip of one part does not idle the connection) -> POST complete.
// Progress shows the hashing percentage first, then the upload percentage; a server error
// is shown as its {"detail"} text (plain English from src/uploads.js). While files are in
// flight the browser asks before the page is left or reloaded (the upload would stop; the
// server keeps the parts, so dropping the file again resumes). No CDN scripts, no inline
// handlers.
// An upload link's page (src/pages/links.js) runs the same queue against its own routes
// (data-base) and, once the files are in, sends them to the ticked projectors (data-play): there
// a file the library already holds needs no upload (init answers {existing: true}).
// That page is used on a phone, so two things keep a long upload alive there (and do no harm on
// the Library page): a part whose connection dropped is sent again a few times before the file
// is given up, and the screen is kept on while files are in flight (a locked phone suspends the
// page and drops what it was sending).
(function () {
  'use strict';

  var form = document.getElementById('upload-form');
  if (!form) return;
  var input = document.getElementById('file-input');
  var queue = document.getElementById('upload-queue');
  var status = document.getElementById('upload-status');
  var base = form.dataset.base || '/library/upload'; // where the chunk routes of src/uploads.js live
  var play = form.dataset.play || '';                // an upload link's "put these on the projectors" route
  var maxFiles = parseInt(form.dataset.maxFiles, 10) || 0; // most files one send takes (0: no limit, the Library)
  var RETRIES = 3;       // re-sends of one part after its connection dropped
  var RETRY_WAIT = 3000; // ms between them: a request started the instant a phone wakes can fail too
  var SLICE = 8 * 1024 * 1024;
  var PARALLEL = 4; // parts in flight per file (the server claims each part, so this is safe)
  var busy = false;

  window.addEventListener('beforeunload', function (e) {
    if (!busy) return;
    e.preventDefault();
    e.returnValue = ''; // the browser shows its own "leave page?" wording
  });

  // Screen wake lock while busy. The browser releases it whenever the page is hidden, so it is
  // asked for again when the page comes back; a browser without the API, or one that refuses
  // (battery saver), just goes without.
  var wake = null;
  function keepAwake() {
    if (!busy || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (w) {
      if (wake) wake.release().then(null, function () {}); // an older request resolved first: keep the newest
      wake = w;
      if (!busy) letSleep(); // the queue finished while the browser was deciding
    }, function () { /* refused */ });
  }
  function letSleep() {
    if (wake) { wake.release().then(null, function () {}); wake = null; }
  }
  document.addEventListener('visibilitychange', keepAwake);

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }

  function mb(n) { return (n / 1024 / 1024).toFixed(1); }

  // Read the {"detail"} of an error response (an HTML error page from the edge, say a 413
  // for an oversize part, has none: say so without quoting it).
  function detailOf(text, statusCode) {
    try { var d = JSON.parse(text).detail; if (d) return d; } catch (e) { /* not JSON */ }
    return 'The upload failed (' + statusCode + '). Try again.';
  }

  function request(method, url, body, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('X-CSRF-Token', csrf());
      if (body && !(body instanceof Blob)) xhr.setRequestHeader('Content-Type', 'application/json');
      if (onProgress) xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded); };
      xhr.onload = function () {
        // An expired session answers 303 -> /login?expired=1, which XHR follows to a 200
        // HTML page: test the landing URL before the status, or the 2xx branch would hand
        // the driver an empty init and it would PUT parts forever.
        if (xhr.status === 0 || (xhr.responseURL && /\/login(\?|$)/.test(xhr.responseURL))) {
          reject(new Error('Your session has expired; please sign in again.'));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(detailOf(xhr.responseText, xhr.status)));
          return;
        }
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (data && typeof data === 'object') resolve(data);
        else reject(new Error('The server gave an unexpected reply. Try again.'));
      };
      xhr.onerror = function () {
        // No reply at all (network gone, phone locked): `dropped` lets a part be sent again.
        var err = new Error('The connection dropped during the upload. ' + (play ? 'Choose all the files of this send again' : 'Drop the file again') + ' to resume.');
        err.dropped = true;
        reject(err);
      };
      xhr.send(body === undefined ? null : (body instanceof Blob ? body : JSON.stringify(body)));
    });
  }

  function ext(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  }

  var VIDEO = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];

  // Duration / dimensions from the browser's decoder; nulls when it cannot parse the file
  // (the server accepts nulls; the player only needs them for images' default duration).
  function readMeta(file) {
    var url = URL.createObjectURL(file);
    var isVideo = VIDEO.indexOf(ext(file.name)) >= 0;
    return new Promise(function (resolve) {
      var done = false;
      function finish(meta) { if (!done) { done = true; URL.revokeObjectURL(url); resolve(meta); } }
      var t = setTimeout(function () { finish({ duration_seconds: null, width: null, height: null }); }, 15000);
      if (isVideo) {
        var v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = function () {
          clearTimeout(t);
          finish({
            duration_seconds: isFinite(v.duration) && v.duration > 0 ? v.duration : null,
            width: v.videoWidth || null, height: v.videoHeight || null
          });
        };
        v.onerror = function () { clearTimeout(t); finish({ duration_seconds: null, width: null, height: null }); };
        v.src = url;
      } else {
        var img = new Image();
        img.onload = function () { clearTimeout(t); finish({ duration_seconds: null, width: img.naturalWidth || null, height: img.naturalHeight || null }); };
        img.onerror = function () { clearTimeout(t); finish({ duration_seconds: null, width: null, height: null }); };
        img.src = url;
      }
    });
  }

  // Count GIF Graphic Control Extension headers (21 F9 04) in a slice: more than one means
  // an animated GIF. Limitation: a pattern straddling two slices is missed and raw pixel
  // data could contain it by chance; such a GIF is uploaded as an image / video accordingly.
  function countGce(bytes) {
    var n = 0;
    for (var i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9 && bytes[i + 2] === 0x04) n++;
    }
    return n;
  }

  function hashFile(file, onProgress) {
    var h = sha256.create();
    var gif = ext(file.name) === '.gif';
    var gce = 0;
    var offset = 0;
    function step() {
      if (offset >= file.size) return Promise.resolve({ sha256: h.digest(), animated: gif && gce > 1 });
      var end = Math.min(offset + SLICE, file.size);
      return file.slice(offset, end).arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        h.update(bytes);
        if (gif) gce += countGce(bytes);
        offset = end;
        onProgress(offset);
        return step();
      });
    }
    return step();
  }

  function addRow(file) {
    var li = document.createElement('li');
    var label = document.createElement('div');
    label.textContent = file.name + ' (' + mb(file.size) + ' MB)';
    var bar = document.createElement('progress');
    bar.max = 100; bar.value = 0;
    var text = document.createElement('div');
    text.className = 'muted';
    li.appendChild(label); li.appendChild(bar); li.appendChild(text);
    queue.appendChild(li);
    return {
      set: function (pct, msg) { bar.value = pct; text.textContent = msg; },
      error: function (msg) { bar.value = 0; text.textContent = 'Error: ' + msg; text.className = 'alert error'; }
    };
  }

  function uploadOne(file, row) {
    var meta, hashed, init;
    return readMeta(file).then(function (m) {
      meta = m;
      return hashFile(file, function (done) {
        row.set(done / file.size * 100, 'Hashing ' + (done / file.size * 100).toFixed(0) + '%');
      });
    }).then(function (h) {
      hashed = h;
      var body = {
        name: file.name, size: file.size, sha256: h.sha256,
        media_type: VIDEO.indexOf(ext(file.name)) >= 0 ? 'video' : 'image',
        duration_seconds: meta.duration_seconds, width: meta.width, height: meta.height
      };
      if (ext(file.name) === '.gif') body.animated = h.animated;
      row.set(0, 'Starting upload...');
      return request('POST', form.dataset.init, body);
    }).then(function (r) {
      init = r;
      if (init.existing) return null; // already in the library (an upload link): nothing to send
      if (!init.upload_id || !(init.part_size > 0)) throw new Error('The server gave an unexpected reply. Try again.');
      // Resume: skip the parts the server already holds (page reloaded mid-upload).
      return init.received > 0 ? request('GET', base + '/' + init.upload_id) : { parts: [] };
    }).then(function (st) {
      if (!st) return null;
      var have = {};
      (st.parts || []).forEach(function (n) { have[n] = true; });
      var partSize = init.part_size;
      var total = Math.ceil(file.size / partSize);
      var received = st.received || 0;
      var inflight = {}; // part number -> bytes the browser has sent of it so far
      function progress() {
        if (failed) return; // the row shows the error: parts still in flight must not write over it
        var extra = 0;
        Object.keys(inflight).forEach(function (k) { extra += inflight[k]; });
        var done = Math.min(received + extra, file.size);
        var pct = done / file.size * 100;
        row.set(pct, 'Uploading ' + mb(done) + ' / ' + mb(file.size) + ' MB (' + pct.toFixed(0) + '%)');
      }
      var next = 1;
      var failed = null;
      // One lane: take the next part nobody holds, send it, repeat until the parts run out
      // (or another lane failed; that error is the one reported).
      function lane() {
        while (next <= total && have[next]) next++;
        if (failed || next > total) return Promise.resolve();
        var n = next++;
        var start = (n - 1) * partSize;
        var blob = file.slice(start, Math.min(start + partSize, file.size));
        var tries = 0;
        // Send the part; when the connection dropped, wait and send it again (the server
        // acknowledges a part that already landed, so a re-send is safe). A refusal from the
        // server (4xx / 5xx) is final, and so is a drop once another lane has failed the file.
        function put() {
          inflight[n] = 0;
          return request('PUT', base + '/' + init.upload_id + '/part/' + n, blob, function (loaded) {
            inflight[n] = loaded;
            progress();
          }).then(null, function (err) {
            if (!err.dropped || failed || ++tries > RETRIES) throw err;
            inflight[n] = 0; // its bytes go again: not counted while it waits
            progress();
            return new Promise(function (resolve) { setTimeout(resolve, RETRY_WAIT); }).then(function () {
              if (failed) throw err;
              return put();
            });
          });
        }
        return put().then(function () {
          delete inflight[n];
          received += blob.size;
          progress();
          return lane();
        }, function (err) {
          delete inflight[n];
          failed = failed || err;
          throw err;
        });
      }
      progress();
      var lanes = [];
      for (var i = 0; i < PARALLEL; i++) lanes.push(lane());
      return Promise.all(lanes);
    }).then(function () {
      if (init.existing) return null;
      row.set(100, 'Upload received, saving...');
      return request('POST', base + '/' + init.upload_id + '/complete');
    }).then(function () {
      row.set(100, 'Done.');
      return hashed.sha256; // truthy: the file is in the library
    }).catch(function (err) {
      row.error(err.message);
      return false;
    });
  }

  // The projectors ticked on an upload link's page (device row ids).
  function tickedDevices() {
    return Array.prototype.map.call(form.querySelectorAll('input[name="device"]:checked'), function (el) {
      return parseInt(el.value, 10);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    var devices = play ? tickedDevices() : [];
    if (play && !devices.length) {
      status.textContent = 'Pick a projector first.';
      return;
    }
    if (maxFiles && files.length > maxFiles) { // said before a byte moves, not after everything uploaded
      status.textContent = 'Pick at most ' + maxFiles + ' files at a time.';
      return;
    }
    var button = form.querySelector('button');
    button.disabled = true;
    busy = true;
    keepAwake();
    status.textContent = '';
    if (play) queue.textContent = ''; // the link page is not reloaded: start each send with an empty queue
    var rows = files.map(addRow);
    var ok = 0;
    var sent = []; // sha256 of every file that is in the library now, in the order picked
    var chain = Promise.resolve();
    files.forEach(function (file, i) {
      chain = chain.then(function () { return uploadOne(file, rows[i]); }).then(function (r) { if (r) { ok++; sent.push(r); } });
    });
    chain.then(function () {
      if (!play || !sent.length) return null;
      status.textContent = 'Sending to the projector...';
      return request('POST', play, { media: sent, devices: devices }).then(function (r) {
        return r.message || 'Sent.';
      }, function (err) {
        return 'The upload arrived but was not sent to the projector: ' + err.message;
      });
    }).then(function (sentText) {
      busy = false;
      letSleep();
      button.disabled = false;
      input.value = '';
      if (play) {
        // A send replaces what the projectors play, so a second try must hold every file, not only
        // the failed ones (the ones already in the library go straight through).
        var failed = ok === files.length ? '' : (files.length - ok) + ' of ' + files.length + ' file(s) failed; see the errors above.' +
          (ok ? ' Choose all ' + files.length + ' files again to send them together.' : '');
        status.textContent = [sentText, failed].filter(Boolean).join(' ');
        return;
      }
      if (ok === files.length) {
        status.textContent = 'Upload complete. Reloading...';
        window.location.reload();
      } else {
        status.textContent = ok + ' of ' + files.length + ' file(s) uploaded; see the errors above.' +
          (ok ? ' Reload the page to see them in the list.' : '');
      }
    });
  });
})();
