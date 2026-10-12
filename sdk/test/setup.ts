/**
 * Test setup (vitest `setupFiles`): the SDK compares the cluster clock with
 * this device's clock before the quantum key signs a time (audit 4, ID-F1b).
 * The tests simulate a cluster at fixed times, so this device's clock is the
 * simulated cluster clock read last (`MockConnection.get` records it): an
 * honest RPC. Tests of the clock check pass `localNowSecs` themselves.
 */
import { setLocalClockSource } from "../src/rpc/clock.js";

setLocalClockSource(() => (globalThis as { __noisedMockClock?: bigint }).__noisedMockClock ?? null);
