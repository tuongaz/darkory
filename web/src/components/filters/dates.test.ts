// A date axis on the wire: a picked local day's bounds, what each operator compares, what a chip reads.
import { describe, expect, it } from "vitest";
import { dateBounds, dateText, dayOf, endOf, passesDate, pillDays, startOf } from "./dates";

const oct = (day: number, h = 0, m = 0, s = 0, ms = 0) => new Date(2026, 9, day, h, m, s, ms);
const now = oct(7, 15).getTime();
/** The instant a local time is, as the record keeps it. */
const at = (d: Date) => d.toISOString();

describe("a day's bounds", () => {
  it("are RFC 3339 with the browser's offset, the day's first and last millisecond", () => {
    expect(startOf(oct(4, 13))).toMatch(/^2026-10-04T00:00:00\.000[+-]\d\d:\d\d$/);
    expect(endOf(oct(4, 13))).toMatch(/^2026-10-04T23:59:59\.999[+-]\d\d:\d\d$/);
    expect(Date.parse(startOf(oct(4, 13)))).toBe(oct(4).getTime());
    expect(Date.parse(endOf(oct(4)))).toBe(oct(4, 23, 59, 59, 999).getTime());
  });

  it("read back as the local day, without repeats", () => {
    expect(dayOf(endOf(oct(4)))).toEqual(oct(4));
    expect(pillDays([startOf(oct(6)), endOf(oct(4)), startOf(oct(4))])).toEqual([oct(4), oct(6)]);
    expect(dayOf("not a time")).toBeUndefined();
  });

  it("are the bound each operator compares with", () => {
    expect(dateBounds("after", [oct(4)])).toEqual([endOf(oct(4))]);
    expect(dateBounds("lte", [oct(4)])).toEqual([endOf(oct(4))]);
    expect(dateBounds("before", [oct(4)])).toEqual([startOf(oct(4))]);
    expect(dateBounds("gte", [oct(4)])).toEqual([startOf(oct(4))]);
    expect(dateBounds("btw", [oct(4), oct(6)])).toEqual([startOf(oct(4)), endOf(oct(6))]);
    expect(dateBounds("btw", [oct(4)])).toEqual([startOf(oct(4)), endOf(oct(4))]);
  });
});

describe("what a date chip reads", () => {
  const day = (d: Date) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(d);
  it("names the operator and the days", () => {
    expect(dateText("after", [endOf(oct(4))], now)).toBe(`after ${day(oct(4))}`);
    expect(dateText("before", [startOf(oct(4))], now)).toBe(`before ${day(oct(4))}`);
    expect(dateText("gte", [startOf(oct(4))], now)).toBe(`on or after ${day(oct(4))}`);
    expect(dateText("btw", [startOf(oct(4)), endOf(oct(6))], now)).toBe(`${day(oct(4))} – ${day(oct(6))}`);
    expect(dateText("btw", [startOf(oct(4)), endOf(oct(4))], now)).toBe(day(oct(4)));
    expect(dateText("last", ["7d"], now)).toBe("Last 7 days");
  });

  it("adds the year to a day of another year", () => {
    expect(dateText("after", [endOf(new Date(2025, 9, 4))], now)).toMatch(/2025/);
  });
});

describe("passing a date pill", () => {
  const pill = (op: string, ...values: string[]) => ({ field: "filed_at", op, values });

  it("compares instants plainly, the day's bounds included where the words say so", () => {
    const after = pill("after", endOf(oct(4)));
    expect(passesDate(at(oct(4, 23, 59)), after, now)).toBe(false);
    expect(passesDate(at(oct(5)), after, now)).toBe(true);
    const before = pill("before", startOf(oct(4)));
    expect(passesDate(at(oct(3, 23, 59)), before, now)).toBe(true);
    expect(passesDate(at(oct(4)), before, now)).toBe(false);
    const between = pill("btw", startOf(oct(4)), endOf(oct(6)));
    expect([oct(3, 23), oct(4), oct(6, 23, 59, 59, 999), oct(7)].map((d) => passesDate(at(d), between, now))).toEqual([false, true, true, false]);
    expect(passesDate(at(oct(4)), pill("gte", startOf(oct(4))), now)).toBe(true);
    expect(passesDate(at(oct(4, 23)), pill("lte", endOf(oct(4))), now)).toBe(true);
  });

  it("reads a window back from now", () => {
    const week = pill("last", "7d");
    expect(passesDate(at(new Date(now - 6 * 86_400_000)), week, now)).toBe(true);
    expect(passesDate(at(new Date(now - 8 * 86_400_000)), week, now)).toBe(false);
  });

  it("fails a record without the date", () => {
    expect(passesDate(undefined, pill("last", "90d"), now)).toBe(false);
  });
});
