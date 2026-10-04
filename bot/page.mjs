// Code that runs inside the meeting tab: the recorder and the caption scraper.
// Both talk back to Node through functions exposed with page.exposeFunction.

// Records the tab itself (video + meeting audio) with getDisplayMedia + MediaRecorder.
// Chrome runs with --auto-accept-this-tab-capture so the share picker never appears.
// getDisplayMedia needs a user gesture, so we add a tiny button and Playwright clicks it.
export async function startRecorder(page) {
  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = '__mb_rec';
    btn.textContent = 'rec';
    btn.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.01;z-index:2147483647';
    btn.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 15, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { suppressLocalAudioPlayback: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
        });
        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          .find((m) => MediaRecorder.isTypeSupported(m));
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
        let queue = Promise.resolve();
        rec.ondataavailable = (e) => {
          if (!e.data.size) return;
          queue = queue.then(async () => {
            const buf = new Uint8Array(await e.data.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            await window.__mbChunk(btoa(bin));
          });
        };
        rec.onstop = () => queue.then(() => window.__mbRecStopped());
        rec.start(5000);
        window.__mbRecorder = rec;
        window.__mbRecState('recording', `video ${mime}, audio tracks: ${stream.getAudioTracks().length}`);
        window.__mbRecOk = true;
      } catch (err) {
        window.__mbRecState('error', String(err));
        window.__mbRecOk = false;
      }
    };
    document.body.appendChild(btn);
  });
  // getDisplayMedia needs the tab focused and a real click (InvalidStateError otherwise).
  await page.bringToFront();
  await page.evaluate(() => window.focus());
  const box = await page.locator('#__mb_rec').boundingBox();
  await page.mouse.click(box.x + 2, box.y + 2);
  await page.waitForFunction(() => window.__mbRecOk !== undefined, null, { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => window.__mbRecOk === true);
}

export async function stopRecorder(page) {
  await page.evaluate(() => {
    const rec = window.__mbRecorder;
    if (rec && rec.state !== 'inactive') rec.stop();
    else window.__mbRecStopped?.();
  }).catch(() => {});
}

// Captions: every second, report the caption blocks currently on screen as
// [{ id, speaker, text }]. Ids stay stable per DOM node so Node can tell when a
// block is still growing vs finished. `selectors` is a list of caption-container
// CSS selectors for the platform (first match wins).
export function captionSnapshot(selectors) {
  const container = selectors.map((s) => document.querySelector(s)).find(Boolean);
  if (!container) return null;
  window.__mbSeq = window.__mbSeq || 0;
  const leaves = (el) => {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); return; }
      if (n.nodeType !== 1) return;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (n.matches('button,[role=button],svg,i,.google-symbols,.material-icons')) return;
      n.childNodes.forEach(walk);
    };
    walk(el);
    return out;
  };
  // A caption block is the smallest element that has a speaker (avatar image or
  // a separate short name element) plus text. Fall back to direct children.
  let blocks = [...container.querySelectorAll('img')].map((img) => {
    let b = img.parentElement;
    while (b && b !== container && leaves(b).length < 2) b = b.parentElement;
    return b && b !== container ? b : null;
  }).filter(Boolean);
  blocks = [...new Set(blocks)];
  if (!blocks.length) blocks = [...container.children];
  return blocks.map((b) => {
    if (!b.dataset.mbId) b.dataset.mbId = String(++window.__mbSeq);
    const parts = leaves(b);
    const hasName = parts.length > 1 && parts[0].length <= 40;
    return {
      id: b.dataset.mbId,
      speaker: hasName ? parts[0] : null,
      text: (hasName ? parts.slice(1) : parts).join(' ').replace(/\s+/g, ' ').trim(),
    };
  }).filter((b) => b.text);
}

// Turns 1-second snapshots into finished utterances.
// A block is committed when it disappears or stops changing for `idleMs`;
// if it keeps growing after a commit, only the new tail is committed later.
export class CaptionAssembler {
  constructor(onUtterance, idleMs = 4000) {
    this.blocks = new Map();
    this.onUtterance = onUtterance;
    this.idleMs = idleMs;
  }

  push(snapshot, now) {
    const seen = new Set();
    for (const { id, speaker, text } of snapshot || []) {
      seen.add(id);
      const b = this.blocks.get(id);
      if (!b) this.blocks.set(id, { speaker, text, committed: '', changedAt: now, firstAt: now, tailAt: now });
      else if (b.text !== text) {
        b.text = text;
        b.changedAt = now;
        if (b.committed && b.tailAt == null) b.tailAt = now;
        if (speaker) b.speaker = speaker;
      }
    }
    for (const [id, b] of this.blocks) {
      const gone = !seen.has(id);
      if (gone || now - b.changedAt >= this.idleMs) this.commit(b);
      if (gone) this.blocks.delete(id);
    }
  }

