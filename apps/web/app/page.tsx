import { getPublicEnvironment } from "@/lib/env";
import { MvpDashboard } from "@/components/mvp-dashboard";
import { readStoredBettingRegion } from "@/lib/betting-region-store";

export default async function HomePage() {
  const env = getPublicEnvironment();
  const bettingRegion = await readStoredBettingRegion();

  return (
    <MvpDashboard
      hlsUrl={env.NEXT_PUBLIC_HLS_URL}
      initialRegion={bettingRegion}
      visionApiUrl={env.NEXT_PUBLIC_VISION_API_URL}
      liveCountEnabled={env.NEXT_PUBLIC_LIVE_COUNT_ENABLED}
    />
  );
}
