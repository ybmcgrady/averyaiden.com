import { config } from "./config.js";
import {
  DeviceStore,
  CloudStore,
  connectCloud,
  friendlyError,
} from "./lib/store.js";
import {
  MAX_PHOTOS,
  localDate,
  filterEntries,
  displayDate,
} from "./lib/model.js";
import { preparePhoto } from "./lib/photos.js";

const $ = (selector) => document.querySelector(selector);
const blankEntry = () => ({
  title: "",
  body: "",
  caption: "",
  event_date: localDate(),
  status: "draft",
  photos: [],
  previousPhotos: [],
});
let client, store, authUser, editor, story;
let entries = [],
  routeName = "home",
  routeKey = "home",
  returnRoute = "journal";
let dirty = false,
  saving = false,
  processing = false,
  revision = 0,
  autosaveTimer,
  routeSuppressed = false,
  booted = false;
let visibleCount = 24,
  mediaEpoch = 0,
  sessionEpoch = 0,
  listEpoch = 0;
const urls = new Map();
let passwordSetup = ["invite", "recovery"].includes(
  new URLSearchParams(location.hash.slice(1)).get("type"),
);
const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey);

function notice(message, error = false) {
  $("#app-notice").textContent = message;
  $("#app-notice").classList.toggle("is-error", error);
  $("#app-notice").hidden = !message;
}
function formError(selector, message = "") {
  $(selector).textContent = message;
  $(selector).hidden = !message;
}
function message(error) {
  return friendlyError(error).message;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clearMedia() {
  mediaEpoch++;
  urls.forEach((promise) =>
    promise.then((url) => URL.revokeObjectURL(url)).catch(() => {}),
  );
  urls.clear();
}
async function imageURL(photo, small) {
  const key = `${photo.id}:${small}`;
  if (!urls.has(key)) {
    const epoch = mediaEpoch;
    const currentStore = store;
    const promise = (async () => {
      const blob = photo.blob
        ? small
          ? photo.thumbnail
          : photo.blob
        : await currentStore.imageBlob(photo, small);
      if (epoch !== mediaEpoch) throw new Error("Photo request expired.");
      if (!(blob instanceof Blob)) throw new Error("Photo unavailable.");
      return URL.createObjectURL(blob);
    })();
    urls.set(key, promise);
    promise.catch(() => {
      if (urls.get(key) === promise) urls.delete(key);
    });
  }
  return urls.get(key);
}
const pendingImages = new WeakMap();
const observer =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (records) => {
          for (const record of records)
            if (record.isIntersecting) {
              observer.unobserve(record.target);
              pendingImages.get(record.target)?.();
            }
        },
        { rootMargin: "300px" },
      )
    : null;
