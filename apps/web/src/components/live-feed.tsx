"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";

type RegionPoint = {
  x: number;
  y: number;
};

type LiveFeedProps = {
  src: string;
  region?: RegionPoint[] | null;
  fullScreen?: boolean;
};

function toNormalizedPoints(points: RegionPoint[]) {
  const xScale = points.some((point) => point.x > 1) ? 1920 : 1;
  const yScale = points.some((point) => point.y > 1) ? 1080 : 1;

  return points.map((point) => ({
    x: Math.min(Math.max(point.x / xScale, 0), 1),
    y: Math.min(Math.max(point.y / yScale, 0), 1)
  }));
}

export function LiveFeed({ src, region = null, fullScreen = false }: LiveFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState("Initializing feed...");
  const normalizedRegion = region ? toNormalizedPoints(region) : null;

  let overlayStyle: CSSProperties | undefined;
  if (normalizedRegion && normalizedRegion.length >= 3) {
    const xs = normalizedRegion.map((point) => point.x);
    const ys = normalizedRegion.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    overlayStyle = {
      left: `${minX * 100}%`,
      top: `${minY * 100}%`,
      width: `${(maxX - minX) * 100}%`,
      height: `${(maxY - minY) * 100}%`
    };
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      setState("Native HLS stream ready.");
      void video.play().catch(() => {
        setState("Feed ready. Press play to begin.");
      });
      return;
    }

    if (!Hls.isSupported()) {
      setState("HLS is not supported in this browser.");
      return;
    }

    const hls = new Hls({
      liveSyncDurationCount: 3,
      maxLiveSyncPlaybackRate: 1.2
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setState("Feed connected.");
      void video.play().catch(() => {
        setState("Feed connected. Press play to begin.");
      });
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        setState("Feed error: retrying...");
        hls.startLoad();
      }
    });

    return () => {
      hls.destroy();
    };
  }, [src]);

  return (
    <div className={fullScreen ? "video-shell video-shell-fullscreen" : "video-shell"}>
      <video ref={videoRef} controls muted playsInline autoPlay />
      {overlayStyle ? <div className="region-overlay" style={overlayStyle} /> : null}
      <div className={fullScreen ? "video-state video-state-overlay" : "video-state"}>{state}</div>
    </div>
  );
}
