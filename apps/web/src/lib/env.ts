import { z } from "zod";

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_HLS_URL: z
    .string()
    .url()
    .default("https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8"),
  NEXT_PUBLIC_VISION_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_LIVE_COUNT_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1")
});

type PublicEnvironment = z.infer<typeof publicEnvironmentSchema>;

export function getPublicEnvironment(): PublicEnvironment {
  return publicEnvironmentSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_HLS_URL: process.env.NEXT_PUBLIC_HLS_URL,
    NEXT_PUBLIC_VISION_API_URL: process.env.NEXT_PUBLIC_VISION_API_URL,
    NEXT_PUBLIC_LIVE_COUNT_ENABLED: process.env.NEXT_PUBLIC_LIVE_COUNT_ENABLED
  });
}
