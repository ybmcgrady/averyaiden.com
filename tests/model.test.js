import test from "node:test";
import assert from "node:assert/strict";
import {
  validDate,
  validateEntry,
  filterEntries,
  displayDate,
} from "../lib/model.js";

test("calendar dates remain dates, including leap years", () => {
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2026-04-31"), false);
  assert.equal(validDate("not a date"), false);
  assert.equal(displayDate("2026-10-10"), "October 10, 2026");
});
test("published entries require words or a photo, not just a title", () => {
  const entry = {
    title: "Hello",
    body: " ",
    event_date: "2026-10-10",
    photos: [],
  };
  assert.throws(() => validateEntry(entry, "published"), /few words/);
  assert.doesNotThrow(() => validateEntry(entry, "draft"));
  assert.doesNotThrow(() =>
    validateEntry({ ...entry, photos: [{ id: "one" }] }, "published"),
  );
  assert.throws(
    () => validateEntry({ ...entry, photos: Array(21).fill({}) }, "draft"),
    /20 photos/,
  );
});
test("search and author filters exclude drafts and trash from the public family timeline", () => {
  const base = {
    title: "Autumn walk",
    body: "",
    caption: "",
    event_date: "2026-10-10",
    created_at: "2026-10-10",
    author_id: "a",
    status: "published",
  };
  const entries = [
    { ...base, id: "live" },
    { ...base, id: "draft", status: "draft" },
    { ...base, id: "other-draft", status: "draft", author_id: "b" },
    { ...base, id: "trash", deleted_at: "2026-10-11" },
  ];
  assert.deepEqual(
    filterEntries(entries, { query: "AUTUMN" }).map((p) => p.id),
    ["live"],
  );
  assert.deepEqual(
    filterEntries(entries, { mode: "draft", userId: "a" }).map((p) => p.id),
    ["draft"],
  );
  assert.deepEqual(
    filterEntries(entries, { mode: "trash" }).map((p) => p.id),
    ["trash"],
  );
  assert.equal(filterEntries(entries, { author: "b" }).length, 0);
});
