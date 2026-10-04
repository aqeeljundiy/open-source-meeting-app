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