  commit(b) {
    if (b.text === b.committed) return;
    // Captions sometimes rewrite earlier words; if the committed prefix no longer
    // matches, commit the whole current text rather than a garbled tail.
    const tail = b.text.startsWith(b.committed) ? b.text.slice(b.committed.length).trim() : b.text;
    if (tail) this.onUtterance(b.speaker, tail, b.committed ? (b.tailAt ?? b.changedAt) : b.firstAt);
    b.committed = b.text;
    b.tailAt = null;
  }

  flush() {
    for (const b of this.blocks.values()) this.commit(b);
    this.blocks.clear();
  }
}

// ---------- audio-only fallback ----------
// Runs before the meeting page loads: remember every incoming audio track from
// WebRTC. Needs no focus and no permission, and is much lighter than video.
export function hookAudioTracks() {
  const Orig = window.RTCPeerConnection;
  if (!Orig || Orig.__mb) return;
  window.__mbTracks = [];
  const Patched = function (...args) {
    const pc = new Orig(...args);
    pc.addEventListener('track', (e) => {
      if (e.track.kind !== 'audio') return;
      window.__mbTracks.push(e.track);
      window.__mbOnTrack?.(e.track);
    });
    return pc;
  };
  Patched.prototype = Orig.prototype;
  Object.setPrototypeOf(Patched, Orig);
  Patched.toString = () => Orig.toString();
  Patched.__mb = true;
  window.RTCPeerConnection = Patched;
}

// Mix all meeting audio tracks (including ones that arrive later) into one recording.
export async function startAudioRecorder(page) {
  return page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    const sinks = [];
    const add = (track) => {
      try {
        const stream = new MediaStream([track]);
        // Chrome only feeds remote WebRTC audio into Web Audio if the stream is
        // also playing in a media element (muted is fine).
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        sinks.push(el);
        ctx.createMediaStreamSource(stream).connect(dest);
      } catch {}
    };
    (window.__mbTracks || []).forEach(add);
    window.__mbOnTrack = add;
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    let queue = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      queue = queue.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        await window.__mbChunk(btoa(bin));
      });
    };
    rec.onstop = () => queue.then(() => window.__mbRecStopped());
    rec.start(5000);
    window.__mbRecorder = rec;
    return (window.__mbTracks || []).length;
  });
}

// ---------- tab audio ----------
// The meeting's audio exactly as it plays in this tab (getDisplayMedia, auto-accepted by
// --auto-accept-this-tab-capture). Needs a user gesture + window focus: true on servers
// (kiosk window), often false on desktops; the recorder then falls back to WebRTC mixing.
export async function grabTabAudio(page) {
  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = '__mb_aud';
    btn.textContent = 'a';
    btn.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.01;z-index:2147483647';
    btn.onclick = async () => {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { suppressLocalAudioPlayback: false }, preferCurrentTab: true, selfBrowserSurface: 'include' });
        s.getVideoTracks().forEach((t) => t.stop());   // video comes from our own canvas
        window.__mbTabAudio = s.getAudioTracks()[0] || null;
      } catch { window.__mbTabAudio = null; }
      window.__mbTabAudioDone = true;
      btn.remove();
    };
    document.body.appendChild(btn);
  });
  await page.bringToFront().catch(() => {});
  const box = await page.locator('#__mb_aud').boundingBox().catch(() => null);
  if (box) await page.mouse.click(box.x + 2, box.y + 2);
  await page.waitForFunction(() => window.__mbTabAudioDone, null, { timeout: 8000 }).catch(() => {});
  return page.evaluate(() => Boolean(window.__mbTabAudio));
}

// How loud the recorded audio is (RMS 0..1) over `ms`; ~0 means silent.
export async function audioLevel(page, ms = 4000) {
  return page.evaluate(async (ms) => {
    const an = window.__mbAnalyser;
    if (!an) return null;
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
      await new Promise((r) => setTimeout(r, 100));
    }
    return peak;
  }, ms);
}

