"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

type LiveFeedProps = {
  src: string;
};

export function LiveFeed({ src }: LiveFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState("Initializing feed...");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      setState("Native HLS stream ready.");
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
    <div className="video-shell">
      <video ref={videoRef} controls muted playsInline autoPlay />
      <div className="video-state">{state}</div>
    </div>
  );
}
