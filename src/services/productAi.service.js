import { Category } from "../models/category.model.js";
import { GENDERS } from "../models/product.model.js";
import * as Cloudflare from "./cloudflare.service.js";
import * as Gemini from "./gemini.service.js";
import { MAX_IMAGE_BYTES, sniffImageType } from "./image.service.js";
import { AppError, badGateway, conflict, unprocessable } from "../utils/errors.js";

// AI help for the product form, powered by Google Gemini: analyzeProductImage reads a product photo
// already uploaded to R2 and drafts the product details. It returns a draft only; nothing is saved
// to a product here.

// --- Shared helpers -----------------------------------------------------------------------------

// One AI job per photo at a time, so double-clicks or two tabs can't run (and bill) the same work twice.
const running = new Set();
async function exclusive(key, fn) {
  if (running.has(key)) throw conflict("AI is already working on this photo. Please wait for it to finish.");
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

/** Downloads one of our R2 product photos for the AI. */
async function loadImage(url) {
  if (!Cloudflare.isOwnImageUrl(url)) throw unprocessable("Only photos uploaded to FunkyKidz image storage can be used.");
  let res;
  try {
    res = await fetch(Cloudflare.signImageUrl(url), { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw badGateway("Couldn't load the product photo from image storage.");
  }
  if (!res.ok) throw badGateway(`Couldn't load the product photo from image storage (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw unprocessable("The product photo is larger than 10 MB.");
  const mimeType = sniffImageType(buffer);
  if (!mimeType) throw unprocessable("The product photo must be a JPG, PNG or WebP image.");
  return { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } };
}

const clip = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+\n/g, "\n").slice(0, max) : "");

function assertNotBlocked(data, what) {
  const reason = Gemini.blockedReason(data);
  if (reason) {
    throw new AppError(422, "AI_BLOCKED", `The AI declined to ${what} (${reason}). Try again, or use a clearer photo of the product on its own.`, { reason });
  }
}

// --- Product details ----------------------------------------------------------------------------

// Fields the AI may fill. The admin reviews every value before saving.
const REVIEW_FIELDS = [
  "name", "shortDescription", "description", "category", "productType", "gender", "color", "pattern",
  "neckType", "sleeveType", "fabric", "fit", "care", "ageGroup", "occasion",
];

function analysisSchema(categoryNames) {
  const text = (description) => ({ type: "string", description });
  return {
    type: "object",
    properties: {
      isClothing: { type: "boolean", description: "True if the photo shows a children's clothing item or outfit." },
      name: text("Product name, 3–9 words, e.g. \"Girls' Pastel Hanbok Dress with Ribbon Tie\". No brand names, no sizes, no prices."),
      shortDescription: text("One appealing sentence for product cards, max 160 characters."),
      description: text("2–3 short paragraphs for the product page: look, design details, styling and occasions. Only claims visible in the photo."),
      category: { type: "string", enum: [...categoryNames, ""], description: "Best matching existing category, or empty if none fits." },
      productType: text("Garment type, e.g. Hanbok set, Frock, Party dress, Kurta set, T-shirt, Shorts."),
      gender: { type: "string", enum: [...GENDERS, ""] },
      colorName: text("Main colour as a simple shop colour name, e.g. Mint, Rose, Navy."),
      colorHex: text("Main colour as #RRGGBB."),
      pattern: text("Pattern and design details, e.g. Solid with floral embroidery, Gold foil print."),
      neckType: text("e.g. Round neck, V-neck, Collared, Crossover (hanbok) collar. Empty if not visible."),
      sleeveType: text("e.g. Long sleeves, Short puff sleeves, Sleeveless. Empty if not visible."),
      fabric: text("Only a visual description when clearly identifiable, e.g. Tulle overlay, Denim, Satin-finish fabric. Never fibre percentages. Empty if unsure."),
      fit: text("Visible silhouette only, e.g. A-line, Relaxed fit, Flared. No measurements. Empty if unsure."),
      care: text("Only if a care label is readable in the photo; otherwise empty."),
      ageGroup: text("Rough age range the garment looks made for, e.g. 1–3 years, 4–6 years."),
      occasion: text("Style and occasions, e.g. Festive, Birthday party, Everyday casual."),
      needsReview: {
        type: "array",
        items: { type: "string", enum: REVIEW_FIELDS },
        description: "Every field that is a guess or that the admin must confirm (always include ageGroup and any fabric/fit value).",
      },
    },
    required: ["isClothing", "name", "shortDescription", "description", "category", "productType", "gender", "colorName", "colorHex",
      "pattern", "neckType", "sleeveType", "fabric", "fit", "care", "ageGroup", "occasion", "needsReview"],
  };
}

const ANALYSIS_PROMPT = `You write product listings for FunkyKidz, a premium Korean-style kidswear shop in India (ages 0–15).
Study the product photo(s) and draft the listing fields.

Rules:
- Describe only what is visible. Never invent fabric composition or percentages, measurements, sizes, washing instructions, certifications, brand names or country of origin.
- If a detail can't be determined reliably from the photo, return an empty string for it and list the field in needsReview.
- Warm, clear, natural English suitable for parents; SEO-friendly (use natural keywords like "kids", "girls"/"boys", the garment type and occasion) without keyword stuffing, no emojis, no ALL CAPS, no exaggerated claims.
- If the photo isn't children's clothing, set isClothing to false and leave the other fields empty.`;

/**
 * Drafts product details from an uploaded photo. `hints` (anything the admin already typed) is
 * passed along as context so the AI can stay consistent with it.
 */
export async function analyzeProductImage({ imageUrl, hints = {} }, log) {
  return exclusive(`analyze:${imageUrl}`, async () => {
    const [image, categories] = await Promise.all([
      loadImage(imageUrl),
      Category.find({ status: "active" }, { projection: { name: 1 }, sort: { sortOrder: 1, name: 1 } }),
    ]);
    const known = Object.entries(hints).filter(([, v]) => typeof v === "string" && v.trim());
    const context = known.length ? `\n\nInformation the admin already entered (keep consistent with it):\n${known.map(([k, v]) => `- ${k}: ${v.slice(0, 300)}`).join("\n")}` : "";

    const { model, data } = await Gemini.generateContent(
      Gemini.analysisModels(),
      {
        contents: [{ role: "user", parts: [image, { text: ANALYSIS_PROMPT + context }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: analysisSchema(categories.map((c) => c.name)), temperature: 0.4 },
      },
      { timeoutMs: 60_000, log },
    );
    assertNotBlocked(data, "describe this photo");

    let raw;
    try {
      raw = JSON.parse(Gemini.parts(data).filter((p) => p.text && !p.thought).map((p) => p.text).join(""));
    } catch {
      throw badGateway("The AI returned an unreadable answer. Please try again.");
    }
    if (!raw.isClothing) throw unprocessable("This photo doesn't look like a clothing product. Upload a clear photo of the garment.");

    const category = categories.find((c) => c.name === raw.category);
    const hex = /^#[0-9a-f]{6}$/i.test(raw.colorHex ?? "") ? raw.colorHex.toLowerCase() : null;
    const colorName = clip(raw.colorName, 40).replace(/[.$]/g, "");
    const needsReview = [...new Set((raw.needsReview ?? []).filter((f) => REVIEW_FIELDS.includes(f)))];
    if (raw.category && !category) needsReview.push("category");

    return {
      model,
      suggestions: {
        name: clip(raw.name, 120),
        shortDescription: clip(raw.shortDescription, 200),
        description: clip(raw.description, 5000),
        categoryId: category?._id.toHexString() ?? "",
        category: category?.name ?? "",
        gender: GENDERS.includes(raw.gender) ? raw.gender : "",
        color: colorName ? { name: colorName, hex } : null,
        fabric: clip(raw.fabric, 300),
        fit: clip(raw.fit, 300),
        care: clip(raw.care, 300),
        attributes: {
          productType: clip(raw.productType, 100),
          pattern: clip(raw.pattern, 100),
          neckType: clip(raw.neckType, 100),
          sleeveType: clip(raw.sleeveType, 100),
          ageGroup: clip(raw.ageGroup, 100),
          occasion: clip(raw.occasion, 100),
        },
      },
      needsReview,
    };
  });
}

export function status() {
  return { configured: Gemini.isConfigured(), analysisModels: Gemini.analysisModels() };
}
