// Platform-specific steps. Meet and Zoom change their UI often, so every step
// tries several selectors / labels and the bot logs what it did. When a join
// breaks, this file is where to look.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Click the first visible button whose accessible name matches one of the patterns.
export async function clickButton(scope, patterns, { timeout = 0 } = {}) {
  const until = Date.now() + timeout;
  do {
    for (const name of patterns) {
      const loc = scope.getByRole('button', { name }).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
    if (timeout) await sleep(500);
  } while (Date.now() < until);
  return false;
}

// Google Meet rejects guests that type and click like a script (instant fill, no mouse
// movement). These move the mouse and type with human-ish timing.
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
export async function humanClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return locator.click();
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.35 + Math.random() * 0.3);
  await page.mouse.move(x - 80 - Math.random() * 120, y + 40 + Math.random() * 80, { steps: 8 });
  await jitter(120, 350);
  await page.mouse.move(x, y, { steps: 15 + Math.floor(Math.random() * 10) });
  await jitter(80, 250);
  await page.mouse.down();
  await jitter(40, 130);
  await page.mouse.up();
}
export async function humanType(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await jitter(70, 180);
  }
}

// Meet's device / permission pop-ups. Several can stack, so keep clicking until none are left.
const MEET_DIALOGS = [
  /^Continue without microphone and camera$/i,
  /^Continue without microphone$/i,
  /^Continue without camera$/i,
  /^Use without microphone$/i,
  /^Got it$/i,
  /^Dismiss$/i,
  /^Reject all$/i,
  /^Not now$/i,
];
async function dismissMeetDialogs(page, log) {
  for (let i = 0; i < 5; i++) {
    let clicked = false;
    for (const name of MEET_DIALOGS) {
      const b = page.getByRole('button', { name }).first();
      if (await b.isVisible().catch(() => false)) {
        const label = (await b.innerText().catch(() => '')) || String(name);
        await jitter(300, 700);
        await humanClick(page, b);
        log?.(`Closed pop-up: ${label.trim()}`);
        clicked = true;
        await sleep(800);
        break;
      }
    }
    if (!clicked) return;
  }
}