function photoFrame(photo, small, caption = "") {
  const frame = element("div", "photo-frame");
  const image = document.createElement("img");
  image.alt = caption || "A photo from this family story";
  image.loading = "lazy";
  image.decoding = "async";
  if (photo.width && photo.height) {
    image.width = photo.width;
    image.height = photo.height;
  }
  frame.append(image);
  const load = async () => {
    try {
      const url = await imageURL(photo, small);
      if (frame.isConnected) image.src = url;
    } catch {
      if (frame.isConnected)
        frame.replaceChildren(
          element(
            "span",
            "photo-error",
            "Photo unavailable. Use Refresh to try again.",
          ),
        );
    }
  };
  image.addEventListener("error", () =>
    frame.replaceChildren(
      element("span", "photo-error", "This photo could not be displayed."),
    ),
  );
  if (observer) {
    pendingImages.set(frame, load);
    observer.observe(frame);
  } else queueMicrotask(load);
  return frame;
}
function showView(id) {
  document.querySelectorAll("[data-app-view]").forEach((view) => {
    view.hidden = view.id !== id;
  });
  document.querySelectorAll(".main-nav a").forEach((link) => {
    const active =
      link.hash === `#${routeName}` ||
      (link.id === "account-link" && routeName === "account");
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#device-banner").hidden = store?.mode !== "device";
  $("#account-link").href = store || authUser ? "#account" : "#signin";
  $("#account-link").textContent = store
    ? `Hi, ${store.member.display_name}`
    : authUser
      ? "My account"
      : "Family sign in ↗";
}
function go(route) {
  if (location.hash === `#${route}`) void navigate();
  else location.hash = route;
}
function restoreHash() {
  routeSuppressed = true;
  location.hash = routeKey;
}
async function navigate() {
  if (!booted) return;
  if (routeSuppressed) {
    routeSuppressed = false;
    return;
  }
  let requested = location.hash.slice(1) || "home";
  if (requested === "explore") requested = "home";
  if (requested !== routeKey && (saving || processing)) {
    notice("Please wait for your story or photos to finish saving.");
    restoreHash();
    return;
  }
  if (
    requested !== routeKey &&
    dirty &&
    !confirm("Leave without saving your latest changes?")
  ) {
    restoreHash();
    return;
  }
  if (requested !== routeKey) {
    clearTimeout(autosaveTimer);
    dirty = false;
  }
  const [name, id] = requested.split("/");
  routeName = name;
  routeKey = requested;
  if (!["home", "signin", "account"].includes(name) && !store) {
    returnRoute = requested;
    routeName = "signin";
    showView("signin-view");
    return;
  }
  observer?.disconnect();
  if (name === "home") showView("home-view");
  else if (name === "signin") {
    if (store) {
      go("account");
      return;
    }
    showView("signin-view");
  } else if (["journal", "drafts", "trash", "photos"].includes(name)) {
    visibleCount = 24;
    showView("journal-view");
    renderList();
  } else if (name === "write") {
    const existing = id ? entries.find((entry) => entry.id === id) : null;
    if (
      id &&
      (!existing ||
        existing.author_id !== store.member.user_id ||
        existing.deleted_at)
    ) {
      notice("This story is unavailable for editing.", true);
      go("journal");
      return;
    }
    editor = existing
      ? {
          ...existing,
          photos: [...existing.photos],
          previousPhotos: [...existing.photos],
        }
      : blankEntry();
    revision = 0;
    dirty = false;
    $("#entry-title").value = editor.title;
    $("#entry-body").value = editor.body;
    $("#entry-caption").value = editor.caption;
    $("#entry-date").value = editor.event_date;
    $("#entry-files").value = "";
    $("#editor-author").textContent =
      `Written by ${store.member.display_name}${store.mode === "device" ? " · Device demo" : ""}`;
    $("#editor-view .privacy-tag").textContent =
      store.mode === "device" ? "This browser only" : "Family only";
    $("#publish-entry").textContent =
      editor.status === "published" ? "Save changes ↗" : "Publish story ↗";
    $("#save-draft").hidden = editor.status === "published";
    $("#save-status").textContent = editor.id ? "Saved" : "Not saved yet";
    formError("#editor-error");
    renderEditorPhotos();
    showView("editor-view");
  } else if (name === "entry") {
    story = entries.find((entry) => entry.id === id);
    if (!story) {
      notice("This story is no longer available. Refresh your journal.", true);
      go("journal");
      return;
    }
    renderStory();
    showView("entry-view");
  } else if (name === "account") {
    if (!store && !authUser) {
      go("signin");
      return;
    }
    $("#member-name").textContent = store?.member.display_name || "friend";
    $("#account-description").textContent =
      store?.mode === "device"
        ? "Your demo is saved only in this browser. Clearing browser data will remove it. Family sharing becomes available after the site is connected."
        : passwordSetup
          ? "Choose a password to finish setting up your family sign-in."
          : "Your private corner of the family journal. You can update your password here.";
    $("#password-form").hidden =
      !client || !authUser || store?.mode === "device";
    $("#signout").textContent =
      store?.mode === "device" ? "Leave device demo" : "Sign out";
    showView("account-view");
  } else {
    go("home");
    return;
  }
  if (location.hash !== "#explore")
    window.scrollTo({ top: 0, behavior: "instant" });
  const heading = document.querySelector("[data-app-view]:not([hidden]) h1");
  if (heading && name !== "home") {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

async function refreshEntries() {
  if (!store) return;
  const currentStore = store,
    epoch = ++listEpoch;
  const result = await currentStore.list();
  if (store !== currentStore || epoch !== listEpoch) return;
  entries = result;
}
function updateAuthorFilter() {
  const selected = $("#author-filter").value;
  const authors = [
    ...new Map(
      entries.map((entry) => [
        entry.author_id,
        entry.author_name || store.member.display_name,
      ]),
    ).entries(),
  ];
  $("#author-filter").replaceChildren(
    new Option("Everyone", "all"),
    ...authors.map(([id, name]) => new Option(name, id)),
  );
  $("#author-filter").value = authors.some(([id]) => id === selected)
    ? selected
    : "all";
}
function renderList() {
  if (!store) return;
  updateAuthorFilter();
  const mode =
    routeName === "drafts"
      ? "draft"
      : routeName === "trash"
        ? "trash"
        : "published";
  const photosOnly = routeName === "photos";
  const titles = {
    journal: "Our family journal.",
    drafts: "Little stories in progress.",
    trash: "A second chance.",
    photos: "Life, in pictures.",
  };
  $("#journal-title").textContent = titles[routeName];
  $("#journal-description").textContent =
    routeName === "drafts"
      ? "Your drafts are just for you, until you publish."
      : routeName === "trash"
        ? "Moved a story by mistake? Restore it here. Nothing here is automatically erased."
        : photosOnly
          ? "Every photo has a story. Open one to read it."
          : "Big adventures. Small discoveries. A little bit of us.";
  document.querySelectorAll(".journal-tabs a").forEach((link) => {
    if (link.hash === `#${routeName}`)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const filtered = filterEntries(entries, {
    mode,
    author: $("#author-filter").value,
    query: $("#search-entries").value,
    userId: store.member.user_id,
  });
  const items = photosOnly
    ? filtered.flatMap((entry) =>
        entry.photos.map((photo) => ({ entry, photo })),
      )
    : filtered.map((entry) => ({ entry }));
  const list = $("#entry-list");
  list.classList.toggle("photo-library", photosOnly);
  list.replaceChildren();
  for (const { entry, photo } of items.slice(0, visibleCount)) {
    const article = element("article", "journal-entry");
    const link = element("a", "entry-card-link");
    link.href = `#entry/${entry.id}`;
    const pictures = element("div", "entry-pictures");
    const selectedPhotos = photo ? [photo] : entry.photos.slice(0, 2);
    for (const item of selectedPhotos)
      pictures.append(photoFrame(item, true, entry.caption));
    if (!selectedPhotos.length) {
      const art = element("div", "text-story-art", "✳");
      art.setAttribute("aria-hidden", "true");
      pictures.append(art);
    }
    link.append(
      pictures,
      element(
        "p",
        "entry-byline",
        `${entry.author_name || store.member.display_name} / ${displayDate(entry.event_date)}`,
      ),
      element("h2", "", entry.title || "A little moment."),
    );
    if (!photosOnly && entry.body)
      link.append(
        element(
          "p",
          "",
          entry.body.slice(0, 200) + (entry.body.length > 200 ? "…" : ""),
        ),
      );
    const foot = element("div", "entry-foot");
    foot.append(
      element(
        "span",
        "",
        mode === "draft"
          ? "Draft · Only you"
          : `${entry.photos.length} ${entry.photos.length === 1 ? "photo" : "photos"}`,
      ),
      element(
        "span",
        "",
        mode === "trash" ? "Open to restore ↗" : "Read our story ↗",
      ),
    );
    link.append(foot);
    article.append(link);
    list.append(article);
  }
  $("#results-note").textContent = items.length
    ? `${Math.min(visibleCount, items.length)} of ${items.length} ${photosOnly ? "photos" : "stories"}`
    : "";
  $("#load-more").hidden = items.length <= visibleCount;
  $("#journal-empty").hidden = items.length !== 0;
  const searching =
    $("#search-entries").value.trim() || $("#author-filter").value !== "all";
  $("#empty-title").textContent = searching
    ? "No memories found."
    : mode === "trash"
      ? "Nothing in the trash."
      : photosOnly
        ? "A little room for your photos."
        : mode === "draft"
          ? "No unfinished stories."
          : "Every story starts somewhere.";
  $("#empty-description").textContent = searching
    ? "Try another word or choose Everyone."
    : mode === "trash"
      ? "Stories you move to the trash will appear here."
      : "A sentence, a photo, a small adventure. Keep a little memory.";
  $("#empty-action").hidden = Boolean(searching) || mode === "trash";
}
function renderStory() {
  $("#story-title").textContent = story.title || "A little moment.";
  $("#story-meta").textContent =
    `${story.author_name || store.member.display_name} / ${displayDate(story.event_date)}${story.status === "draft" ? " / DRAFT" : ""}${story.deleted_at ? " / IN TRASH" : ""}`;
  $("#story-body").textContent = story.body;
  $("#story-body").hidden = !story.body;
  $("#story-caption").textContent = story.caption;
  $("#story-photos").replaceChildren(
    ...story.photos.map((photo) => photoFrame(photo, false, story.caption)),
  );
  $("#entry-view .privacy-tag").textContent =
    store.mode === "device"
      ? "This browser only"
      : story.status === "draft"
        ? "Draft · Only you"
        : "Family only";
  const own = story.author_id === store.member.user_id;
  const canManage =
    own || (store.member.role === "admin" && story.status === "published");
  $("#edit-story").hidden = !own || Boolean(story.deleted_at);
  $("#edit-story").href = `#write/${story.id}`;
  $("#trash-story").hidden = !canManage || Boolean(story.deleted_at);
  $("#restore-story").hidden = !canManage || !story.deleted_at;
}
function readEditor() {
  return {
    ...editor,
    title: $("#entry-title").value,
    body: $("#entry-body").value,
    caption: $("#entry-caption").value,
    event_date: $("#entry-date").value,
    photos: [...editor.photos],
  };
}
function markDirty() {
  dirty = true;
  revision++;
  $("#save-status").textContent = "Unsaved changes";
  clearTimeout(autosaveTimer);
  if (editor?.status === "draft")
    autosaveTimer = setTimeout(() => {
      if (!saving && !processing && dirty) void saveEditor("draft", true);
    }, 1600);
}
function updateEditorBusy() {
  $("#publish-entry").disabled = saving || processing;
  $("#save-draft").disabled = saving || processing;
  $("#entry-files").disabled = saving || processing;
  document.querySelectorAll("#editor-photos button").forEach((button) => {
    button.disabled =
      saving || processing || button.dataset.boundary === "true";
  });
}
function renderEditorPhotos() {
  $("#editor-photos").replaceChildren(
    ...editor.photos.map((photo, index) => {
      const item = element("div", "editor-photo");
      const actions = element("div", "photo-actions");
      for (const [label, offset] of [
        ["Move earlier", -1],
        ["Move later", 1],
      ]) {
        const button = element("button", "", offset === -1 ? "←" : "→");
        button.type = "button";
        button.setAttribute("aria-label", `${label}: photo ${index + 1}`);
        button.dataset.boundary = String(
          index + offset < 0 || index + offset >= editor.photos.length,
        );
        button.addEventListener("click", () => {
          [editor.photos[index], editor.photos[index + offset]] = [
            editor.photos[index + offset],
            editor.photos[index],
          ];
          renderEditorPhotos();
          markDirty();
        });
        actions.append(button);
      }
      const remove = element("button", "", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove photo ${index + 1}`);
      remove.addEventListener("click", () => {
        editor.photos.splice(index, 1);
        renderEditorPhotos();
        markDirty();
      });
      actions.append(remove);
      item.append(photoFrame(photo, true, `Photo ${index + 1}`), actions);
      return item;
    }),
  );
  updateEditorBusy();
}
async function saveEditor(status, automatic = false) {
  if (!editor || saving || processing || !store) return;
  clearTimeout(autosaveTimer);
  const snapshot = readEditor(),
    savedRevision = revision;
  const savingStore = store;
  // Avoid creating a blank draft simply by visiting the editor.
  if (
    automatic &&
    !snapshot.id &&
    !snapshot.title.trim() &&
    !snapshot.body.trim() &&
    !snapshot.photos.length
  )
    return;
  saving = true;
  updateEditorBusy();
  formError("#editor-error");
  $("#save-status").textContent = "Saving…";
  try {
    const saved = await savingStore.save(snapshot, status, (draft) => {
      if (store === savingStore && editor) {
        editor.id = draft.id;
        editor.version = draft.version;
      }
    });
    if (store !== savingStore || !editor) return;
    const currentInputs = readEditor();
    editor = { ...saved, previousPhotos: [...saved.photos] };
    if (savedRevision !== revision)
      Object.assign(editor, {
        title: currentInputs.title,
        body: currentInputs.body,
        caption: currentInputs.caption,
        event_date: currentInputs.event_date,
      });
    dirty = savedRevision !== revision;
    $("#save-status").textContent = dirty
      ? "New changes not saved yet"
      : status === "draft"
        ? "Draft saved"
        : "Saved";
    entries = [
      ...entries.filter((entry) => entry.id !== saved.id),
      { ...saved, author_name: store.member.display_name },
    ];
    // Reuse this draft after reload, without resetting the form or cursor.
    if (status === "draft") {
      routeKey = `write/${saved.id}`;
      history.replaceState(null, "", `#${routeKey}`);
    }
    if (!dirty && status === "published") {
      saving = false;
      updateEditorBusy();
      notice(
        store.mode === "device"
          ? "Story saved on this device. It is not shared with family."
          : "Your little story is published.",
      );
      go(`entry/${saved.id}`);
      return;
    }
    renderEditorPhotos();
  } catch (error) {
    if (store !== savingStore || !editor) return;
    $("#save-status").textContent = "Not saved";
    dirty = true;
    formError("#editor-error", message(error));
  } finally {
    saving = false;
    updateEditorBusy();
    if (dirty && savedRevision !== revision && editor?.status === "draft") {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => void saveEditor("draft", true), 1600);
    }
  }
}
function clearPrivateData() {
  clearTimeout(autosaveTimer);
  observer?.disconnect();
  clearMedia();
  listEpoch++;
  store?.close();
  store = null;
  entries = [];
  editor = null;
  story = null;
  dirty = false;
  $("#editor-form").reset();
  $("#editor-photos").replaceChildren();
  $("#entry-list").replaceChildren();
  for (const id of [
    "story-title",
    "story-meta",
    "story-body",
    "story-caption",
    "story-photos",
  ])
    $(`#${id}`).replaceChildren();
  $("#member-name").textContent = "friend";
  $("#editor-author").textContent = "";
  $("#search-entries").value = "";
  $("#author-filter").replaceChildren(new Option("Everyone", "all"));
  $("#password-form").reset();
  $("#signin-form").reset();
}
async function leave() {
  if (saving || processing) {
    notice("Please wait for saving to finish.");
    return;
  }
  if (dirty && !confirm("Sign out without saving your latest changes?")) return;
  try {
    if (store?.mode !== "device" && client && authUser) {
      const result = await client.auth.signOut();
      if (result.error) throw result.error;
    }
    sessionStorage.removeItem("aa-device-demo");
    clearPrivateData();
    authUser = null;
    notice("");
    go("home");
  } catch (error) {
    notice(message(error), true);
  }
}
async function useSession(session, event = "") {
  const epoch = ++sessionEpoch;
  authUser = session?.user || null;
  if (event === "PASSWORD_RECOVERY") passwordSetup = true;
  if (!session) {
    if (store?.mode === "cloud") {
      clearPrivateData();
      notice("You have been signed out.");
      go("signin");
    }
    return;
  }
  const { data: member, error } = await client
    .from("family_members")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (epoch !== sessionEpoch) return;
  if (error)
    throw new Error(
      "Family sign-in could not finish. Ask the site owner to check the setup.",
    );
  if (!member?.active) {
    clearPrivateData();
    authUser = session.user;
    formError(
      "#signin-error",
      "This account has not been added to the family. Ask the site owner for an invitation.",
    );
    if (passwordSetup) go("account");
    else go("signin");
    return;
  }
  if (store?.mode !== "cloud" || store.member.user_id !== member.user_id) {
    clearPrivateData();
    authUser = session.user;
    store = new CloudStore(client, member);
    sessionStorage.removeItem("aa-device-demo");
    await refreshEntries();
  } else store.member = member;
  if (passwordSetup) go("account");
  else if (["signin", "home"].includes(routeName) && event === "SIGNED_IN")
    go(returnRoute);
}

window.addEventListener("hashchange", () => void navigate());
window.addEventListener("beforeunload", (event) => {
  if (dirty || saving || processing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("#search-entries").addEventListener("input", () => {
  visibleCount = 24;
  observer?.disconnect();
  renderList();
});
$("#author-filter").addEventListener("change", () => {
  visibleCount = 24;
  observer?.disconnect();
  renderList();
});
$("#load-more").addEventListener("click", () => {
  visibleCount += 24;
  observer?.disconnect();
  renderList();
});
$("#refresh-entries").addEventListener("click", async () => {
  $("#refresh-entries").disabled = true;
  try {
    clearMedia();
    await refreshEntries();
    renderList();
    notice("");
  } catch (error) {
    notice(message(error), true);
  } finally {
    $("#refresh-entries").disabled = false;
  }
});
$("#start-demo").addEventListener("click", async () => {
  $("#start-demo").disabled = true;
  try {
    if (client && authUser) {
      const result = await client.auth.signOut();
      if (result.error) throw result.error;
      authUser = null;
    }
    clearPrivateData();
    store = await new DeviceStore().open();
    sessionStorage.setItem("aa-device-demo", "true");
    await refreshEntries();
    notice("");
    go(returnRoute);
  } catch (error) {
    clearPrivateData();
    formError("#signin-error", message(error));
  } finally {
    $("#start-demo").disabled = false;
  }
});
$("#signout").addEventListener("click", () => void leave());
$("#leave-demo").addEventListener("click", () => void leave());
$("#editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveEditor("published");
});
$("#save-draft").addEventListener("click", () => void saveEditor("draft"));
for (const id of ["entry-title", "entry-body", "entry-caption", "entry-date"])
  $(`#${id}`).addEventListener("input", markDirty);
$("#entry-files").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  if (!files.length || !editor) return;
  if (editor.photos.length + files.length > MAX_PHOTOS) {
    formError("#editor-error", "Choose up to 20 photos per story.");
    return;
  }
  processing = true;
  updateEditorBusy();
  clearTimeout(autosaveTimer);
  formError("#editor-error");
  const processingEditor = editor,
    processingStore = store;
  $("#photo-progress").hidden = false;
  const failures = [];
  for (let index = 0; index < files.length; index++) {
    $("#photo-progress").textContent =
      `Preparing photo ${index + 1} of ${files.length}…`;
    try {
      const photo = await preparePhoto(files[index]);
      if (editor !== processingEditor || store !== processingStore) break;
      editor.photos.push(photo);
    } catch (error) {
      failures.push(`${files[index].name}: ${message(error)}`);
    }
  }
  processing = false;
  $("#photo-progress").hidden = true;
  updateEditorBusy();
  if (editor !== processingEditor || store !== processingStore) return;
  renderEditorPhotos();
  markDirty();
  if (failures.length) formError("#editor-error", failures.join("\n"));
});
for (const [id, deleted] of [
  ["trash-story", true],
  ["restore-story", false],
])
  $(`#${id}`).addEventListener("click", async () => {
    if (saving || !story) return;
    saving = true;
    $(`#${id}`).disabled = true;
    try {
      await store.setDeleted(story, deleted);
      await refreshEntries();
      saving = false;
      notice(
        deleted
          ? "Story moved to the trash. You can restore it there."
          : "Your story is back.",
      );
      go(deleted ? "trash" : "journal");
    } catch (error) {
      notice(message(error), true);
    } finally {
      saving = false;
      $(`#${id}`).disabled = false;
    }
  });
const prompts = [
  "What made you laugh today?",
  "What did you discover together?",
  "What is one little thing you want to remember?",
];
let promptIndex = 0;
$("#next-prompt").addEventListener("click", () => {
  promptIndex = (promptIndex + 1) % prompts.length;
  $("#writing-prompt").textContent = prompts[promptIndex];
});
$("#signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client) return;
  const button = $("#signin-form button[type=submit]");
  button.disabled = true;
  formError("#signin-error");
  try {
    const result = await client.auth.signInWithPassword({
      email: $("#signin-email").value.trim(),
      password: $("#signin-password").value,
    });
    $("#signin-password").value = "";
    if (result.error)
      throw new Error(
        "Could not sign in. Check your email and password, then try again.",
      );
    await useSession(result.data.session, "SIGNED_IN");
  } catch (error) {
    formError("#signin-error", message(error));
  } finally {
    button.disabled = false;
  }
});
$("#reset-password").addEventListener("click", async () => {
  if (!client) return;
  if (!$("#signin-email").value || !$("#signin-email").checkValidity()) {
    formError("#signin-error", "Enter your email address first.");
    return;
  }
  $("#reset-password").disabled = true;
  try {
    const redirectTo = new URL("./", location.href).href;
    const result = await client.auth.resetPasswordForEmail(
      $("#signin-email").value.trim(),
      { redirectTo },
    );
    if (result.error)
      throw new Error(
        "The reset email could not be sent. Please try again later.",
      );
    formError("#signin-error");
    notice(
      "If this email belongs to an account, a password reset link will arrive shortly.",
    );
  } catch (error) {
    formError("#signin-error", message(error));
  } finally {
    $("#reset-password").disabled = false;
  }
});
$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#new-password").value !== $("#confirm-password").value) {
    formError("#account-error", "The passwords do not match.");
    return;
  }
  const button = $("#password-form button");
  button.disabled = true;
  try {
    const result = await client.auth.updateUser({
      password: $("#new-password").value,
    });
    if (result.error) throw result.error;
    passwordSetup = false;
    $("#password-form").reset();
    formError("#account-error");
    notice("Your password is set.");
    if (store) go("journal");
  } catch (error) {
    formError("#account-error", message(error));
  } finally {
    button.disabled = false;
  }
});

async function boot() {
  try {
    client = await connectCloud(config);
    if (client) {
      $("#setup-note").textContent =
        "Sign in with the account invited by your family.";
      $("#signin-form").hidden = false;
      client.auth.onAuthStateChange((event, session) => {
        if (!booted || event === "INITIAL_SESSION") return;
        // Run outside the Auth callback lock before querying the database.
        setTimeout(() => {
          void useSession(session, event).catch((error) => {
            notice(message(error), true);
          });
        }, 0);
      });
      const result = await client.auth.getSession();
      if (result.error) throw result.error;
      if (result.data.session) await useSession(result.data.session);
    }
    if (
      !store &&
      !authUser &&
      sessionStorage.getItem("aa-device-demo") === "true"
    ) {
      store = await new DeviceStore().open();
      await refreshEntries();
    }
  } catch (error) {
    if (configured)
      $("#setup-note").textContent =
        "Family sign-in is temporarily unavailable. Please try again later.";
    notice(message(error), true);
  } finally {
    booted = true;
    if (passwordSetup && authUser) go("account");
    else await navigate();
  }
}
void boot();
