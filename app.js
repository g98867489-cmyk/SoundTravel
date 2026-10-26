/* ============================================================
   SoundTravel — UI + audio engine  (v2: turbo + gzip)
   ============================================================ */
(function () {
  "use strict";

  var P = window.STProto;
  var $ = function (id) { return document.getElementById(id); };
  var RX_MODES = ["turbo", "fast", "balanced", "safe"];
  var MAX_BYTES = 8 * 1024 * 1024;

  var ctx = null;
  function ac() {
    if (!ctx) {
      try { ctx = new AudioContext({ sampleRate: 48000 }); }
      catch (e) { ctx = new AudioContext(); }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  var S = {
    kind: "file",
    payload: null,
    header: null,
    mode: "turbo",
    tx: null, txTimer: null, sources: [], gain: null,
    playing: false,
    rxs: [], stream: null, node: null, sink: null, proc: null,
    listening: false, uiTimer: null, blobUrl: null,
    wakeLock: null
  };

  /* ---------------- helpers ---------------- */
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    if (sec < 60) return Math.ceil(sec) + " sec";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    if (m < 60) return m + " min" + (s ? " " + s + " sec" : "");
    var h = Math.floor(m / 60);
    return h + " ghanta " + (m % 60) + " min";
  }
  async function keepAwake(on) {
    try {
      if (on && "wakeLock" in navigator && !S.wakeLock) {
        S.wakeLock = await navigator.wakeLock.request("screen");
      } else if (!on && S.wakeLock) {
        S.wakeLock.release(); S.wakeLock = null;
      }
    } catch (e) {}
  }

  /* ---------------- compression (gzip) ---------------- */
  var NO_GZIP = /^(image|audio|video)\//i;
  var NO_GZIP_EXT = /\.(zip|rar|7z|gz|bz2|xz|jpg|jpeg|png|gif|webp|heic|mp4|mov|mkv|mp3|m4a|aac|ogg|apk|pdf)$/i;

  async function compress(bytes, name, mime) {
    if (!("CompressionStream" in window)) return { bytes: bytes, enc: "none" };
    if (NO_GZIP.test(mime || "") || NO_GZIP_EXT.test(name || "")) {
      return { bytes: bytes, enc: "none" };
    }
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      var out = new Uint8Array(await new Response(stream).arrayBuffer());
      if (out.length < bytes.length * 0.97) return { bytes: out, enc: "gzip" };
    } catch (e) {}
    return { bytes: bytes, enc: "none" };
  }

  async function decompress(bytes, enc) {
    if (enc !== "gzip" || !("DecompressionStream" in window)) return bytes;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return bytes; }
  }

  /* ---------------- tabs ---------------- */
  $("tabSend").addEventListener("click", function () { switchTab("send"); });
  $("tabRecv").addEventListener("click", function () { switchTab("recv"); });
  function switchTab(which) {
    var send = which === "send";
    $("tabSend").classList.toggle("on", send);
    $("tabRecv").classList.toggle("on", !send);
    $("panelSend").hidden = !send;
    $("panelRecv").hidden = send;
  }

  /* ---------------- kind ---------------- */
  Array.prototype.forEach.call($("kindBtns").children, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call($("kindBtns").children, function (x) {
        x.classList.toggle("on", x === b);
      });
      S.kind = b.dataset.kind;
      $("fileArea").hidden = S.kind !== "file";
      $("textArea").hidden = S.kind !== "text";
      if (S.kind === "text") { S.payload = null; S.header = null; }
      updateEstimate();
    });
  });

  /* ---------------- mode ---------------- */
  Array.prototype.forEach.call($("modeBtns").children, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call($("modeBtns").children, function (x) {
        x.classList.toggle("on", x === b);
      });
      S.mode = b.dataset.mode;
      updateEstimate();
    });
  });

  /* ---------------- file pick ---------------- */
  var drop = $("drop"), input = $("fileInput");

  drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", function () {
    if (input.files && input.files[0]) takeFile(input.files[0]);
  });

  async function takeFile(file) {
    $("fileName").textContent = "Processing…";
    $("startBtn").disabled = true;

    var blob = file, name = file.name, mime = file.type || "application/octet-stream";
    var note = "";

    var q = $("imgQuality") ? $("imgQuality").value : "1400";
    if (q !== "0" && file.type.indexOf("image/") === 0 && file.size > 30000) {
      try {
        blob = await compressImage(file, +q);
        name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        mime = "image/jpeg";
        note = " · photo " + fmtBytes(file.size) + " → " + fmtBytes(blob.size);
      } catch (e) {}
    }

    var raw = new Uint8Array(await blob.arrayBuffer());

    if (raw.length > MAX_BYTES) {
      $("fileName").textContent = "Bahut bada file (" + fmtBytes(raw.length) + "). 8 MB tak hi bhej sakte hain.";
      S.payload = null; S.header = null;
      updateEstimate();
      return;
    }

    var packed = await compress(raw, name, mime);
    if (packed.enc === "gzip") {
      note += " · gzip " + fmtBytes(raw.length) + " → " + fmtBytes(packed.bytes.length);
    }

    S.payload = packed.bytes;
    S.header = { name: name, mime: mime, size: raw.length, enc: packed.enc };

    $("fileName").textContent = name + " · " + fmtBytes(packed.bytes.length) + note;
    updateEstimate();
  }

  function compressImage(file, maxSide) {
    return new Promise(function (resolve, reject) {
      createImageBitmap(file).then(function (bmp) {
        var scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(bmp, 0, 0, w, h);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("fail")); }, "image/jpeg", 0.62);
      }).catch(reject);
    });
  }

  /* ---------------- estimate ---------------- */
  function updateEstimate() {
    var el = $("estimate");
    var bps = P.bytesPerSec(S.mode, 48000);

    if (S.kind === "text") {
      var n = new TextEncoder().encode($("textInput").value).length;
      if (!n) {
        el.textContent = "Text likho, phir Start dabao. (gzip lagta hai, to bahut tez jayega)";
        $("startBtn").disabled = true;
        return;
      }
      var est = Math.ceil(n / 3);
      el.innerHTML = fmtBytes(n) + " (gzip ke baad ~" + fmtBytes(est) + ") · <b>" +
        bps.toFixed(0) + " B/s</b> · lagbhag <b>" + fmtTime(est / bps) + "</b>";
      $("startBtn").disabled = false;
      return;
    }

    if (!S.payload) {
      el.textContent = "Pehle file chuno.";
      $("startBtn").disabled = true;
      return;
    }
    var sec = S.payload.length / bps;
    el.innerHTML = fmtBytes(S.payload.length) + " · <b>" + bps.toFixed(0) + " B/s</b> · lagbhag <b>" +
      fmtTime(sec) + "</b>" +
      (sec > 900 ? "<br><span style='color:#e6b455'>Bada file hai — phone paas rakho aur screen on chhodo.</span>" : "");
    $("startBtn").disabled = false;
  }
  $("textInput").addEventListener("input", updateEstimate);
  if ($("imgQuality")) {
    $("imgQuality").addEventListener("change", function () {
      if (S.kind === "file" && input.files && input.files[0]) takeFile(input.files[0]);
    });
  }

  /* ---------------- transmit ---------------- */
  $("vol").addEventListener("input", function () {
    $("volV").textContent = this.value;
    if (S.gain) S.gain.gain.value = (+this.value) / 100;
  });

  $("startBtn").addEventListener("click", startTx);
  $("stopBtn").addEventListener("click", function () { stopTx(true); });

  async function startTx() {
    $("startBtn").disabled = true;

    if (S.kind === "text") {
      var txt = $("textInput").value;
      if (!txt.trim()) { $("startBtn").disabled = false; return; }
      var raw = new TextEncoder().encode(txt);
      var packed = await compress(raw, "message.txt", "text/plain");
      S.payload = packed.bytes;
      S.header = {
        name: "message.txt",
        mime: "text/plain;charset=utf-8",
        size: raw.length,
        enc: packed.enc
      };
    }
    if (!S.payload || !S.payload.length) {
      alert("Pehle kuch chuno ya likho.");
      $("startBtn").disabled = false;
      return;
    }

    var c = ac();
    if (!S.gain) {
      S.gain = c.createGain();
      S.gain.connect(c.destination);
    }
    S.gain.gain.value = (+$("vol").value) / 100;

    S.tx = P.createTransmitter(S.header, S.payload, S.mode, c.sampleRate);
    S.playing = true;
    S.sources = [];

    var nextTime = c.currentTime + 0.5;

    function pump() {
      if (!S.playing) return;
      while (nextTime < c.currentTime + 2.0) {
        var chunk = S.tx.nextChunk(Math.floor(c.sampleRate / 2));
        if (!chunk) {
          S.tx.reset();
          nextTime += 0.6;
          continue;
        }
        var b = c.createBuffer(1, chunk.length, c.sampleRate);
        b.copyToChannel(chunk, 0);
        var src = c.createBufferSource();
        src.buffer = b;
        src.connect(S.gain);
        src.start(nextTime);
        S.sources.push(src);
        nextTime += chunk.length / c.sampleRate;
      }
      if (S.sources.length > 60) S.sources.splice(0, S.sources.length - 60);
    }

    S.txTimer = setInterval(pump, 150);
    pump();

    $("stopBtn").disabled = false;
    $("txbars").classList.add("live");
    $("txPill").textContent = "transmitting";
    $("txPill").classList.add("live");
    keepAwake(true);

    var bars = $("txbars");
    bars.innerHTML = "";
    for (var i = 0; i < 26; i++) {
      var el = document.createElement("i");
      el.style.animationDelay = (i * 0.045) + "s";
      bars.appendChild(el);
    }
  }

  function stopTx(user) {
    S.playing = false;
    if (S.txTimer) { clearInterval(S.txTimer); S.txTimer = null; }
    S.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    S.sources = [];
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
    $("txbars").classList.remove("live");
    $("txbars").innerHTML = "";
    $("txPill").textContent = "idle";
    $("txPill").classList.remove("live");
    keepAwake(false);
    if (user) updateEstimate();
  }

  /* ============================================================
     RECEIVE — chaaro modes ek saath (auto detect)
     ============================================================ */
  $("listenBtn").addEventListener("click", startRx);
  $("resetBtn").addEventListener("click", function () { resetRx(); });

  async function startRx() {
    var c = ac();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("rxStatus").textContent = "Is browser me mic support nahi hai.";
      return;
    }

    resetRx(true);

    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      });
    } catch (e) {
      $("rxStatus").textContent = "Mic permission nahi mili. Browser me allow karo.";
      return;
    }

    S.rxs = RX_MODES.map(function (m) {
      return {
        mode: m,
        rx: P.createReceiver({
          mode: m,
          sampleRate: c.sampleRate,
          onComplete: function (res) { onComplete(m, res); }
        })
      };
    });

    var src = c.createMediaStreamSource(S.stream);

    if (c.audioWorklet) {
      try {
        await c.audioWorklet.addModule("recorder-worklet.js");
        var node = new AudioWorkletNode(c, "st-recorder", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
        });
        node.port.onmessage = function (e) { onSamples(e.data); };
        S.sink = c.createGain();
        S.sink.gain.value = 0;
        src.connect(node); node.connect(S.sink); S.sink.connect(c.destination);
        S.node = node;
      } catch (e) { fallbackProcessor(c, src); }
    } else {
      fallbackProcessor(c, src);
    }

    S.listening = true;
    $("listenBtn").disabled = true;
    $("resetBtn").disabled = false;
    $("rxPill").textContent = "listening";
    $("rxPill").classList.add("live");
    $("rxStatus").textContent = "Sun raha hoon… bhejne wale phone ke paas rakho.";
    keepAwake(true);

    S.uiTimer = setInterval(updateRxUI, 250);
  }

  function fallbackProcessor(c, src) {
    var proc = c.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = function (e) { onSamples(e.inputBuffer.getChannelData(0).slice(0)); };
    src.connect(proc);
    proc.connect(c.destination);
    S.proc = proc;
  }

  var lastLevel = 0;
  function onSamples(data) {
    if (!S.listening) return;
    var sum = 0;
    for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
    lastLevel = Math.sqrt(sum / data.length);

    for (var k = 0; k < S.rxs.length; k++) {
      try { S.rxs[k].rx.push(data); } catch (e) {}
    }
  }

  function best() {
    var b = null;
    for (var i = 0; i < S.rxs.length; i++) {
      var pr = S.rxs[i].rx.progress();
      if (!b || pr.have > b.progress.have) b = { mode: S.rxs[i].mode, progress: pr };
    }
    return b;
  }

  function updateRxUI() {
    $("levelBar").style.width = Math.min(100, lastLevel * 420) + "%";

    var b = best();
    if (!b || !b.progress.have) {
      $("rxStats").textContent = "Abhi koi data nahi mila. Volume badhao / phone paas karo.";
      return;
    }

    var pr = b.progress;
    var bps = P.bytesPerSec(b.mode, 48000);

    if (pr.total > 0) {
      var pct = Math.min(100, (pr.have / pr.total) * 100);
      $("prog").style.width = pct + "%";
      var remain = (pr.total - pr.have) * P.PAYLOAD_MAX;
      $("rxStats").innerHTML =
        "<b>" + pct.toFixed(0) + "%</b> · " + pr.have + " / " + pr.total + " packets · " +
        fmtBytes(pr.bytes) + "<br>" +
        "mode: <b>" + b.mode + "</b> · bacha: <b>" + fmtTime(remain / bps) + "</b>" +
        (pr.bad ? " · retries: " + pr.bad : "");
    } else {
      $("prog").style.width = "4%";
      $("rxStats").textContent = "Packet mil rahe hain… header ka intezaar (" + pr.have + " packets)";
    }
  }

  async function onComplete(mode, res) {
    stopRx();

    var h = res.header || {};
    var bytes = await decompress(res.data, h.enc);
    var blob = new Blob([bytes], { type: h.mime || "application/octet-stream" });

    if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
    S.blobUrl = URL.createObjectURL(blob);

    $("prog").style.width = "100%";
    $("rxStatus").textContent = "Mil gaya! (" + mode + " mode)";
    $("rxStats").innerHTML = "<b>" + (h.name || "file") + "</b> · " + fmtBytes(bytes.length) +
      (h.enc === "gzip" ? " (gzip khola gaya)" : "");

    var dl = $("dlBtn");
    dl.href = S.blobUrl;
    dl.download = h.name || "received.bin";

    var prev = $("preview");
    prev.innerHTML = "";

    if (h.mime && h.mime.indexOf("image/") === 0) {
      var img = document.createElement("img");
      img.src = S.blobUrl;
      prev.appendChild(img);
    } else if (h.mime && h.mime.indexOf("audio/") === 0) {
      var au = document.createElement("audio");
      au.controls = true; au.src = S.blobUrl;
      prev.appendChild(au);
    } else if (h.mime && h.mime.indexOf("video/") === 0) {
      var vi = document.createElement("video");
      vi.controls = true; vi.src = S.blobUrl;
      prev.appendChild(vi);
    } else if (h.mime && h.mime.indexOf("text/") === 0) {
      var pre = document.createElement("pre");
      pre.textContent = new TextDecoder().decode(bytes.subarray(0, 4000));
      prev.appendChild(pre);
    }

    $("result").hidden = false;
    $("rxPill").textContent = "done";
    $("rxPill").classList.remove("live");
  }

  function stopRx() {
    S.listening = false;
    if (S.uiTimer) { clearInterval(S.uiTimer); S.uiTimer = null; }

    try { if (S.node) S.node.port.onmessage = null; } catch (e) {}
    try { if (S.node) S.node.disconnect(); } catch (e) {}
    try { if (S.proc) { S.proc.disconnect(); S.proc.onaudioprocess = null; } } catch (e) {}
    try { if (S.sink) S.sink.disconnect(); } catch (e) {}
    try { if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}

    S.node = null; S.proc = null; S.sink = null; S.stream = null;
    $("listenBtn").disabled = false;
    $("levelBar").style.width = "0%";
    keepAwake(false);
  }

  function resetRx(keepState) {
    stopRx();
    S.rxs = [];
    $("prog").style.width = "0%";
    $("result").hidden = true;
    $("preview").innerHTML = "";
    $("rxStats").textContent = "—";
    $("rxPill").textContent = "mic off";
    $("rxPill").classList.remove("live");
    if (!keepState) $("rxStatus").textContent = "Mic band hai. Start listening dabao.";
    lastLevel = 0;
  }

  /* ---------------- PWA install ---------------- */
  var deferredPrompt = null;
  var installBtn = $("installBtn");

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener("click", async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  updateEstimate();
})();
