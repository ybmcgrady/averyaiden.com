export const MAX_PHOTOS = 20;
export const MAX_TITLE = 120;
export const MAX_BODY = 20000;

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function validateEntry(entry, status) {
  if (!validDate(entry.event_date))
    throw new Error("Choose a valid date for your story.");
  if ((entry.title || "").length > MAX_TITLE)
    throw new Error("Keep the title under 120 characters.");
  if ((entry.body || "").length > MAX_BODY)
    throw new Error("Keep your story under 20,000 characters.");
  if ((entry.photos || []).length > MAX_PHOTOS)
    throw new Error("Choose up to 20 photos per story.");
  if (!["draft", "published"].includes(status))
    throw new Error("Invalid story status.");
  if (
    status === "published" &&
    !(entry.body || "").trim() &&
    !entry.photos?.length
  ) {
    throw new Error("Write a few words or add a photo before publishing.");
  }
}

export function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      b.event_date.localeCompare(a.event_date) ||
      b.created_at.localeCompare(a.created_at),
  );
}

export function filterEntries(
  entries,
  { mode = "published", author = "all", query = "", userId } = {},
) {
  const search = query.trim().toLocaleLowerCase();
  return sortEntries(
    entries.filter((entry) => {
      if (mode === "trash" ? !entry.deleted_at : Boolean(entry.deleted_at))
        return false;
      if (
        mode === "draft" &&
        (entry.status !== "draft" || entry.author_id !== userId)
      )
        return false;
      if (mode === "published" && entry.status !== "published") return false;
      if (author !== "all" && entry.author_id !== author) return false;
      return (
        !search ||
        `${entry.title}\n${entry.body}\n${entry.caption || ""}`
          .toLocaleLowerCase()
          .includes(search)
      );
    }),
  );
}

export function displayDate(value) {
  if (!validDate(value)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function conflictError() {
  return new Error(
    "This story changed on another device. Your text is still here. Copy your changes, then reopen the story before saving again.",
  );
}
