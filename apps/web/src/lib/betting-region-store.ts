import "server-only";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  DEFAULT_BETTING_REGION,
  normalizeBettingRegion,
  type RegionPoint
} from "@/lib/betting-region";
import { getPublicEnvironment } from "@/lib/env";

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
});

const regionRecordSchema = z.object({
  points: z.array(pointSchema).length(2)
});

export const regionPayloadSchema = z.object({
  points: z.array(pointSchema).length(2)
});

function createRegionSupabaseClient(accessToken?: string) {
  const env = getPublicEnvironment();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return null;
  }

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      : undefined
  });
}

export async function readStoredBettingRegion() {
  const supabase = createRegionSupabaseClient();
  if (!supabase) {
    return DEFAULT_BETTING_REGION;
  }

  try {
    const response = await supabase
      .from("betting_regions")
      .select("points")
      .eq("id", 1)
      .maybeSingle();

    if (response.error || !response.data) {
      return DEFAULT_BETTING_REGION;
    }

    const parsed = regionRecordSchema.parse(response.data);
    return normalizeBettingRegion(parsed.points);
  } catch {
    return DEFAULT_BETTING_REGION;
  }
}

export async function writeStoredBettingRegion(points: RegionPoint[], accessToken: string) {
  const supabase = createRegionSupabaseClient(accessToken);
  if (!supabase) {
    throw new Error("Supabase environment is not configured.");
  }

  const normalizedPoints = normalizeBettingRegion(points);
  const response = await supabase
    .from("betting_regions")
    .upsert(
      {
        id: 1,
        points: normalizedPoints
      },
      {
        onConflict: "id"
      }
    )
    .select("points")
    .single();

  if (response.error) {
    throw new Error(response.error.message);
  }

  const parsed = regionRecordSchema.parse(response.data);
  return normalizeBettingRegion(parsed.points);
}
