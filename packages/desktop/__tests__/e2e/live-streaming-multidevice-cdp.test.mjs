/**
 * Real Live-Gateway Multi-Device & Long-Running Streaming E2E (Desktop + Mobile CDP)
 *
 * Verifies against the live Hermes Gateway (via `--env-file=D:/workspace/hermes-aura/.env`):
 *   1. Desktop (1280x800) -> Mobile (390x844 ?shell=mobile) live turn & user-prompt synchronization;
 *   2. Mobile -> Desktop follow-up live turn & user-prompt synchronization;
 *   3. Long-running (>65s silent tool) streaming continuity across the 60s watchdog boundary
 *      plus mid-turn session switch out & re-entry without dropping live streaming;
 *   4. Deterministic CDP screenshot evidence & zero fatal browser runtime errors.
 *
 * Isolates all mutations to two dedicated temporary Scratchpad sessions created and deleted
 * exclusively by this test; never reads/modifies/deletes pre-existing sessions, rooms, or bots.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchLiveApp } from './browser-harness.mjs';
import {
  fetchTicket,
  httpProxy,
  liveGatewayBase,
  liveGatewayEnvReady,
  login,
  normalizeSessions,
} from './live-gateway-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '../../../..');
const ARTIFACT_DIR = path.join(ROOT_DIR, 'artifacts', 'verification', 'live-streaming-multidevice');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a Gateway JSON-RPC WebSocket client and wait until `'open'` completes. */
async function openControlWs(ticket) {
  const wsBase = liveGatewayBase().replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/api/ws${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`;
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('control ws connect timeout')), 10_000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('control ws error'));
      },
      { once: true },
    );
    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.id !== undefined && pending.has(frame.id)) {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) {
          entry.reject(Object.assign(new Error(frame.error.message || 'rpc error'), frame.error));
        } else {
          entry.resolve(frame.result);
        }
        return;
      }
      if (frame.method === 'event' && frame.params && typeof frame.params === 'object') {
        for (const fn of listeners) fn(frame.params);
      }
    });
  });

  return {
    call(method, params = {}, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error(`control ws not open (${ws.readyState})`));
          return;
        }
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${method} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    waitForEvent(predicate, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(onEvent);
          reject(new Error(`waitForEvent timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onEvent = (evt) => {
          if (predicate(evt)) {
            clearTimeout(timer);
            listeners.delete(onEvent);
            resolve(evt);
          }
        };
        listeners.add(onEvent);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore close errors */
      }
    },
  };
}

/**
 * Create a Scratchpad session and persist one quick turn so `/api/sessions`
 * and `session.list` expose it immediately on Desktop and Mobile cold boot.
 */
async function createAndSeedTempSession(ws, title) {
  const created = await ws.call('session.create', { profile: 'default', title });
  const storedId = created?.stored_session_id || created?.id || created?.session_id;
  const liveId = created?.session_id || created?.live_id || storedId;
  assert.ok(storedId, `storedId must be returned for ${title}`);
  const completePromise = ws.waitForEvent(
    (evt) => (evt.type === 'message.complete' || evt.type === 'error') && (!evt.session_id || evt.session_id === liveId),
    35_000,
  );
  await ws.call('prompt.submit', {
    session_id: liveId,
    text: 'Reply with READY and nothing else.',
  });
  const doneEvt = await completePromise;
  assert.notEqual(doneEvt?.type, 'error', `Seed turn failed for ${title}`);
  try {
    await ws.call('session.close', { session_id: liveId });
  } catch {
    /* ignore close error if already released */
  }
  return storedId;
}

