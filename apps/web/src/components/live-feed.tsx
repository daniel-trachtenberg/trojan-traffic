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
  imageSrc?: string | null;
  mediaAspectRatio?: number | null;
  region?: RegionPoint[] | null;
  fullScreen?: boolean;
  personBoxes?: PersonDetectionBox[];
  statusMessage?: string | null;
  regionEditorEnabled?: boolean;
  onRegionChange?: ((points: RegionPoint[]) => void) | null;
};

type StageSize = {
  width: number;
  height: number;
};

const DEFAULT_MEDIA_ASPECT_RATIO = 16 / 9;

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

function isPointInsidePolygon(point: RegionPoint, polygon: RegionPoint[]) {
  let isInside = false;

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previousIndex];
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

export function LiveFeed({
  src,
  imageSrc = null,
  mediaAspectRatio = DEFAULT_MEDIA_ASPECT_RATIO,
  region = null,
  fullScreen = false,
  personBoxes = [],
  statusMessage = null,
  regionEditorEnabled = false,
  onRegionChange = null
}: LiveFeedProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragPointIndexRef = useRef<number | null>(null);
  const [playbackState, setPlaybackState] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState<StageSize | null>(null);
  const normalizedRegion = region ? toNormalizedPoints(region) : null;
  const polygonPoints = normalizedRegion
    ? normalizedRegion.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")
    : "";
  const resolvedAspectRatio =
    mediaAspectRatio && Number.isFinite(mediaAspectRatio) && mediaAspectRatio > 0
      ? mediaAspectRatio
      : DEFAULT_MEDIA_ASPECT_RATIO;
  const overlayState = statusMessage ?? playbackState;

  function updateRegionPoint(clientX: number, clientY: number) {
    if (
      dragPointIndexRef.current === null ||
      !stageRef.current ||
      !normalizedRegion ||
      !onRegionChange
    ) {
      return;
    }

    const bounds = stageRef.current.getBoundingClientRect();
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
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const updateStageSize = () => {
      const bounds = shell.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }

      const shellAspectRatio = bounds.width / bounds.height;
      const nextSize = fullScreen
        ? shellAspectRatio > resolvedAspectRatio
          ? {
              width: Math.round(bounds.width),
              height: Math.round(bounds.width / resolvedAspectRatio)
            }
          : {
              width: Math.round(bounds.height * resolvedAspectRatio),
              height: Math.round(bounds.height)
            }
        : shellAspectRatio > resolvedAspectRatio
          ? {
              width: Math.round(bounds.height * resolvedAspectRatio),
              height: Math.round(bounds.height)
            }
          : {
              width: Math.round(bounds.width),
              height: Math.round(bounds.width / resolvedAspectRatio)
            };

      setStageSize((current) => {
        if (
          current &&
          current.width === nextSize.width &&
          current.height === nextSize.height
        ) {
          return current;
        }

        return nextSize;
      });
    };

    updateStageSize();
    const observer = new ResizeObserver(updateStageSize);
    observer.observe(shell);

    return () => {
      observer.disconnect();
    };
  }, [fullScreen, resolvedAspectRatio]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || imageSrc) {
      setPlaybackState(null);
      return;
    }

    let hls: Hls | null = null;
    setPlaybackState(null);

    const handlePlayable = () => {
      setPlaybackState(null);
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("playing", handlePlayable);
      void video.play().catch(() => {
        setPlaybackState("Press play to start the feed.");
      });

      return () => {
        video.removeEventListener("playing", handlePlayable);
      };
    }

    if (!Hls.isSupported()) {
      setPlaybackState("HLS is not supported in this browser.");
      return;
    }

    hls = new Hls({
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60
    });

    hls.loadSource(src);
    hls.attachMedia(video);
    video.addEventListener("playing", handlePlayable);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => {
        setPlaybackState("Press play to start the feed.");
      });
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        setPlaybackState("Live feed reconnecting...");
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad();
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }

        hls?.destroy();
      }
    });

    return () => {
      video.removeEventListener("playing", handlePlayable);
      hls?.destroy();
    };
  }, [imageSrc, src]);

  return (
    <div
      ref={shellRef}
      className={fullScreen ? "video-shell video-shell-fullscreen" : "video-shell"}
    >
      <div
        ref={stageRef}
        className="video-stage"
        style={
          stageSize
            ? {
                width: `${stageSize.width}px`,
                height: `${stageSize.height}px`
              }
            : undefined
        }
        onPointerMove={handleEditorPointerMove}
        onPointerUp={finishDragging}
        onPointerCancel={finishDragging}
      >
        {imageSrc ? (
          // Detector frames change every poll, so this bypasses Next.js image optimization on purpose.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageSrc} alt="Live camera frame" draggable={false} />
        ) : (
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            preload="auto"
            controls={false}
            disablePictureInPicture
            disableRemotePlayback
            controlsList="nodownload nofullscreen noplaybackrate noremoteplayback"
            tabIndex={-1}
          />
        )}
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
                  <g key={`${index}-${point.x}-${point.y}`}>
                    <circle
                      className="region-overlay-handle-hitbox"
                      cx={point.x * 100}
                      cy={point.y * 100}
                      r="1.7"
                      onPointerDown={(event) => {
                        dragPointIndexRef.current = index;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        updateRegionPoint(event.clientX, event.clientY);
                      }}
                    />
                    <circle
                      className="region-overlay-handle"
                      cx={point.x * 100}
                      cy={point.y * 100}
                      r="0.95"
                    />
                  </g>
                ))
              : null}
          </svg>
        ) : null}
        {personBoxes.map((box) => {
          const boxCenter = {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2
          };
          const isInsideRegion =
            normalizedRegion && normalizedRegion.length >= 3
              ? isPointInsidePolygon(boxCenter, normalizedRegion)
              : false;

          return (
            <div
              key={box.id}
              className={
                isInsideRegion
                  ? "person-detection-box person-detection-box-inside"
                  : "person-detection-box person-detection-box-outside"
              }
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.width * 100}%`,
                height: `${box.height * 100}%`
              }}
            />
          );
        })}
        {overlayState ? (
          <div className={fullScreen ? "video-state video-state-overlay" : "video-state"}>
            {overlayState}
          </div>
        ) : null}
      </div>
    </div>
  );
}
