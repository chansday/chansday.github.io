// Preloaded with --import by scripts/test-future-clock.mjs: shifts "now" by
// KOSPI_FAKE_NOW so date-dependent tests are exercised on later days.
const offset = Date.parse(process.env.KOSPI_FAKE_NOW) - Date.now();
if (!Number.isFinite(offset)) throw new Error(`KOSPI_FAKE_NOW is not a timestamp: ${process.env.KOSPI_FAKE_NOW}`);
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate;