/** Interrupt, close live handle, and delete a temporary Scratchpad session by stored ID. */
async function deleteTempSession(ws, cookie, storedId) {
  if (!storedId) return;
  let liveId = null;
  try {
    const resumed = await ws.call('session.resume', {
      session_id: storedId,
      profile: 'default',
      omit_messages: true,
    });
    liveId = resumed?.session_id || resumed?.live_id || null;
  } catch {
    /* session may already be gone */
  }
  for (const id of [...new Set([liveId, storedId].filter(Boolean))]) {
    try {
      await ws.call('session.interrupt', { session_id: id });
    } catch {
      /* ignore if idle */
    }
    try {
      await ws.call('session.close', { session_id: id });
    } catch {
      /* ignore if already closed */
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await ws.call('session.delete', { session_id: storedId, profile: 'default' });
      return;
    } catch {
      try {
        await httpProxy(cookie, {
          method: 'DELETE',
          path: `/api/sessions/${encodeURIComponent(storedId)}`,
          params: { profile: 'default' },
        });
        return;
      } catch {
        await sleep(400);
      }
    }
  }
}

/** Capture sanitized UI & __fluxState telemetry inside a browser instance. */
async function readAppSnapshot(app) {
  return app.evaluate(`(() => {
    const st = window.__fluxState;
    if (!st) return null;
    const host = document.getElementById('react-message-list-host');
    const shell = document.querySelector('[data-testid="mobile-workspace-shell"]');
    return {
      gatewayConnected: Boolean(st.gatewayConnected),
      activeSessionId: st.activeSessionId || null,
      activeLiveSessionId: st.activeLiveSessionId || null,
      messagesPhase: st.messagesPhase || null,
      isStreaming: Boolean(st.isStreaming),
      turnStartedAt: st.turnStartedAt || null,
      dockNotice: typeof st.dockNotice === 'string' ? st.dockNotice : '',
      hasStopBtn: Boolean(
        document.getElementById('dock-stop-btn') ||
        document.querySelector('.m-composer__send-btn--stop')
      ),
      mobilePane: shell ? shell.getAttribute('data-active-pane') : null,
      domText: host ? host.innerText : '',
      messages: Array.isArray(st.messages)
        ? st.messages.map((m) => ({
            id: m.id,
            role: m.role,
            displayKind: m.displayKind || null,
            content: typeof m.content === 'string' ? m.content : '',
            toolCallsCount: Array.isArray(m.toolCalls) ? m.toolCalls.length : 0,
            runningToolCount: Array.isArray(m.toolCalls)
              ? m.toolCalls.filter((tc) => tc.status === 'running').length
              : 0,
          }))
        : [],
    };
  })()`);
}

/** Count user/assistant messages in a snapshot containing an exact marker token. */
function analyzeMarkerState(snap, marker) {
  const msgs = snap?.messages || [];
  const userMatches = msgs.filter((m) => m.role === 'user' && m.content.includes(marker));
  const assistantMatches = msgs.filter((m) => m.role === 'assistant' && m.content.includes(marker));
  return {
    userCount: userMatches.length,
    assistantCount: assistantMatches.length,
    domHasMarker: Boolean(snap?.domText && snap.domText.includes(marker)),
  };
}

/** Count phantom empty assistant bubbles carrying neither text nor tool calls. */
function countOrphanEmptyAssistant(snap) {
  const msgs = snap?.messages || [];
  return msgs.filter(
    (m) => m.role === 'assistant' && !String(m.content || '').trim() && Number(m.toolCallsCount || 0) === 0,
  ).length;
}

/** Set textarea value using React/DOM-compatible native value setter + input event and submit. */
async function submitPromptInBrowser(app, inputSelector, sendSelector, text) {
  const typed = await app.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    if (!input) return false;
    input.scrollIntoView({ block: 'center' });
    input.focus();
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(input, ${JSON.stringify(text)});
    } else {
      input.value = ${JSON.stringify(text)};
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.activeElement === input;
  })()`);
  assert.equal(typed, true, `Failed to focus/type into ${inputSelector}`);

  const readySend = await app.waitFor(
    `(() => {
      const btn = document.querySelector(${JSON.stringify(sendSelector)});
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`,
    { timeoutMs: 5000, intervalMs: 50, label: `click enabled ${sendSelector}` },
  );
  assert.equal(readySend, true, `Send button not ready: ${sendSelector}`);
}

/** Click a session row and verify focus switches cleanly. */
async function clickElement(app, selector, label) {
  const clicked = await app.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Element not found for ${label}: ${selector}`);
}

