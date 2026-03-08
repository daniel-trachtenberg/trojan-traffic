"use client";

import Hls from "hls.js";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { normalizeBettingRegion, type RegionPoint } from "@/lib/betting-region";

type PersonDetectionBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

type LiveFeedProps = {
  src: string;
  region?: RegionPoint[] | null;
  fullScreen?: boolean;
  personBoxes?: PersonDetectionBox[];
  regionEditorEnabled?: boolean;
  onRegionChange?: ((points: RegionPoint[]) => void) | null;
};

function toNormalizedPoints(points: RegionPoint[]) {
  const xScale = points.some((point) => point.x > 1) ? 1920 : 1;
  const yScale = points.some((point) => point.y > 1) ? 1080 : 1;

  return normalizeBettingRegion(
    points.map((point) => ({
      x: point.x / xScale,
      y: point.y / yScale
    }))
  );
}

export function LiveFeed({
  src,
  region = null,
  fullScreen = false,
  personBoxes = [],
  regionEditorEnabled = false,
  onRegionChange = null
}: LiveFeedProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragPointIndexRef = useRef<number | null>(null);
  const [state, setState] = useState("Initializing feed...");
  const normalizedRegion = region ? toNormalizedPoints(region) : null;
  const polygonPoints = normalizedRegion
    ? normalizedRegion.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")
    : "";

  function updateRegionPoint(clientX: number, clientY: number) {
    if (
      dragPointIndexRef.current === null ||
      !shellRef.current ||
      !normalizedRegion ||
      !onRegionChange
    ) {
      return;
    }

    const bounds = shellRef.current.getBoundingClientRect();
    const nextRegion = normalizedRegion.map((point) => ({ ...point }));

    nextRegion[dragPointIndexRef.current] = {
      x: Math.min(Math.max((clientX - bounds.left) / bounds.width, 0), 1),
      y: Math.min(Math.max((clientY - bounds.top) / bounds.height, 0), 1)
    };

    onRegionChange(normalizeBettingRegion(nextRegion));
  }

  function handleEditorPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!regionEditorEnabled || dragPointIndexRef.current === null) {
      return;
    }

    updateRegionPoint(event.clientX, event.clientY);
  }

  function finishDragging() {
    dragPointIndexRef.current = null;
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
    <div
      ref={shellRef}
      className={fullScreen ? "video-shell video-shell-fullscreen" : "video-shell"}
      onPointerMove={handleEditorPointerMove}
      onPointerUp={finishDragging}
      onPointerCancel={finishDragging}
    >
      <video ref={videoRef} controls muted playsInline autoPlay />
      {normalizedRegion && normalizedRegion.length >= 3 ? (
        <svg
          className={
            regionEditorEnabled
              ? "region-overlay-svg region-overlay-svg-editable"
              : "region-overlay-svg"
          }
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polygon className="region-overlay-fill" points={polygonPoints} />
          <polygon className="region-overlay-stroke" points={polygonPoints} />
          {regionEditorEnabled
            ? normalizedRegion.map((point, index) => (
                <circle
                  key={`${index}-${point.x}-${point.y}`}
                  className="region-overlay-handle"
                  cx={point.x * 100}
                  cy={point.y * 100}
                  r="1.5"
                  onPointerDown={(event) => {
                    dragPointIndexRef.current = index;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    updateRegionPoint(event.clientX, event.clientY);
                  }}
                />
              ))
            : null}
        </svg>
      ) : null}
      {personBoxes.map((box) => (
        <div
          key={box.id}
          className="person-detection-box"
          style={{
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`
          }}
        >
          <span className="person-detection-label">person {Math.round(box.confidence * 100)}%</span>
        </div>
      ))}
      <div className={fullScreen ? "video-state video-state-overlay" : "video-state"}>{state}</div>
    </div>
  );
}
