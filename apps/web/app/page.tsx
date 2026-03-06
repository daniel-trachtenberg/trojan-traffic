import { getPublicEnvironment } from "@/lib/env";
import { MvpDashboard } from "@/components/mvp-dashboard";

export default function HomePage() {
  const env = getPublicEnvironment();

  return (
    <MvpDashboard
      hlsUrl={env.NEXT_PUBLIC_HLS_URL}
      visionApiUrl={env.NEXT_PUBLIC_VISION_API_URL}
    />
  );
}