// ---------- composite recorder (default) ----------
// Builds the video ourselves from the call's own <video> feeds: the biggest one on screen
// (active speaker or screen share, as Meet/Zoom size it) fills the frame, others go in a strip.
// Meet's toolbar, pop-ups and captions never appear. Needs no window focus, so it works on
// desktops too. Audio = every remote WebRTC track mixed (see hookAudioTracks).
export async function startCompositeRecorder(page, { video = true } = {}) {
  return page.evaluate(async (withVideo) => {
    // 'playback' = larger audio buffers: survives CPU spikes without crackles or gaps.
    const ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
    await ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    const add = (track) => {
      try {
        const s = new MediaStream([track]);
        const el = new Audio(); el.muted = true; el.srcObject = s; el.play().catch(() => {});   // Chrome needs a sink to feed Web Audio
        (window.__mbSinks ||= []).push(el);
        ctx.createMediaStreamSource(s).connect(dest);
      } catch {}
    };
    if (window.__mbTabAudio) {
      // Best source: the tab's real audio output.
      ctx.createMediaStreamSource(new MediaStream([window.__mbTabAudio])).connect(dest);
    } else {
      (window.__mbTracks || []).forEach(add);
      window.__mbOnTrack = add;
    }
    window.__mbAnalyser = ctx.createAnalyser();
    window.__mbAnalyser.fftSize = 2048;
    ctx.createMediaStreamSource(dest.stream).connect(window.__mbAnalyser);

    let stream = dest.stream;
    if (withVideo) {
      const W = 1280, H = 720, PAD = 14;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      const nameFor = (v) => {
        const tile = v.closest('[data-participant-id],[data-requested-participant-id],[data-self-name]');
        const lines = (tile?.innerText || '').split('\n').map((s) => s.trim())
          .filter((s) => s && s.length < 40 && !/^(more_vert|mic|mic_off|keep|push_pin|visual_effects|frame_person|close|[a-z_]+)$/.test(s));
        return lines[0] || '';
      };
      const drawVideo = (v, a, mode) => {
        const vr = v.videoWidth / v.videoHeight, ar = a.w / a.h;
        let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0, dx = a.x, dy = a.y, dw = a.w, dh = a.h;
        if (mode === 'cover') { if (vr > ar) { sw = sh * ar; sx = (v.videoWidth - sw) / 2; } else { sh = sw / ar; sy = (v.videoHeight - sh) / 2; } }
        else if (vr > ar) { dh = a.w / vr; dy = a.y + (a.h - dh) / 2; } else { dw = a.h * vr; dx = a.x + (a.w - dw) / 2; }
        x.save(); x.beginPath(); x.roundRect(a.x, a.y, a.w, a.h, 12); x.clip();
        x.fillStyle = '#161616'; x.fillRect(a.x, a.y, a.w, a.h);
        x.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
        x.restore();
      };
      const label = (text, a) => {
        if (!text) return;
        x.font = '600 15px system-ui, sans-serif';
        const w = x.measureText(text).width + 18;
        x.fillStyle = 'rgba(0,0,0,.6)'; x.beginPath(); x.roundRect(a.x + 10, a.y + a.h - 34, w, 24, 12); x.fill();
        x.fillStyle = '#fff'; x.fillText(text, a.x + 19, a.y + a.h - 17);
      };
      const draw = () => {
        x.fillStyle = '#0d0d0d'; x.fillRect(0, 0, W, H);
        const vids = [...document.querySelectorAll('video')]
          .filter((v) => v.videoWidth > 0 && v.readyState >= 2)
          .map((v) => ({ v, r: v.getBoundingClientRect() }))
          .filter((o) => o.r.width > 40 && o.r.height > 30)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        if (!vids.length) {
          x.fillStyle = '#8f8f88'; x.font = '500 22px system-ui, sans-serif'; x.textAlign = 'center';
          x.fillText('No cameras on (audio is still recorded)', W / 2, H / 2); x.textAlign = 'left';
          return;
        }
        const [main, ...rest] = vids;
        const strip = rest.slice(0, 5);
        const mainA = strip.length ? { x: PAD, y: PAD, w: W - PAD * 2, h: H - PAD * 3 - 120 } : { x: PAD, y: PAD, w: W - PAD * 2, h: H - PAD * 2 };
        drawVideo(main.v, mainA, 'contain');
        label(nameFor(main.v), mainA);
        if (strip.length) {
          const tw = Math.min(214, (W - PAD * (strip.length + 1)) / strip.length), th = 120;
          strip.forEach((o, i) => {
            const a = { x: PAD + i * (tw + PAD), y: H - PAD - th, w: tw, h: th };
            drawVideo(o.v, a, 'cover');
            label(nameFor(o.v), a);
          });
        }
      };
      // Timers (not requestAnimationFrame): keep drawing even if the window is covered.
      window.__mbDraw = setInterval(draw, 1000 / 20);
      draw();
      stream = new MediaStream([...c.captureStream(20).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }

    const mime = withVideo
      // VP8 first: VP9 costs 2-4x more CPU to encode live, which made recordings stutter on a busy server.
      ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
      : 'audio/webm;codecs=opus';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
    let queue = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      queue = queue.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        await window.__mbChunk(btoa(bin));
      });
    };
    rec.onstop = () => { clearInterval(window.__mbDraw); queue.then(() => window.__mbRecStopped()); };
    rec.start(5000);
    window.__mbRecorder = rec;
    return { mime, audioTracks: (window.__mbTracks || []).length, tabAudio: Boolean(window.__mbTabAudio), ctxState: ctx.state };
  }, video);
}
