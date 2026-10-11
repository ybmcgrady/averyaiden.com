import test from "node:test";
import assert from "node:assert/strict";
import { CloudStore } from "../lib/store.js";

const member = { user_id: "author", display_name: "Avery" };
const photo = {
  id: "new-photo",
  blob: new Blob(["image"]),
  thumbnail: new Blob(["thumb"]),
  width: 400,
  height: 300,
  byte_size: 10,
};
const entry = {
  id: "story",
  version: 4,
  title: "Saturday",
  body: "Our little story",
  caption: "",
  event_date: "2026-10-10",
  photos: [photo],
  previousPhotos: [{ path: "old.jpg", thumbnail_path: "old.thumb.jpg" }],
};
function fixture({
  currentVersion = 4,
  failThumbnail = false,
  failCommit = false,
} = {}) {
  const calls = [];
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: { id: "story", version: currentVersion, deleted_at: null },
          };
        },
      };
    },
    rpc(name, args) {
      calls.push({ action: "save", args });
      return {
        async single() {
          return failCommit
            ? { error: { code: "40001", message: "version conflict" } }
            : { data: { ...entry, version: 5, status: args.entry_status } };
        },
      };
    },
    storage: {
      from() {
        return {
          async remove(paths) {
            calls.push({ action: "remove", paths });
            return { data: [] };
          },
          async upload(path) {
            calls.push({ action: "upload", path });
            return failThumbnail && path.endsWith(".thumb.jpg")
              ? { error: { message: "offline" } }
              : { data: { path } };
          },
        };
      },
    },
  };
  return { store: new CloudStore(client, member), calls };
}

test("stale cloud edits are rejected before touching stored photos", async () => {
  const { store, calls } = fixture({ currentVersion: 5 });
  await assert.rejects(() => store.save(entry, "published"), /another/);
  assert.deepEqual(calls, []);
});

test("partial photo failures clean up attempted uploads without publishing or deleting old photos", async () => {
  const { store, calls } = fixture({ failThumbnail: true });
  await assert.rejects(
    () => store.save(entry, "published"),
    /could not be uploaded/,
  );
  assert.equal(
    calls.some((call) => call.action === "save"),
    false,
  );
  assert.deepEqual(calls.at(-1), {
    action: "remove",
    paths: ["author/story/new-photo.jpg", "author/story/new-photo.thumb.jpg"],
  });
  assert.equal(
    calls.some((call) => call.paths?.includes("old.jpg")),
    false,
  );
});

test("a successful cloud save commits photo metadata before cleaning up detached files", async () => {
  const { store, calls } = fixture();
  const saved = await store.save(entry, "published");
  assert.equal(saved.version, 5);
  assert.equal(saved.photos[0].blob, undefined);
  const saveIndex = calls.findIndex((call) => call.action === "save");
  assert.equal(calls[saveIndex].args.expected_version, 4);
  assert.equal(
    calls[saveIndex].args.entry_photos[0].path,
    "author/story/new-photo.jpg",
  );
  assert.deepEqual(calls[saveIndex + 1], {
    action: "remove",
    paths: ["old.jpg", "old.thumb.jpg"],
  });
});

test("a version conflict after upload keeps the previous story photos intact", async () => {
  const { store, calls } = fixture({ failCommit: true });
  await assert.rejects(() => store.save(entry, "published"), /another/);
  assert.equal(
    calls.some((call) => call.paths?.includes("old.jpg")),
    false,
  );
  assert.deepEqual(calls.at(-1).paths, [
    "author/story/new-photo.jpg",
    "author/story/new-photo.thumb.jpg",
  ]);
});
