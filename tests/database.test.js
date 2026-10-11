import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("database and storage policies enforce membership, ownership, draft privacy, and atomic updates", async () => {
  const db = new PGlite();
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const admin = "33333333-3333-4333-8333-333333333333";
  const outsider = "44444444-4444-4444-8444-444444444444";
  const post = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const photo = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const draft = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ghost = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, storage to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
    grant select on storage.objects to anon;
  `);
  await db.exec(
    await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
  );
  for (const id of [a, b, admin, outsider])
    await db.query("insert into auth.users values($1)", [id]);
  for (const [id, name, role] of [
    [a, "Avery", "member"],
    [b, "Aiden", "member"],
    [admin, "Mom", "admin"],
  ]) {
    await db.query("insert into public.family_members values($1,$2,$3,true)", [
      id,
      name,
      role,
    ]);
  }
  const as = async (id) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      id || "",
    ]);
    await db.exec(id ? "set role authenticated" : "set role anon");
  };
  const save = (
    id,
    version,
    status = "draft",
    photos = [],
    body = "Our little story",
  ) =>
    db.query(
      "select * from public.save_entry($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [
        id,
        version,
        "Title",
        body,
        "",
        "2026-10-10",
        status,
        JSON.stringify(photos),
      ],
    );
  const count = async (table) =>
    (await db.query(`select count(*)::int as total from ${table}`)).rows[0]
      .total;
  const item = {
    id: photo,
    path: `${a}/${post}/${photo}.jpg`,
    thumbnail_path: `${a}/${post}/${photo}.thumb.jpg`,
    width: 400,
    height: 300,
    byte_size: 5000,
  };
  try {
    await as(outsider);
    assert.equal(await count("public.posts"), 0);
    await assert.rejects(() => save(post, 0), /membership/);
    await as(a);
    await save(post, 0);
    await save(draft, 0);
    assert.equal(await count("public.posts"), 2);
    await assert.rejects(
      () =>
        db.query(
          "update public.family_members set role = 'admin' where user_id = $1",
          [a],
        ),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        db.query("update public.posts set author_id = $1 where id = $2", [
          b,
          post,
        ]),
      /permission denied/,
    );
    await as(b);
    assert.equal(await count("public.posts"), 0);
    await assert.rejects(() => save(post, 1), /author/);
    await as(admin);
    assert.equal(
      await count("public.posts"),
      0,
      "Admins cannot read someone else’s unpublished draft",
    );
    await as(a);
    for (const name of [
      item.path,
      item.thumbnail_path,
      `${a}/${post}/${ghost}.jpg`,
    ]) {
      await db.query(
        "insert into storage.objects(bucket_id,name) values('family-photos',$1)",
        [name],
      );
    }
    assert.equal(
      await count("storage.objects"),
      3,
      "Authors can read their own staged uploads for cleanup",
    );
    await as(b);
    assert.equal(
      await count("storage.objects"),
      0,
      "Other members cannot read unattached uploads",
    );
    await as(a);
    await assert.rejects(
      () =>
        save(post, 1, "published", [
          { ...item, path: `${b}/${post}/${photo}.jpg` },
        ]),
      /ownership/,
    );
    await save(post, 1, "published", [item]);
    await as(b);
    assert.equal(await count("public.posts"), 1);
    assert.equal(await count("public.photos"), 1);
    assert.equal(
      await count("storage.objects"),
      2,
      "Only the committed full photo and thumbnail can be read",
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into storage.objects(bucket_id,name) values('family-photos',$1)",
          [`${b}/${post}/${ghost}.jpg`],
        ),
      /row-level security/,
    );
    await as(a);
    await db.query("delete from storage.objects where name = $1", [item.path]);
    assert.equal(
      await count("storage.objects"),
      3,
      "Live images cannot be removed by a storage call",
    );
    await assert.rejects(
      () => save(post, 1, "published", [item], "Stale edit"),
      /version conflict/,
    );
    await assert.rejects(
      () => save(post, 2, "published", [item, item]),
      /Duplicate/,
    );
    assert.equal(
      (await db.query("select body from public.posts where id = $1", [post]))
        .rows[0].body,
      "Our little story",
    );
    await db.query("select * from public.set_entry_deleted($1,$2,true)", [
      post,
      2,
    ]);
    await as(b);
    assert.equal(await count("public.posts"), 0);
    assert.equal(await count("storage.objects"), 0);
    await as(admin);
    assert.equal(
      await count("public.posts"),
      1,
      "Admin sees published trash, but not the private draft",
    );
    await db.query("select * from public.set_entry_deleted($1,$2,false)", [
      post,
      3,
    ]);
    await as(a);
    await save(post, 4, "published", [], "Text-only after removing photo");
    assert.equal(
      await count("storage.objects"),
      3,
      "The owner retains access to detached files for cleanup",
    );
    await as(b);
    assert.equal(await count("storage.objects"), 0);
    await as(a);
    await db.query("delete from storage.objects where name = $1", [item.path]);
    await db.exec("reset role");
    assert.equal(
      (
        await db.query(
          "select count(*)::int as total from storage.objects where name = $1",
          [item.path],
        )
      ).rows[0].total,
      0,
    );
    await db.query(
      "update public.family_members set active=false where user_id=$1",
      [a],
    );
    await as(a);
    assert.equal(
      await count("public.posts"),
      0,
      "Revocation is checked on every read",
    );
    await assert.rejects(
      () => save(post, 5, "published", [], "Revoked edit"),
      /membership/,
    );
    await as(null);
    await assert.rejects(
      () => db.query("select * from public.posts"),
      /permission denied/,
    );
    assert.equal(await count("storage.objects"), 0);
  } finally {
    await db.close();
  }
});