async function bodyText(page) {
  const texts = await Promise.all(page.frames().map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')));
  return texts.join('\n');
}

// ---------- Google Meet ----------
export const meet = {
  name: 'Google Meet',
  captionSelectors: [
    '[role="region"][aria-label*="aption" i]',
    '[jsname="dsyhDe"]',
    '.a4cQT',
  ],

  // Force English UI: the server's location (e.g. Germany) would otherwise localize every button.
  joinUrl(url) {
    const u = new URL(url);
    u.searchParams.set('hl', 'en');
    return u.toString();
  },

  async prejoin(page, botName, log) {
    await page.waitForLoadState('domcontentloaded');
    // The bot has no camera (and on servers only a virtual mic), so Meet pops up device
    // questions that cover the page and steal keyboard focus. Clear them first.
    await sleep(2500);
    await dismissMeetDialogs(page, log);

    const nameInput = page.locator('input[aria-label="Your name"], input[placeholder="Your name"], input[type="text"]').first();
    // Either the name box shows up, or Meet tells us we can't join.
    const until = Date.now() + 30000;
    while (!(await nameInput.isVisible().catch(() => false))) {
      if ((await meet.state(page)) === 'denied') {
        throw new Error("Google Meet says \"You can't join this video call\" (wrong link, the meeting ended, or guests are blocked)");
      }
      // Already signed in / instant join: skip straight past the name step.
      if (await page.getByRole('button', { name: /^(Ask to join|Join now)( without .+)?$/i }).first().isVisible().catch(() => false)) break;
      if (Date.now() > until) throw new Error('Google Meet join screen never appeared');
      await sleep(1000);
    }
    // Type the name; if a pop-up interrupted it, clear the pop-up and try again.
    for (let attempt = 0; attempt < 3 && (await nameInput.isVisible().catch(() => false)); attempt++) {
      await dismissMeetDialogs(page, log);
      await jitter(600, 1400);
      await humanClick(page, nameInput);
      await jitter(300, 800);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await humanType(page, botName);
      await jitter(400, 900);
      if ((await nameInput.inputValue().catch(() => '')) === botName) { log(`Entered name "${botName}"`); break; }
      log('Name did not stick (a pop-up got in the way), retrying');
    }
    await dismissMeetDialogs(page, log);
    await jitter(1000, 2200);
    // Wording varies with the devices: "Ask to join without camera", "Join now without microphone"...
    const join = page.getByRole('button', { name: /^(Ask to join|Join now|Join anyway|Switch here)( without .+)?$/i }).first();
    await join.waitFor({ timeout: 15000 }).catch(() => { throw new Error('Could not find the "Ask to join" button'); });
    await humanClick(page, join);
    log('Asked to join');
  },

  async state(page) {
    const t = await bodyText(page);
    // The waiting room also has a "Leave call" button, so check its text first.
    if (/Asking to be let in|Please wait until a meeting host|someone in the meeting lets you in|You.ll join the call when/i.test(t)) return 'waiting';
    if (await page.getByRole('button', { name: /Leave call/i }).first().isVisible().catch(() => false)) return 'in_call';
    if (/denied your request|can't join this call|You can.t join this video call|meeting code has expired|Check your meeting code/i.test(t)) return 'denied';
    if (/You left the meeting|been removed from the meeting|call has ended|The meeting has ended|Return to home screen/i.test(t)) return 'ended';
    if (/Asking to be let in|Please wait until a meeting host|someone in the meeting lets you in|You.ll join the call when/i.test(t)) return 'waiting';
    return 'unknown';
  },

  async afterJoin(page, log) {
    // Captions on: the toolbar button, else the "c" keyboard shortcut.
    const on = await clickButton(page, [/Turn on captions/i], { timeout: 8000 });
    if (!on) await page.keyboard.press('c');
    log(on ? 'Captions turned on' : 'Captions toggled with keyboard shortcut');
  },

  async announce(page, message, log) {
    try {
      await clickButton(page, [/Chat with everyone/i, /^Chat$/i], { timeout: 5000 });
      const box = page.locator('textarea[aria-label*="message" i], textarea').first();
      await box.waitFor({ timeout: 5000 });
      await box.fill(message);
      await box.press('Enter');
      await clickButton(page, [/Chat with everyone/i, /Close/i]);
      log('Posted recording notice in chat');
    } catch {
      log('Could not post the recording notice in chat');
    }
  },

  async participants(page) {
    const label = await page.locator('[aria-label*="participant" i], [aria-label^="People" i]').first()
      .getAttribute('aria-label').catch(() => null);
    const n = label?.match(/(\d+)/);
    return n ? Number(n[1]) : null;
  },

  async leave(page) {
    await clickButton(page, [/Leave call/i]);
  },
};

// ---------- Zoom (web client, no SDK) ----------
export const zoom = {
  name: 'Zoom',
  captionSelectors: [
    '#live-transcription-subtitle',
    '.live-transcription-subtitle__box',
    '[class*="live-transcription-subtitle"]',
    '[class*="caption-container" i]',
    '[aria-label*="caption" i][role="log"]',
  ],

  // zoom.us/j/123?pwd=x  ->  app.zoom.us/wc/123/join?pwd=x  (skips "open the app" page)
  joinUrl(url) {
    const u = new URL(url);
    const id = u.pathname.match(/\/(?:j|s|wc(?:\/join)?|my)\/([^/?#]+)/)?.[1];
    if (!id) return url;
    const out = new URL(`https://app.zoom.us/wc/${id}/join`);
    const pwd = u.searchParams.get('pwd');
    if (pwd) out.searchParams.set('pwd', pwd);
    out.searchParams.set('lang', 'en-US');
    return out.toString();
  },

  async prejoin(page, botName, log) {
    await page.waitForLoadState('domcontentloaded');
    await clickButton(page, [/Reject All/i, /Accept Cookies/i], { timeout: 4000 });
    // Older layout still shows a "Join from your browser" link.
    const browserLink = page.getByRole('link', { name: /Join from (your|Your) browser/i });
    if (await browserLink.isVisible().catch(() => false)) await browserLink.click();

    const frame = await zoomFrame(page);
    const nameInput = frame.locator('#input-for-name, input[placeholder*="name" i], input[aria-label*="name" i]').first();
    const until = Date.now() + 45000;
    while (!(await nameInput.isVisible().catch(() => false))) {
      const t = await bodyText(page);
      const bad = t.match(/This meeting link is invalid[^\n]*|Invalid meeting ID[^\n]*|meeting ID is not valid[^\n]*|Passcode wrong[^\n]*/i);
      if (bad) throw new Error(`Zoom says: ${bad[0].trim()}`);
      if (Date.now() > until) throw new Error('Zoom join screen never appeared');
      await sleep(1000);
    }
    await nameInput.fill(botName);
    log(`Entered name "${botName}"`);

    // Zoom's preview puts mic/camera toggles here when it has permission.
    await clickButton(frame, [/^Mute$/i, /Stop Video/i]);

    if (!(await clickButton(frame, [/^Join$/i], { timeout: 10000 }))) throw new Error('Could not find the Zoom "Join" button');
    log('Clicked Join');
    // Terms / recording-consent dialogs Zoom shows to guests.
    await clickButton(frame, [/^I Agree$/i, /^Agree$/i, /^Got it$/i, /^Continue$/i], { timeout: 5000 });
  },

  async state(page) {
    const t = await bodyText(page);
    if (/meeting has been ended|This meeting has ended|been removed|host has ended/i.test(t)) return 'ended';
    if (/Passcode wrong|Invalid meeting ID|meeting link is invalid|meeting ID is not valid|not allowed to join|Unable to join/i.test(t)) return 'denied';
    if (/waiting room|host will let you in soon|Please wait, the meeting host|meeting has not started|Waiting for the host/i.test(t)) return 'waiting';
    const frame = await zoomFrame(page);
    if (await frame.getByRole('button', { name: /^Leave$/i }).first().isVisible().catch(() => false)) return 'in_call';
    return 'unknown';
  },

  async afterJoin(page, log) {
    const frame = await zoomFrame(page);
    // Meeting audio has to be joined or nothing is heard (and nothing is recorded).
    if (await clickButton(frame, [/Join Audio by Computer/i, /Join with Computer Audio/i, /^Join Audio$/i], { timeout: 10000 })) log('Joined computer audio');
    await clickButton(frame, [/^Mute$/i]);
    // Captions: the CC button (host must allow captions in the meeting).
    let on = await clickButton(frame, [/^Show Captions$/i, /^Captions$/i, /^CC$/i, /closed caption/i], { timeout: 6000 });
    if (on) await clickButton(frame, [/Show Captions/i, /^Show subtitle$/i], { timeout: 3000 });
    if (!on) {
      // CC often hides under "More".
      if (await clickButton(frame, [/^More$/i, /More meeting control/i])) {
        on = await clickButton(frame, [/Captions/i, /Show Captions/i], { timeout: 3000 });
      }
    }
    log(on ? 'Captions turned on' : 'Captions button not found (host may have captions disabled)');
  },

  async announce(page, message, log) {
    try {
      const frame = await zoomFrame(page);
      if (!(await clickButton(frame, [/^Chat$/i, /open the chat panel/i], { timeout: 4000 }))) throw new Error();
      const box = frame.locator('[contenteditable="true"], textarea').last();
      await box.waitFor({ timeout: 5000 });
      await box.click();
      await page.keyboard.type(message);
      await page.keyboard.press('Enter');
      await clickButton(frame, [/^Chat$/i, /close/i]);
      log('Posted recording notice in chat');
    } catch {
      log('Could not post the recording notice in chat');
    }
  },

  async participants(page) {
    const frame = await zoomFrame(page);
    const label = await frame.locator('[aria-label*="participant" i]').first().innerText().catch(() => '');
    const n = label.match(/(\d+)/);
    return n ? Number(n[1]) : null;
  },

  async leave(page) {
    const frame = await zoomFrame(page);
    await clickButton(frame, [/^Leave$/i]);
    await clickButton(frame, [/^Leave Meeting$/i], { timeout: 3000 });
  },
};

// The older Zoom web client lives in an iframe; the newer one is top-level.
async function zoomFrame(page) {
  const iframe = page.frames().find((f) => /\/wc\/|webclient/i.test(f.url()) && f !== page.mainFrame());
  return iframe || page;
}

export const platforms = { meet, zoom };
