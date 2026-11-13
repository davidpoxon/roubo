import { describe, expect, it } from "vitest";
import { seamLabel, timelineTime } from "./delivery-timeline-model";

// Each time is built from local calendar parts, so the cases hold in any TZ.
const local = (month: number, day: number, h: number, m: number, s: number, year = 2026) =>
  new Date(year, month - 1, day, h, m, s).toISOString();

// Friday 13 November 2026, 10:00 local.
const now = new Date(2026, 10, 13, 10, 0, 0);

describe("timelineTime", () => {
  it("shows only the time for a time on the day of now", () => {
    expect(timelineTime(local(11, 13, 0, 0, 1), now)).toBe("00:00:01");
    expect(timelineTime(local(11, 13, 2, 48, 42), now)).toBe("02:48:42");
  });

  it("shows only the time for a later time on the same day", () => {
    expect(timelineTime(local(11, 13, 23, 59, 59), now)).toBe("23:59:59");
  });

  it("puts the weekday in front of a time on the six days before now", () => {
    expect(timelineTime(local(11, 12, 23, 59, 59), now)).toBe("Thu 23:59:59");
    expect(timelineTime(local(11, 10, 13, 33, 57), now)).toBe("Tue 13:33:57");
    expect(timelineTime(local(11, 7, 8, 5, 0), now)).toBe("Sat 08:05:00");
  });

  it("puts the date in front of a time seven or more days before now", () => {
    expect(timelineTime(local(11, 6, 13, 33, 57), now)).toBe("6 Nov 13:33:57");
    expect(timelineTime(local(10, 16, 9, 44, 0), now)).toBe("16 Oct 09:44:00");
  });

  it("adds the year when it is not the year of now", () => {
    expect(timelineTime(local(12, 31, 23, 0, 0, 2025), now)).toBe("31 Dec 2025 23:00:00");
  });

  it("puts the date in front of a time on a later day than now", () => {
    expect(timelineTime(local(11, 14, 0, 0, 1), now)).toBe("14 Nov 00:00:01");
  });

  it("drops the seconds on request", () => {
    expect(timelineTime(local(11, 13, 8, 41, 30), now, false)).toBe("08:41");
    expect(timelineTime(local(11, 11, 8, 41, 30), now, false)).toBe("Wed 08:41");
  });

  it("reads no time and an unparsable stamp as they are", () => {
    expect(timelineTime(null, now)).toBe("no time");
    expect(timelineTime("not a time", now)).toBe("not a time");
  });
});

describe("seamLabel", () => {
  it("reads the seam's time against now", () => {
    const seam = {
      kind: "seam" as const,
      key: "seam:s-1",
      name: "s-1",
      status: "ok",
      at: local(11, 12, 9, 44, 0),
    };
    expect(seamLabel(seam, now)).toBe("s-1 · ok · Thu 09:44:00");
    expect(seamLabel({ ...seam, at: null }, now)).toBe("s-1 · ok · no time");
  });
});
