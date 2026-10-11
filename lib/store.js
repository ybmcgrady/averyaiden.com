import { validateEntry, conflictError } from "./model.js";

const PHOTO_FIELDS = [
  "id",
  "path",
  "thumbnail_path",
  "width",
  "height",
  "byte_size",
];
const metadata = (photo) =>
  Object.fromEntries(PHOTO_FIELDS.map((key) => [key, photo[key]]));

export function friendlyError(error) {
  if (error?.code === "40001" || error?.code === "23505")
    return conflictError();
  if (error?.code === "42501")
    return new Error(
      "Your account cannot make this change. Check your family membership and sign in again.",
    );
  return error instanceof Error
    ? error
    : new Error(error?.message || "Something went wrong. Please try again.");
}

export class DeviceStore {
  member = {
    user_id: "device-demo",
    display_name: "You",
    role: "admin",
    active: true,
  };
  mode = "device";
  constructor(databaseName = "avery-aiden-device-demo") {
    this.databaseName = databaseName;
  }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("posts", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "This browser cannot save the device demo. Try a regular browser window.",
          ),
        );
      request.onblocked = () =>
        reject(new Error("Close other demo tabs and try again."));
    });
    return this;
  }
  operation(mode, run) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("posts", mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(
          transaction.error ||
            new Error("Could not save. This browser may be out of storage."),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ||
            new Error("The save was interrupted. Please try again."),
        );
      run(
        transaction.objectStore("posts"),
        (value) => {
          result = value;
        },
        reject,
      );
    });
  }
  async list() {
    return this.operation("readonly", (table, done) => {
      const request = table.getAll();
      request.onsuccess = () =>
        done(request.result.map((entry) => ({ ...entry, author_name: "You" })));
    });
  }
  async save(entry, status) {
    validateEntry(entry, status);
    const id = entry.id || crypto.randomUUID();
    return this.operation("readwrite", (table, done, reject) => {
      const request = table.get(id);
      request.onsuccess = () => {
        const previous = request.result;
        if (
          (previous && previous.version !== entry.version) ||
          (!previous && entry.id)
        ) {
          reject(conflictError());
          return;
        }
        if (previous?.deleted_at) {
          reject(new Error("Restore this story before editing it."));
          return;
        }
        const now = new Date().toISOString();
        const saved = {
          id,
          author_id: this.member.user_id,
          title: entry.title.trim(),
          body: entry.body,
          caption: entry.caption || "",
          event_date: entry.event_date,
          photos: entry.photos,
          status,
          version: (previous?.version || 0) + 1,
          created_at: previous?.created_at || now,
          updated_at: now,
          deleted_at: null,
        };
        table.put(saved);
        done(saved);
      };
    });
  }
  async setDeleted(entry, deleted) {
    return this.operation("readwrite", (table, done, reject) => {
      const request = table.get(entry.id);
      request.onsuccess = () => {
        const previous = request.result;
        if (!previous || previous.version !== entry.version) {
          reject(conflictError());
          return;
        }
        const saved = {
          ...previous,
          deleted_at: deleted ? new Date().toISOString() : null,
          version: previous.version + 1,
        };
        table.put(saved);
        done(saved);
      };
    });
  }
  async imageBlob(photo, small) {
    return small ? photo.thumbnail : photo.blob;
  }
  close() {
    this.db?.close();
  }
}

