/**
 * #4915 determinism preload (`node --import`): pins `new Date()` / `Date.now()`
 * to 2026-11-24T12:00:00.000Z and `crypto.randomInt` to 0, so the escalation
 * message id and the `mirrorExportAt` stamp are identical across runs — that is
 * what makes the gate-closed bytes comparable to the captured golden.
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const FIXED_NOW = Date.parse('2026-11-24T12:00:00.000Z');
const RealDate = Date;

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }

  static now() {
    return FIXED_NOW;
  }
}

globalThis.Date = FakeDate;
crypto.randomInt = () => 0;
syncBuiltinESMExports();