/** Wait for a multi-device turn initiated on one device to stream and converge on both browsers. */
async function waitForMultiDeviceTurn({ desktopApp, mobileApp, observerRole, marker, timeoutMs = 80_000 }) {
  const startMs = Date.now();
  const deadline = startMs + timeoutMs;
  let sawObserverStreaming = false;
  let sawInitiatorStreaming = false;
  let lastDesktop = null;
  let lastMobile = null;

  while (Date.now() < deadline) {
    const [dSnap, mSnap] = await Promise.all([readAppSnapshot(desktopApp), readAppSnapshot(mobileApp)]);
    lastDesktop = dSnap;
    lastMobile = mSnap;

    if (observerRole === 'mobile') {
      if (mSnap?.isStreaming) sawObserverStreaming = true;
      if (dSnap?.isStreaming) sawInitiatorStreaming = true;
    } else {
      if (dSnap?.isStreaming) sawObserverStreaming = true;
      if (mSnap?.isStreaming) sawInitiatorStreaming = true;
    }

    const dMarker = analyzeMarkerState(dSnap, marker);
    const mMarker = analyzeMarkerState(mSnap, marker);

    const bothSettledWithMarker =
      dSnap &&
      mSnap &&
      !dSnap.isStreaming &&
      !mSnap.isStreaming &&
      dMarker.userCount >= 1 &&
      mMarker.userCount >= 1 &&
      dMarker.assistantCount >= 1 &&
      mMarker.assistantCount >= 1 &&
      dMarker.domHasMarker &&
      mMarker.domHasMarker;

    if (bothSettledWithMarker) {
      return {
        elapsedMs: Date.now() - startMs,
        sawInitiatorStreaming,
        sawObserverStreaming,
        desktopSnap: dSnap,
        mobileSnap: mSnap,
      };
    }
    await sleep(100);
  }

  throw new Error(
    `Multi-device turn timed out waiting for marker=${marker}. ` +
      `sawObserverStreaming=${sawObserverStreaming}, ` +
      `desktop={streaming:${lastDesktop?.isStreaming}, msgs:${lastDesktop?.messages?.length}, notice:${JSON.stringify(lastDesktop?.dockNotice)}}, ` +
      `mobile={streaming:${lastMobile?.isStreaming}, msgs:${lastMobile?.messages?.length}, pane:${lastMobile?.mobilePane}, notice:${JSON.stringify(lastMobile?.dockNotice)}}`,
  );
}

