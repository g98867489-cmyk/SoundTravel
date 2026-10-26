/* ============================================================
   SoundTravel — sound ke through data bhejne ka protocol  (v2)
   ------------------------------------------------------------
   v2 me speed ke liye 3 badlav:
     1. Turbo mode — 2.67 ms symbols (pehle sabse tez 5.33 ms tha)
     2. Bada frame — 128 bytes payload (pehle 32) => overhead 18% -> 5%
     3. Transmitter lazy hai — poora symbol array memory me nahi
        banata, isliye badi files bhi aaram se chalti hain.

   Modulation : 16-tone FSK, har symbol 4 bits (ek nibble).
   Frame      : [seqHi][seqLo][len][payload...][crcHi][crcLo]
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.STProto = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TONES = 16;
  var PAYLOAD_MAX = 128;
  var SYNC = [0, 15, 3, 12];
  var PREAMBLE_BLOCKS = 10;

  /* base = spacing * baseK  (orthogonality ke liye zaroori) */
  var MODES = {
    safe:     { dur: 1024 / 48000, baseK: 32, label: "Safe"     },  /* 46.9 Hz spacing */
    balanced: { dur:  512 / 48000, baseK: 16, label: "Balanced" },  /* 93.8 Hz */
    fast:     { dur:  256 / 48000, baseK:  8, label: "Fast"     },  /* 187.5 Hz */
    turbo:    { dur:  128 / 48000, baseK:  3, label: "Turbo"    }   /* 375 Hz */
  };

  function modeInfo(name, sr) {
    var m = MODES[name] || MODES.balanced;
    var spacing = 1 / m.dur;
    return {
      name: MODES[name] ? name : "balanced",
      label: m.label,
      dur: m.dur,
      spacing: spacing,
      base: spacing * m.baseK,
      N: Math.round(sr * m.dur),
      sr: sr,
      tones: TONES
    };
  }

  function freqOf(v, info) { return info.base + v * info.spacing; }

  function crc16(b, start, end) {
    var crc = 0xffff;
    for (var i = start; i < end; i++) {
      crc ^= b[i] << 8;
      for (var k = 0; k < 8; k++) {
        crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff)
                             : ((crc << 1) & 0xffff);
      }
    }
    return crc;
  }

  function frameSymbols(len) { return 4 + 2 * (len + 5); }

  function bytesPerSec(name, sr) {
    var info = modeInfo(name, sr);
    return ((info.sr / info.N) * PAYLOAD_MAX) / frameSymbols(PAYLOAD_MAX);
  }

  function buildFrames(header, data) {
    var json = new TextEncoder().encode(JSON.stringify(header));
    var stream = new Uint8Array(2 + json.length + data.length);
    stream[0] = (json.length >> 8) & 255;
    stream[1] = json.length & 255;
    stream.set(json, 2);
    stream.set(data, 2 + json.length);

    var frames = [];
    for (var i = 0; i < stream.length; i += PAYLOAD_MAX) {
      frames.push(stream.subarray(i, Math.min(i + PAYLOAD_MAX, stream.length)));
    }
    return frames;
  }

  /* ============================================================
     TRANSMITTER  (lazy — ek waqt me ek frame ke symbols)
     ============================================================ */
  function createTransmitter(header, data, modeName, sr) {
    var info = modeInfo(modeName, sr);
    var N = info.N;

    var tables = [];
    for (var v = 0; v < TONES; v++) {
      var w = (2 * Math.PI * freqOf(v, info)) / info.sr;
      var t = new Float32Array(N);
      for (var i = 0; i < N; i++) t[i] = 0.45 * Math.cos(w * i);
      tables.push(t);
    }

    var frames = buildFrames(header, data);
    var totalFrames = frames.length;

    /* symbol list: preamble, phir har frame, phir END x3 */
    var seqPlan = [];
    for (var p = 0; p < PREAMBLE_BLOCKS; p++) seqPlan.push("pre");
    for (var f = 0; f < totalFrames; f++) seqPlan.push(f);
    seqPlan.push("end", "end", "end");

    var planIdx = 0;
    var cur = null, curIdx = 0;

    function frameSymbolsFor(seq) {
      var payload = seq === "end" ? new Uint8Array(0) : frames[seq];
      var idx = seq === "end" ? totalFrames : seq;
      var buf = new Uint8Array(payload.length + 5);
      buf[0] = (idx >> 8) & 255;
      buf[1] = idx & 255;
      buf[2] = payload.length;
      buf.set(payload, 3);
      var c = crc16(buf, 0, payload.length + 3);
      buf[payload.length + 3] = (c >> 8) & 255;
      buf[payload.length + 4] = c & 255;

      var out = [];
      for (var s = 0; s < 4; s++) out.push(SYNC[s]);
      for (var b = 0; b < buf.length; b++) {
        out.push((buf[b] >> 4) & 15);
        out.push(buf[b] & 15);
      }
      return out;
    }

    var preamble = [];
    for (var q = 0; q < 4; q++) preamble.push(SYNC[q]);

    var totalSymbols = PREAMBLE_BLOCKS * 4;
    for (var fi = 0; fi < totalFrames; fi++) totalSymbols += frameSymbols(frames[fi].length);
    totalSymbols += 3 * frameSymbols(0);

    return {
      info: info,
      totalFrames: totalFrames,
      totalSymbols: totalSymbols,
      durationSec: (totalSymbols * N) / info.sr,
      reset: function () { planIdx = 0; cur = null; curIdx = 0; },

      nextChunk: function (maxSamples) {
        var maxSyms = Math.floor(maxSamples / N);
        if (maxSyms < 1) maxSyms = 1;

        var picked = [];
        while (picked.length < maxSyms && planIdx < seqPlan.length) {
          if (!cur) {
            cur = seqPlan[planIdx] === "pre" ? preamble : frameSymbolsFor(seqPlan[planIdx]);
            curIdx = 0;
            planIdx++;
          }
          picked.push(cur[curIdx++]);
          if (curIdx >= cur.length) cur = null;
        }
        if (!picked.length) return null;

        var out = new Float32Array(picked.length * N);
        for (var k = 0; k < picked.length; k++) out.set(tables[picked[k]], k * N);
        return out;
      }
    };
  }

  /* ============================================================
     RECEIVER
     ============================================================ */
  function createReceiver(opts) {
    var sr = opts.sampleRate || 48000;
    var info = modeInfo(opts.mode, sr);
    var N = info.N;
    var NOMINAL = frameSymbols(PAYLOAD_MAX);
    var MAX_SPAN = NOMINAL * N + 4 * N;
    var PH_STEP = Math.max(3, Math.round(N / 32));

    var coeff = [];
    for (var v = 0; v < TONES; v++) {
      coeff.push(2 * Math.cos((2 * Math.PI * freqOf(v, info)) / sr));
    }

    var buf = new Float32Array(1 << 20);
    var len = 0;
    var pos = 0;
    var frameStart = 0;
    var _locked = false;
    var everLocked = false;

    function powerAt(start, tone) {
      var c = coeff[tone];
      var s1 = 0, s2 = 0;
      for (var i = 0; i < N; i++) {
        var s0 = buf[start + i] + c * s1 - s2;
        s2 = s1; s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    }

    function readSymbol(start) {
      var best = -1, bestP = -1, sum = 0;
      for (var t = 0; t < TONES; t++) {
        var pw = powerAt(start, t);
        sum += pw;
        if (pw > bestP) { bestP = pw; best = t; }
      }
      return { v: best, p: bestP, sum: sum };
    }

    /* ---- timing loop ----
       rp   = abhi ka symbol position (float)
       rate = per-symbol drift (samples) — do devices ki clock ka farq
       Har symbol par timing error naap ke rp ko theek karte hain aur
       rate ko dheere-dheere update karte hain. Isse lambe frame me bhi
       boundary nahi chhoot ti. */
    var rate = 0;

    function readAt(st0) {
      var best = null, bestR = -1, bestK = 0;
      for (var k = -1; k <= 1; k++) {
        var st = st0 + k * PH_STEP;
        if (st < 0 || st + N > len) continue;
        var r = readSymbol(st);
        var ratio = r.sum > 0 ? r.p / r.sum : 0;
        if (ratio > bestR) { bestR = ratio; best = r; bestK = k; }
      }
      return { sym: best || { v: -1, p: 0, sum: 0 }, err: bestK * PH_STEP };
    }

    function track(err, rpRef) {
      rate += err * 0.01;
      var dmax = N * 0.01;
      if (rate > dmax) rate = dmax;
      if (rate < -dmax) rate = -dmax;
      return rpRef + err * 0.5 + N + rate;
    }

    function syncScore(start) {
      if (start < 0 || start + 4 * N > len) return -1;
      var worst = 1;
      for (var k = 0; k < 4; k++) {
        var s = start + k * N;
        var want = powerAt(s, SYNC[k]);
        var other = powerAt(s, SYNC[(k + 1) % 4]);
        var r = want / (want + other + 1e-12);
        if (r < worst) worst = r;
      }
      return worst;
    }

    function findSync(from, to, coarseStep) {
      var bestS = -1, bestScore = 0.75;
      for (var s = from; s <= to; s += coarseStep) {
        var sc = syncScore(s);
        if (sc > bestScore) { bestScore = sc; bestS = s; }
      }
      if (bestS < 0) return { pos: -1, score: 0 };

      var lo = Math.max(0, bestS - coarseStep);
      var hi = Math.min(len - 4 * N, bestS + coarseStep);
      for (var f = lo; f <= hi; f += Math.max(2, Math.round(coarseStep / 6))) {
        var sc2 = syncScore(f);
        if (sc2 > bestScore) { bestScore = sc2; bestS = f; }
      }
      return { pos: bestS, score: bestScore };
    }

    function decodeAt(start) {
      if (start + 4 * N > len) return { need: true };

      for (var k = 0; k < 4; k++) {
        if (readSymbol(start + k * N).v !== SYNC[k]) return null;
      }

      var rp = start + 4 * N;
      var nib = [];
      var i, res, st0;

      for (i = 0; i < 6; i++) {
        st0 = Math.round(rp);
        if (st0 + N + PH_STEP > len) return { need: true };
        res = readAt(st0);
        nib.push(res.sym.v);
        rp = track(res.err, rp);
      }

      var seq = (nib[0] << 12) | (nib[1] << 8) | (nib[2] << 4) | nib[3];
      var plen = (nib[4] << 4) | nib[5];
      if (plen > PAYLOAD_MAX) return null;

      var totalNib = 2 * (plen + 5);
      for (i = 6; i < totalNib; i++) {
        st0 = Math.round(rp);
        if (st0 + N + PH_STEP > len) return { need: true };
        res = readAt(st0);
        nib.push(res.sym.v);
        rp = track(res.err, rp);
      }

      var bytes = new Uint8Array(plen + 5);
      for (var bi = 0; bi < bytes.length; bi++) {
        bytes[bi] = (nib[bi * 2] << 4) | nib[bi * 2 + 1];
      }

      var crc = crc16(bytes, 0, plen + 3);
      var got = (bytes[plen + 3] << 8) | bytes[plen + 4];
      if (crc !== got) return null;

      return {
        seq: seq,
        len: plen,
        payload: bytes.subarray(3, 3 + plen),
        symbols: frameSymbols(plen),
        nextPos: Math.round(rp)
      };
    }

    var parts = new Map();
    var totalFrames = -1;
    var finished = false;
    var stats = { frames: 0, bad: 0 };

    function ensure(cap) {
      if (len < 0) len = 0;
      if (cap <= buf.length) return;
      var nb = new Float32Array(Math.max(cap, buf.length * 2));
      nb.set(buf.subarray(0, len));
      buf = nb;
    }

    function compact() {
      if (pos > len) pos = len;
      if (pos < 48000) return;
      var shift = pos;
      buf.copyWithin(0, shift, len);
      len -= shift;
      frameStart -= shift;
      if (frameStart < 0) frameStart = 0;
      pos = 0;
    }

    function tryAssemble() {
      if (finished || totalFrames < 0) return null;
      var chunks = [], size = 0, i;
      for (i = 0; i < totalFrames; i++) {
        var pt = parts.get(i);
        if (!pt) return null;
        chunks.push(pt);
        size += pt.length;
      }
      var all = new Uint8Array(size), off = 0;
      for (i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
      var hlen = (all[0] << 8) | all[1];
      var header = JSON.parse(new TextDecoder().decode(all.subarray(2, 2 + hlen)));
      finished = true;
      return { header: header, data: all.subarray(2 + hlen) };
    }

    function handleFrame(fr) {
      if (fr.len === 0) {
        if (totalFrames < 0) totalFrames = fr.seq;
        return;
      }
      if (!parts.has(fr.seq)) { parts.set(fr.seq, fr.payload); stats.frames++; }
    }

    function step() {
      if (finished) return;

      if (!_locked) {
        /* sirf recent audio me sync dhoondo — poora buffer scan karna
           bahut mehnga padta hai. Sender loop me bhejta hai, to
           kuch second me hi mil jayega. */
        var window = Math.max(Math.round(2 * sr), Math.round(1.5 * NOMINAL * N));
        var from = Math.max(pos, len - window);
        var to = len - 4 * N;
        if (to < from) return;
        var limit = everLocked ? Math.min(to, from + 6 * NOMINAL * N) : to;
        var r = findSync(from, limit, Math.max(2, N >> 2));
        if (r.pos < 0) {
          pos = Math.max(pos, limit - 4 * N);
          return;
        }
        frameStart = r.pos;
        everLocked = true;
        _locked = true;
        if (opts.onLock) opts.onLock();
      } else {
        /* locked hain — phir bhi thoda local sync check karo, taaki
           clock drift se boundary na chhoote */
        var lo = Math.max(pos, frameStart - Math.round(N / 2));
        var hi = Math.min(len - 4 * N, frameStart + Math.round(N / 2));
        if (hi > lo) {
          var rr = findSync(lo, hi, Math.max(2, Math.round(N / 8)));
          if (rr.pos >= 0) frameStart = rr.pos;
        }
      }

      /* poore frame ka data aane ka intezaar karo. Warna har naye
         block par decode shuru se chalta hai aur cost quadratic ho jati hai. */
      if (len - frameStart < MAX_SPAN) return;

      var fr = decodeAt(frameStart);
      if (fr && fr.need) return;

      if (fr) {
        handleFrame(fr);
        pos = fr.nextPos;
        frameStart = pos;
        var res = tryAssemble();
        if (res && opts.onComplete) opts.onComplete(res);
      } else {
        stats.bad++;
        pos = frameStart + N;
        frameStart = pos;
        _locked = false;
      }
      compact();
    }

    return {
      info: info,
      push: function (samples) {
        if (finished) return;
        ensure(len + samples.length);
        buf.set(samples, len);
        len += samples.length;

        var guard = 0;
        while (guard++ < 600 && !finished) {
          var before = pos + "|" + len + "|" + frameStart;
          step();
          if (before === pos + "|" + len + "|" + frameStart) break;
        }
      },
      progress: function () {
        return {
          have: parts.size,
          total: totalFrames,
          bytes: parts.size * PAYLOAD_MAX,
          bad: stats.bad,
          finished: finished
        };
      },
      result: tryAssemble,
      reset: function () {
        len = 0; pos = 0; frameStart = 0; _locked = false; everLocked = false;
        parts = new Map(); totalFrames = -1; finished = false;
        stats = { frames: 0, bad: 0 };
      }
    };
  }

  return {
    TONES: TONES,
    PAYLOAD_MAX: PAYLOAD_MAX,
    SYNC: SYNC,
    MODES: MODES,
    modeInfo: modeInfo,
    freqOf: freqOf,
    crc16: crc16,
    frameSymbols: frameSymbols,
    bytesPerSec: bytesPerSec,
    createTransmitter: createTransmitter,
    createReceiver: createReceiver
  };
});
