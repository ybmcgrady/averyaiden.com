import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { DeviceStore } from "../lib/store.js";

test("device stories and image blobs survive reopening, edits, trash, and restore", async () => {
  const name = `test-${crypto.randomUUID()}`;
  const first = await new DeviceStore(name).open();
  const photo = {
    id: crypto.randomUUID(),
    blob: new Blob(["full image"]),
    thumbnail: new Blob(["thumbnail"]),
    width: 100,
    height: 80,
    byte_size: 19,
  };
  let entry = await first.save(
    {
      title: "",
      body: "Our afternoon",
      caption: "In the garden",
      event_date: "2026-10-10",
      photos: [photo],
    },
    "draft",
  );
  first.close();
  const second = await new DeviceStore(name).open();
  const [loaded] = await second.list();
  assert.equal(loaded.body, "Our afternoon");
  assert.equal(await loaded.photos[0].blob.text(), "full image");
  entry = await second.save(
    { ...loaded, title: "A little adventure" },
    "published",
  );
  assert.equal(entry.version, 2);
  assert.equal(entry.status, "published");
  const trashed = await second.setDeleted(entry, true);
  assert.ok(trashed.deleted_at);
  await assert.rejects(() => second.save(trashed, "published"), /Restore/);
  const restored = await second.setDeleted(trashed, false);
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.photos.length, 1);
  second.close();
});
test("a stale tab cannot overwrite newer words or move a newer version to trash", async () => {
  const store = await new DeviceStore(`test-${crypto.randomUUID()}`).open();
  const original = await store.save(
    { title: "", body: "First", event_date: "2026-10-10", photos: [] },
    "published",
  );
  await store.save({ ...original, body: "Second" }, "published");
  await assert.rejects(
    () => store.save({ ...original, body: "Stale" }, "published"),
    /another device/,
  );
  await assert.rejects(
    () => store.setDeleted(original, true),
    /another device/,
  );
  assert.equal((await store.list())[0].body, "Second");
  store.close();
});