test('Live gateway multi-device sync, long-running watchdog continuity, and CDP screenshots', { timeout: 290_000 }, async (t) => {
  if (!findBrowser() || !liveGatewayEnvReady()) {
    t.skip('Skipping live E2E: headless browser binary or FLUX_GATEWAY_* env vars not available');
    return;
  }

  const auth = await login();
  const cookie = auth.cookie;
  const controlTicket = await fetchTicket(cookie);
  let controlWs = await openControlWs(controlTicket);

  const runStamp = Date.now();
  let mainStoredId = null;
  let switchStoredId = null;
  let desktopApp = null;
  let mobileApp = null;

  t.after(async () => {
    try {
      await desktopApp?.close();
    } catch {
      /* ignore browser close errors */
    }
    try {
      await mobileApp?.close();
    } catch {
      /* ignore browser close errors */
    }
    try {
      controlWs?.close();
    } catch {
      /* ignore ws close errors */
    }
    if (!mainStoredId && !switchStoredId) return;
    let cleanupWs = null;
    try {
      const ticket = await fetchTicket(cookie);
      cleanupWs = await openControlWs(ticket);
      await deleteTempSession(cleanupWs, cookie, mainStoredId);
      await deleteTempSession(cleanupWs, cookie, switchStoredId);
      const listRes = await cleanupWs.call('session.list', { profile: 'default', limit: 100 });
      const remainingIds = new Set(normalizeSessions(listRes).map((s) => s.id || s.session_id));
      if (mainStoredId) {
        assert.equal(remainingIds.has(mainStoredId), false, 'Temp main session must be deleted after test');
      }
      if (switchStoredId) {
        assert.equal(remainingIds.has(switchStoredId), false, 'Temp switch session must be deleted after test');
      }
      console.log('[E2E] Verified cleanup of both temp Scratchpad sessions.');
    } finally {
      cleanupWs?.close();
    }
  });

  mainStoredId = await createAndSeedTempSession(controlWs, `[Flux E2E] MultiDevice Stream ${runStamp}`);
  switchStoredId = await createAndSeedTempSession(controlWs, `[Flux E2E] Switch Target ${runStamp}`);
  assert.notEqual(switchStoredId, mainStoredId, 'distinct switchStoredId must be returned');

  // Launch Desktop (1280x800) and Mobile (390x844 ?shell=mobile) browsers concurrently
  desktopApp = await launchLiveApp({ rootDir: ROOT_DIR });
  await desktopApp.cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await desktopApp.waitUntilReady();

  mobileApp = await launchLiveApp({ rootDir: ROOT_DIR });
  await mobileApp.cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await mobileApp.cdp('Page.navigate', {
    url: `http://127.0.0.1:${mobileApp.webPort}/app.html?shell=mobile`,
  });
  await mobileApp.waitUntilReady();
  await mobileApp.waitFor(
    `Boolean(document.querySelector('[data-testid="mobile-workspace-shell"]'))`,
    { timeoutMs: 25_000, label: 'mobile workspace shell mounted' },
  );

  // Wait for both browsers to discover both isolated temp sessions
  await Promise.all([
    desktopApp.waitFor(
      `(() => {
        const list = window.__fluxState?.sessions || [];
        return list.some(s => (s.id || s.session_id) === ${JSON.stringify(mainStoredId)})
          && list.some(s => (s.id || s.session_id) === ${JSON.stringify(switchStoredId)})
          && Boolean(document.querySelector(${JSON.stringify(`.session-item[data-id="${mainStoredId}"]`)}));
      })()`,
      { timeoutMs: 25_000, label: 'desktop sees temp sessions in LeftRail' },
    ),
    mobileApp.waitFor(
      `Boolean(document.querySelector(${JSON.stringify(`.m-entity-row[data-kind="session"][data-entity-id="${mainStoredId}"]`)}))`,
      { timeoutMs: 25_000, label: 'mobile sees main temp session in Home list' },
    ),
  ]);

  // Select mainStoredId via real clicks on both Desktop and Mobile
  await clickElement(desktopApp, `.session-item[data-id="${mainStoredId}"]`, 'desktop select main session');
  await desktopApp.waitFor(
    `window.__fluxState?.activeSessionId === ${JSON.stringify(mainStoredId)} && window.__fluxState?.messagesPhase === 'ready'`,
    { timeoutMs: 15_000, label: 'desktop main session ready' },
  );

  await clickElement(
    mobileApp,
    `.m-entity-row[data-kind="session"][data-entity-id="${mainStoredId}"]`,
    'mobile select main session',
  );
  await mobileApp.waitFor(
    `window.__fluxState?.activeSessionId === ${JSON.stringify(mainStoredId)} && window.__fluxState?.messagesPhase === 'ready' && document.querySelector('[data-testid="mobile-workspace-shell"]')?.getAttribute('data-active-pane') === 'stage'`,
    { timeoutMs: 15_000, label: 'mobile stage active + ready' },
  );

  // Scenario 1: Desktop -> Mobile live concurrent streaming & user prompt sync
  const prompt1 =
    'Run python3 -c "import time; time.sleep(3)" (read-only, modify nothing), then reply concisely in one sentence containing exact marker E2E_SYNC_A_101.';
  await submitPromptInBrowser(desktopApp, '#dock-prompt-input', '#dock-send-btn', prompt1);
  const res1 = await waitForMultiDeviceTurn({
    desktopApp,
    mobileApp,
    observerRole: 'mobile',
    marker: 'E2E_SYNC_A_101',
    timeoutMs: 75_000,
  });
  assert.equal(res1.sawObserverStreaming, true, 'Mobile observer must enter live isStreaming state during Desktop turn');
  assert.equal(analyzeMarkerState(res1.desktopSnap, 'E2E_SYNC_A_101').userCount, 1, 'Desktop user prompt A count must be 1');
  assert.equal(analyzeMarkerState(res1.mobileSnap, 'E2E_SYNC_A_101').userCount, 1, 'Mobile synced user prompt A count must be 1 (no duplicate)');
  assert.equal(countOrphanEmptyAssistant(res1.desktopSnap), 0, 'Desktop Scenario 1 must leave zero orphan empty assistant bubbles');
  assert.equal(countOrphanEmptyAssistant(res1.mobileSnap), 0, 'Mobile Scenario 1 must leave zero orphan empty assistant bubbles');
  console.log('[E2E] Scenario 1 PASS (Desktop -> Mobile):', {
    elapsedMs: res1.elapsedMs,
    sawObserverStreaming: res1.sawObserverStreaming,
    desktopMsgs: res1.desktopSnap.messages.length,
    mobileMsgs: res1.mobileSnap.messages.length,
  });

  // Scenario 2: Mobile -> Desktop follow-up live streaming & user prompt sync
  const prompt2 =
    'Run python3 -c "import time; time.sleep(3)" (read-only, modify nothing), then reply in one sentence confirming follow-up and containing exact marker E2E_SYNC_B_202.';
  await submitPromptInBrowser(
    mobileApp,
    '#mobile-stage-prompt-input',
    '.m-composer__send-btn[data-ready="true"]:not([disabled])',
    prompt2,
  );
  const res2 = await waitForMultiDeviceTurn({
    desktopApp,
    mobileApp,
    observerRole: 'desktop',
    marker: 'E2E_SYNC_B_202',
    timeoutMs: 75_000,
  });
  assert.equal(res2.sawObserverStreaming, true, 'Desktop observer must enter live isStreaming state during Mobile turn');
  assert.equal(analyzeMarkerState(res2.desktopSnap, 'E2E_SYNC_B_202').userCount, 1, 'Desktop synced user prompt B count must be 1');
  assert.equal(analyzeMarkerState(res2.mobileSnap, 'E2E_SYNC_B_202').userCount, 1, 'Mobile user prompt B count must be 1');
  // Both devices retain Scenario 1 + Scenario 2 markers identically
  assert.equal(analyzeMarkerState(res2.desktopSnap, 'E2E_SYNC_A_101').assistantCount, 1, 'Desktop retains Turn 1 assistant marker');
  assert.equal(analyzeMarkerState(res2.mobileSnap, 'E2E_SYNC_A_101').assistantCount, 1, 'Mobile retains Turn 1 assistant marker');
  assert.equal(countOrphanEmptyAssistant(res2.desktopSnap), 0, 'Desktop Scenario 2 must leave zero orphan empty assistant bubbles');
  assert.equal(countOrphanEmptyAssistant(res2.mobileSnap), 0, 'Mobile Scenario 2 must leave zero orphan empty assistant bubbles');
  console.log('[E2E] Scenario 2 PASS (Mobile -> Desktop):', {
    elapsedMs: res2.elapsedMs,
    sawObserverStreaming: res2.sawObserverStreaming,
    desktopMsgs: res2.desktopSnap.messages.length,
    mobileMsgs: res2.mobileSnap.messages.length,
  });

  // Scenario 3: Long-running (>65s silent tool) watchdog continuity + mid-turn switch out & re-enter
  const prompt3 =
    'Execute a single read-only command via terminal: python3 -c "import time; time.sleep(66); print(\'SLEEP_66_DONE\')". Wait for it to finish, then reply with one short paragraph ending with exact marker STREAM_END_LONG_OK.';
  const longStartMs = Date.now();
  await submitPromptInBrowser(desktopApp, '#dock-prompt-input', '#dock-send-btn', prompt3);

  await Promise.all([
    desktopApp.waitFor('Boolean(window.__fluxState?.isStreaming)', {
      timeoutMs: 15_000,
      label: 'desktop enters streaming on Scenario 3',
    }),
    mobileApp.waitFor('Boolean(window.__fluxState?.isStreaming)', {
      timeoutMs: 15_000,
      label: 'mobile enters streaming on Scenario 3',
    }),
  ]);

  // Wait ~3s into the active silent tool run, then switch Desktop out to switchStoredId and back
  while (Date.now() - longStartMs < 3_000) {
    await sleep(150);
  }
  await clickElement(desktopApp, `.session-item[data-id="${switchStoredId}"]`, 'desktop switch away mid-turn');
  await desktopApp.waitFor(
    `window.__fluxState?.activeSessionId === ${JSON.stringify(switchStoredId)}`,
    { timeoutMs: 10_000, label: 'desktop switched to switchStoredId mid-turn' },
  );

  await sleep(2_500);
  await clickElement(desktopApp, `.session-item[data-id="${mainStoredId}"]`, 'desktop re-enter active turn');
  await desktopApp.waitFor(
    `window.__fluxState?.activeSessionId === ${JSON.stringify(mainStoredId)} && window.__fluxState?.messagesPhase === 'ready'`,
    { timeoutMs: 15_000, label: 'desktop re-entered mainStoredId' },
  );
  const reenterSnap = await readAppSnapshot(desktopApp);
  assert.equal(reenterSnap?.isStreaming, true, 'Desktop MUST preserve isStreaming=true immediately upon re-entering mid-turn');
  assert.equal(reenterSnap?.hasStopBtn, true, 'Desktop MUST show stop button when re-entering mid-turn');

  // Continuously poll past the 60_000ms watchdog boundary until completion
  const longDeadline = longStartMs + 165_000;
  let sawStreamingPast62sDesktop = false;
  let sawStreamingPast62sMobile = false;
  const timeoutNoticePattern = /超时|timeout|timed\s*out|未响应|idle/i;
  let longComplete = null;

  while (Date.now() < longDeadline) {
    const [dSnap, mSnap] = await Promise.all([readAppSnapshot(desktopApp), readAppSnapshot(mobileApp)]);
    const elapsed = Date.now() - longStartMs;

    assert.equal(
      timeoutNoticePattern.test(dSnap?.dockNotice || ''),
      false,
      `Desktop must never emit false timeout notice mid-turn (elapsed=${elapsed}ms, notice=${JSON.stringify(dSnap?.dockNotice)})`,
    );
    assert.equal(
      timeoutNoticePattern.test(mSnap?.dockNotice || ''),
      false,
      `Mobile must never emit false timeout notice mid-turn (elapsed=${elapsed}ms, notice=${JSON.stringify(mSnap?.dockNotice)})`,
    );

    const dMarker = analyzeMarkerState(dSnap, 'STREAM_END_LONG_OK');
    const mMarker = analyzeMarkerState(mSnap, 'STREAM_END_LONG_OK');

    if (elapsed >= 62_000 && !(dMarker.assistantCount >= 1 && mMarker.assistantCount >= 1)) {
      if (dSnap?.isStreaming) sawStreamingPast62sDesktop = true;
      if (mSnap?.isStreaming) sawStreamingPast62sMobile = true;
      assert.equal(
        dSnap?.isStreaming,
        true,
        `Desktop falsely stopped streaming after crossing 60s watchdog at elapsed=${elapsed}ms (before final marker arrived)`,
      );
      assert.equal(
        mSnap?.isStreaming,
        true,
        `Mobile falsely stopped streaming after crossing 60s watchdog at elapsed=${elapsed}ms (before final marker arrived)`,
      );
    }

    if (
      dSnap &&
      mSnap &&
      !dSnap.isStreaming &&
      !mSnap.isStreaming &&
      dMarker.assistantCount >= 1 &&
      mMarker.assistantCount >= 1 &&
      dMarker.domHasMarker &&
      mMarker.domHasMarker
    ) {
      longComplete = { elapsedMs: elapsed, dSnap, mSnap };
      break;
    }
    await sleep(500);
  }

  assert.ok(longComplete, 'Scenario 3 long-running task must complete cleanly on both Desktop and Mobile');
  assert.ok(
    longComplete.elapsedMs >= 62_000,
    `Expected >62s execution to genuinely cross 60s watchdog boundary; observed elapsedMs=${longComplete.elapsedMs}`,
  );
  assert.equal(sawStreamingPast62sDesktop, true, 'Desktop must remain continuously streaming past 62s');
  assert.equal(sawStreamingPast62sMobile, true, 'Mobile must remain continuously streaming past 62s');
  assert.equal(countOrphanEmptyAssistant(longComplete.dSnap), 0, 'Desktop Scenario 3 must leave zero orphan empty assistant bubbles');
  assert.equal(countOrphanEmptyAssistant(longComplete.mSnap), 0, 'Mobile Scenario 3 must leave zero orphan empty assistant bubbles');
  console.log('[E2E] Scenario 3 PASS (>65s long task + switch out/re-enter):', {
    elapsedMs: longComplete.elapsedMs,
    sawStreamingPast62sDesktop,
    sawStreamingPast62sMobile,
    desktopMsgs: longComplete.dSnap.messages.length,
    mobileMsgs: longComplete.mSnap.messages.length,
  });

  // Scenario 4: Capture CDP PNG screenshots & verify zero fatal runtime errors
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const desktopPng = await desktopApp.cdp('Page.captureScreenshot', { format: 'png' });
  const mobilePng = await mobileApp.cdp('Page.captureScreenshot', { format: 'png' });
  const desktopPngBuf = Buffer.from(desktopPng.data, 'base64');
  const mobilePngBuf = Buffer.from(mobilePng.data, 'base64');
  const desktopPngPath = path.join(ARTIFACT_DIR, 'desktop.png');
  const mobilePngPath = path.join(ARTIFACT_DIR, 'mobile.png');
  fs.writeFileSync(desktopPngPath, desktopPngBuf);
  fs.writeFileSync(mobilePngPath, mobilePngBuf);

  assert.ok(desktopPngBuf.length > 5000, `desktop.png too small (${desktopPngBuf.length} bytes)`);
  assert.ok(mobilePngBuf.length > 5000, `mobile.png too small (${mobilePngBuf.length} bytes)`);

  const filterFatal = (errs) => errs.filter((msg) => !String(msg).includes('ResizeObserver'));
  const fatalDesktop = filterFatal(desktopApp.pageErrors);
  const fatalMobile = filterFatal(mobileApp.pageErrors);
  assert.deepEqual(fatalDesktop, [], `Unexpected Desktop runtime errors: ${JSON.stringify(fatalDesktop)}`);
  assert.deepEqual(fatalMobile, [], `Unexpected Mobile runtime errors: ${JSON.stringify(fatalMobile)}`);

  console.log('[E2E] Scenario 4 PASS (Screenshots & zero pageErrors):', {
    desktopPngBytes: desktopPngBuf.length,
    mobilePngBytes: mobilePngBuf.length,
  });
});
