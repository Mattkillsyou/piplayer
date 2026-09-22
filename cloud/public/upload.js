// Library upload queue: for each selected file read its metadata in the browser, hash it
// (sha256.js, 8 MiB slices) and drive the chunk protocol of src/uploads.js:
// POST init -> PUT parts (skipping the ones the server already has, PARALLEL at a time so
// the round trip of one part does not idle the connection) -> POST complete.
// Progress shows the hashing percentage first, then the upload percentage; a server error
// is shown as its {"detail"} text (plain English from src/uploads.js). While files are in
// flight the browser asks before the page is left or reloaded (the upload would stop; the
// server keeps the parts, so dropping the file again resumes). No CDN scripts, no inline
// handlers.
(function () {
  'use strict';

  var form = document.getElementById('upload-form');
  if (!form) return;
  var input = document.getElementById('file-input');
  var queue = document.getElementById('upload-queue');
  var status = document.getElementById('upload-status');
  var SLICE = 8 * 1024 * 1024;
  var PARALLEL = 4; // parts in flight per file (the server claims each part, so this is safe)
  var busy = false;

  window.addEventListener('beforeunload', function (e) {
    if (!busy) return;
    e.preventDefault();
    e.returnValue = ''; // the browser shows its own "leave page?" wording
  });

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
      xhr.onerror = function () { reject(new Error('The connection dropped during the upload. Drop the file again to resume.')); };
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
      if (!init.upload_id || !(init.part_size > 0)) throw new Error('The server gave an unexpected reply. Try again.');
      // Resume: skip the parts the server already holds (page reloaded mid-upload).
      return init.received > 0 ? request('GET', '/library/upload/' + init.upload_id) : { parts: [] };
    }).then(function (st) {
      var have = {};
      (st.parts || []).forEach(function (n) { have[n] = true; });
      var partSize = init.part_size;
      var total = Math.ceil(file.size / partSize);
      var received = st.received || 0;
      var inflight = {}; // part number -> bytes the browser has sent of it so far
      function progress() {
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
        inflight[n] = 0;
        return request('PUT', '/library/upload/' + init.upload_id + '/part/' + n, blob, function (loaded) {
          inflight[n] = loaded;
          progress();
        }).then(function () {
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
      row.set(100, 'Upload received, saving...');
      return request('POST', '/library/upload/' + init.upload_id + '/complete');
    }).then(function () {
      row.set(100, 'Done.');
      return true;
    }).catch(function (err) {
      row.error(err.message);
      return false;
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    var button = form.querySelector('button');
    button.disabled = true;
    busy = true;
    status.textContent = '';
    var rows = files.map(addRow);
    var ok = 0;
    var chain = Promise.resolve();
    files.forEach(function (file, i) {
      chain = chain.then(function () { return uploadOne(file, rows[i]); }).then(function (r) { if (r) ok++; });
    });
    chain.then(function () {
      busy = false;
      button.disabled = false;
      input.value = '';
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
