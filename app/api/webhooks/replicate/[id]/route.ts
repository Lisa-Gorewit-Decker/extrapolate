import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "edge";

const ALLOWED_OUTPUT_HOSTS = new Set(["pbxt.replicate.delivery"]);

function getValidatedOutputUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;

  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const decodedPathname = decodeURIComponent(parsed.pathname);

    if (parsed.protocol !== "https:") return null;
    if (!ALLOWED_OUTPUT_HOSTS.has(hostname)) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443") return null;
    if (!parsed.pathname.startsWith("/")) return null;
    if (decodedPathname.split("/").some((seg) => seg === "..")) return null;
    if (parsed.hash) return null;

    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const id = req.nextUrl.pathname.split("/")[4];
  const { output, status } = await req.json();

  const supabase = createAdminClient();

  // get user_id
  const { data, error } = await supabase
    .from("data")
    .select("user_id")
    .eq("id", id)
    .single();
  if (error)
    return new Response(`Error getting user_id: ${error.message}`, {
      status: 400,
    });

  // Prediction successful --> upload output to supabase storage --> update db output url --> user receives output via supabase realtime
  if (status === "succeeded") {
    const safeOutputUrl = getValidatedOutputUrl(output);
    if (!safeOutputUrl) {
      return new Response("Invalid output URL", { status: 400 });
    }

    const fetchRes = await fetch(safeOutputUrl, { redirect: "error" });
    if (!fetchRes.ok) {
      return new Response(`Failed to fetch output: ${fetchRes.status}`, {
        status: 400,
      });
    }
    const blob = await fetchRes.blob();
    const { data: storageData, error: storageError } = await supabase.storage
      .from("output")
      .upload(`/${data?.user_id}/${id}`, blob, {
        contentType: blob.type,
        cacheControl: "3600",
        upsert: true,
      });
    if (storageError)
      new Response(`Error saving output: ${storageError.message}`, {
        status: 400,
      });
    const outputURL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/output/${storageData?.path}`;

    const { error } = await supabase
      .from("data")
      .update({
        output: outputURL,
      })
      .eq("id", id);
    if (error)
      new Response(`Error updating output url: ${error.message}`, {
        status: 400,
      });
  }

  // Prediction failed --> update db --> user receives failed via supabase realtime --> user gets credits returned
  else if (status === "failed" || status === "cancelled") {
    // update db
    const { error } = await supabase
      .from("data")
      .update({ failed: true })
      .eq("id", id);
    if (error)
      new Response(`Error updating failed: ${error.message}`, { status: 400 });

    // get user_id for that prediction
    const { data, error: user_id_error } = await supabase
      .from("data")
      .select("user_id")
      .eq("id", id)
      .single();
    if (user_id_error || !data.user_id)
      new Response(`Error getting user_id: ${user_id_error?.message}`, {
        status: 400,
      });

    // if user_id exists, add 10 credits since prediction failed
    if (data?.user_id) {
      const { error } = await supabase.rpc("update_credits", {
        user_id: data.user_id,
        credit_amount: 10,
      });
      if (error)
        new Response(`Error returning credits: ${error.message}`, {
          status: 400,
        });
    }
  }

  return new Response("OK", { status: 200 });
}
