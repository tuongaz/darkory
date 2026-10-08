import { describe, expect, it } from "vitest";
import vectors from "../../../api/shortid-vectors.json";
import { isId, toShort, toUuid } from "./shortid";

// The vectors internal/shortid's tests read too: the server and the web app agree on every id.
describe("short ids", () => {
  it.each(vectors.pairs)("$uuid is $short", ({ uuid, short }) => {
    expect(toShort(uuid)).toBe(short);
    expect(toShort(short)).toBe(short);
    expect(toUuid(short)).toBe(uuid);
    expect(toUuid(uuid)).toBe(uuid);
    expect(isId(uuid) && isId(short)).toBe(true);
  });

  it("reads a UUID in upper case", () => {
    const u = vectors.uppercase;
    expect(toUuid(u.uuid)).toBe(u.canonical);
    expect(toShort(u.uuid)).toBe(u.short);
  });

  it.each(vectors.not_ids)("leaves %j as it is", (s) => {
    expect(isId(s)).toBe(false);
    expect(toShort(s)).toBe(s);
    expect(toUuid(s)).toBe(s);
  });

  it("sorts as the UUIDs do", () => {
    const uuids = vectors.pairs.map((p) => p.uuid).sort();
    const shorts = vectors.pairs.map((p) => p.short).sort();
    expect(uuids.map(toShort)).toEqual(shorts);
  });
});
