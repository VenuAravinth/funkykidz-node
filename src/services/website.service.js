import { env } from "../config/env.js";
import { invalidatePublicCache } from "./public.service.js";

// Tells the website to drop its cached catalogue so a publish/unpublish/edit shows on the shop
// straight away (the website otherwise refreshes on its own within 60 seconds).
// Bursts of changes (bulk edits) are coalesced into a single call.

const DEBOUNCE_MS = 250;
let timer = null;

export function notifyWebsite(log) {
  invalidatePublicCache(); // this server's storefront API answers with the change at once
  const { revalidateUrl, revalidateSecret } = env.website;
  if (!revalidateUrl || !revalidateSecret) return;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      const res = await fetch(revalidateUrl, {
        method: "POST",
        headers: { "x-revalidate-secret": revalidateSecret, "content-type": "application/json" },
        body: JSON.stringify({ tags: ["products"] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) log?.warn({ status: res.status }, "Website revalidation rejected");
    } catch (err) {
      log?.warn({ err: err.message }, "Website revalidation failed; the shop will refresh within 60s");
    }
  }, DEBOUNCE_MS);
  timer.unref?.();
}
