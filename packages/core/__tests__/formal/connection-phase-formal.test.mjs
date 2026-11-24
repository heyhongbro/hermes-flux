import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  classifyConnectionError,
  computeColdStartRetryDelayMs,
  resolveConnectionPhase,
  resolveTitlebarConnectionStatus,
} from '../../dist/rpc/connectionPhase.js';

const FSM_STATES = [null, 'DISCONNECTED', 'CONNECTING', 'HANDSHAKING', 'CONNECTED', 'RECONNECTING'];

test('Formal invariant (INV-CONN-01): unconfigured, manual disconnect, and auth error dominate phase resolution', () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom(...FSM_STATES),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (hasGatewayUrl, manualDisconnected, authError, fsmState, isSyncing, isSyncedFlash, isColdStartRetrying, hasConnectedOnce) => {
        const phase = resolveConnectionPhase({
          hasGatewayUrl,
          manualDisconnected,
          authError,
          fsmState,
          isSyncing,
          isSyncedFlash,
          isColdStartRetrying,
          hasConnectedOnce,
        });

        if (!hasGatewayUrl) {
          assert.equal(phase, 'unconfigured');
          return;
        }
        if (manualDisconnected || authError) {
          assert.equal(phase, 'offline');
        }
      },
    ),
    { numRuns: 1000 },
  );
});

test('Formal invariant (INV-CONN-02): phase & titlebar status are total and syncing takes precedence over synced/connected', () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom(...FSM_STATES),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 100, max: 599 }),
      fc.string(),
      (hasGatewayUrl, manualDisconnected, authError, fsmState, isSyncing, isSyncedFlash, isColdStartRetrying, hasConnectedOnce, statusCode, message) => {
        const phase = resolveConnectionPhase({
          hasGatewayUrl,
          manualDisconnected,
          authError,
          fsmState,
          isSyncing,
          isSyncedFlash,
          isColdStartRetrying,
          hasConnectedOnce,
        });

        const validPhases = new Set(['unconfigured', 'connecting', 'connected', 'reconnecting', 'syncing', 'synced', 'offline']);
        assert.ok(validPhases.has(phase));

        if (hasGatewayUrl && !manualDisconnected && !authError && fsmState === 'CONNECTED') {
          if (isSyncing) assert.equal(phase, 'syncing');
          else if (isSyncedFlash) assert.equal(phase, 'synced');
          else assert.equal(phase, 'connected');
        }

        const titleStatus = resolveTitlebarConnectionStatus(phase, fsmState === 'CONNECTED');
        assert.ok(['connected', 'reconnecting', 'syncing', 'offline'].includes(titleStatus));

        const kind = classifyConnectionError(message, statusCode);
        if (statusCode === 401 || statusCode === 403) {
          assert.equal(kind, 'auth');
        }
      },
    ),
    { numRuns: 1000 },
  );
});

test('Formal invariant (INV-CONN-03): cold-start retry backoff is bounded within [1000, 15000] and monotonically non-decreasing', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -5, max: 100 }),
      fc.integer({ min: -5, max: 100 }),
      (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const delayLo = computeColdStartRetryDelayMs(lo);
        const delayHi = computeColdStartRetryDelayMs(hi);
        assert.ok(delayLo >= 1000 && delayLo <= 15000);
        assert.ok(delayHi >= 1000 && delayHi <= 15000);
        assert.ok(delayLo <= delayHi);
      },
    ),
    { numRuns: 1000 },
  );
});