export class CloudStore {
  mode = "cloud";
  constructor(client, member) {
    this.client = client;
    this.member = member;
  }
  async list() {
    const memberResult = await this.client
      .from("family_members")
      .select("user_id,display_name");
    if (memberResult.error) throw friendlyError(memberResult.error);
    const authors = new Map(
      memberResult.data.map((member) => [member.user_id, member.display_name]),
    );
    const entries = [];
    for (let offset = 0; ; offset += 500) {
      const result = await this.client
        .from("posts")
        .select("*,photos(*)")
        .order("event_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + 499);
      if (result.error) throw friendlyError(result.error);
      entries.push(
        ...result.data.map((entry) => ({
          ...entry,
          author_name: authors.get(entry.author_id) || "Family member",
          photos: entry.photos.sort((a, b) => a.position - b.position),
        })),
      );
      if (result.data.length < 500) break;
    }
    return entries;
  }
  async write(entry, status, photos) {
    const result = await this.client
      .rpc("save_entry", {
        entry_id: entry.id,
        expected_version: entry.version || 0,
        entry_title: entry.title,
        entry_body: entry.body,
        entry_caption: entry.caption || "",
        entry_date: entry.event_date,
        entry_status: status,
        entry_photos: photos.map(metadata),
      })
      .single();
    if (result.error) throw friendlyError(result.error);
    return result.data;
  }
  async save(entry, status, onDraftCreated = () => {}) {
    validateEntry(entry, status);
    let base = { ...entry };
    if (!base.id) {
      base = await this.write(
        { ...base, id: crypto.randomUUID(), version: 0 },
        "draft",
        [],
      );
      onDraftCreated(base);
    } else {
      const current = await this.client
        .from("posts")
        .select("id,version,deleted_at")
        .eq("id", base.id)
        .maybeSingle();
      if (current.error) throw friendlyError(current.error);
      if (!current.data || current.data.version !== base.version)
        throw conflictError();
      if (current.data.deleted_at)
        throw new Error("Restore this story before editing it.");
    }
    const attempted = [];
    let committed = false;
    try {
      const photos = [];
      for (const photo of entry.photos) {
        if (!photo.blob) {
          photos.push(metadata(photo));
          continue;
        }
        const prefix = `${this.member.user_id}/${base.id}/${photo.id}`;
        const item = {
          ...metadata(photo),
          path: `${prefix}.jpg`,
          thumbnail_path: `${prefix}.thumb.jpg`,
        };
        // A prior interrupted upload may have left an unreferenced object.
        // RLS prevents this cleanup from removing committed story photos.
        await this.client.storage
          .from("family-photos")
          .remove([item.path, item.thumbnail_path]);
        for (const [path, blob] of [
          [item.path, photo.blob],
          [item.thumbnail_path, photo.thumbnail],
        ]) {
          attempted.push(path);
          const result = await this.client.storage
            .from("family-photos")
            .upload(path, blob, { contentType: "image/jpeg", upsert: false });
          if (result.error)
            throw new Error(
              "A photo could not be uploaded. Your story and photos are still in the editor. Check your connection and try again.",
            );
        }
        photos.push(item);
      }
      const saved = await this.write(
        { ...entry, id: base.id, version: base.version },
        status,
        photos,
      );
      committed = true;
      // Unreferenced objects can be removed; policies forbid deleting live photos.
      const kept = new Set(photos.flatMap((p) => [p.path, p.thumbnail_path]));
      const removed = (entry.previousPhotos || [])
        .flatMap((p) => [p.path, p.thumbnail_path])
        .filter((path) => path && !kept.has(path));
      if (removed.length)
        await this.client.storage
          .from("family-photos")
          .remove(removed)
          .catch(() => {});
      return { ...saved, photos, author_name: this.member.display_name };
    } catch (error) {
      if (!committed && attempted.length)
        await this.client.storage
          .from("family-photos")
          .remove(attempted)
          .catch(() => {});
      throw friendlyError(error);
    }
  }
  async setDeleted(entry, deleted) {
    const result = await this.client
      .rpc("set_entry_deleted", {
        entry_id: entry.id,
        expected_version: entry.version,
        is_deleted: deleted,
      })
      .single();
    if (result.error) throw friendlyError(result.error);
    return result.data;
  }
  async imageBlob(photo, small) {
    // Authenticated downloads are checked on every request and do not leave
    // reusable public or signed image URLs in the page or local database.
    const result = await this.client.storage
      .from("family-photos")
      .download(small ? photo.thumbnail_path : photo.path);
    if (result.error)
      throw new Error(
        "This photo is unavailable. Refresh the page and try again.",
      );
    return result.data;
  }
  close() {}
}

export async function connectCloud(config) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co"))
    throw new Error("Use the HTTPS Project URL from Supabase.");
  const key = config.supabasePublishableKey;
  if (!key.startsWith("sb_publishable_")) {
    let role;
    try {
      role = JSON.parse(
        atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      ).role;
    } catch {
      /* rejected below */
    }
    if (role !== "anon")
      throw new Error(
        "Only a publishable key or legacy anon key belongs in the website configuration.",
      );
  }
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm"
  );
  return createClient(url.href, key);
}
