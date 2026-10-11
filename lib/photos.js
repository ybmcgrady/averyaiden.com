export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not prepare this photo.")),
      "image/jpeg",
      quality,
    ),
  );
}

export async function preparePhoto(file) {
  if (!ALLOWED_TYPES.has(file.type))
    throw new Error(
      "Choose JPEG, PNG, or WebP photos. Export HEIC photos as JPEG first.",
    );
  if (file.size > MAX_INPUT_BYTES)
    throw new Error("Choose photos smaller than 20 MB each.");
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "This image could not be opened. Try exporting it as JPEG.",
    );
  }
  try {
    if (source.width * source.height > 50_000_000)
      throw new Error(
        "This photo is very large. Choose a smaller copy under 50 megapixels.",
      );
    const render = async (longEdge, quality) => {
      const ratio = Math.min(
        1,
        longEdge / Math.max(source.width, source.height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(source.width * ratio));
      canvas.height = Math.max(1, Math.round(source.height * ratio));
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Photo processing is unavailable in this browser.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      let blob = await canvasBlob(canvas, quality);
      if (blob.size > 2 * 1024 * 1024) blob = await canvasBlob(canvas, 0.65);
      if (blob.size > 2 * 1024 * 1024)
        throw new Error(
          "This photo is still too large. Choose a smaller version.",
        );
      return { blob, width: canvas.width, height: canvas.height };
    };
    const full = await render(2048, 0.82);
    const small = await render(400, 0.72);
    return {
      id: crypto.randomUUID(),
      blob: full.blob,
      thumbnail: small.blob,
      width: full.width,
      height: full.height,
      byte_size: full.blob.size + small.blob.size,
    };
  } finally {
    source.close();
  }
}
