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
  focusRegion?: boolean;
  focusPadding?:
    | number
    | {
        top?: number;
        right?: number;
        bottom?: number;
        left?: number;
      };
  focusWindow?:
    | {
        left: number;
        top: number;
        width: number;
        height: number;
      }
    | null;
};

type StageSize = {
  width: number;
  height: number;
  visibleWidthFraction: number;
  visibleHeightFraction: number;
};

type FocusViewport = {
  scale: number;
  leftPct: number;
  topPct: number;
};

const DEFAULT_MEDIA_ASPECT_RATIO = 16 / 9;
const DEFAULT_FOCUS_PADDING = {
  top: 0.08,
  right: 0.08,
  bottom: 0.18,
  left: 0.08
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

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

function resolveFocusPadding(padding: LiveFeedProps["focusPadding"]) {
  if (typeof padding === "number") {
    return {
      top: padding,
      right: padding,
      bottom: padding,
      left: padding
    };
  }

  return {
    top: padding?.top ?? DEFAULT_FOCUS_PADDING.top,
    right: padding?.right ?? DEFAULT_FOCUS_PADDING.right,
    bottom: padding?.bottom ?? DEFAULT_FOCUS_PADDING.bottom,
    left: padding?.left ?? DEFAULT_FOCUS_PADDING.left
  };
}

function getFocusViewport(
  region: RegionPoint[] | null,
  padding: LiveFeedProps["focusPadding"],
  stageSize: StageSize | null,
  focusWindow: LiveFeedProps["focusWindow"]
): FocusViewport | null {
  if ((!region || region.length < 3) && !focusWindow) {
    return null;
  }

  const insets = resolveFocusPadding(padding);
  const resolvedRegion = region ?? [];
  const minX = focusWindow
    ? clamp(focusWindow.left, 0, 1)
    : clamp(Math.min(...resolvedRegion.map((point) => point.x)) - insets.left, 0, 1);
  const maxX = focusWindow
    ? clamp(focusWindow.left + focusWindow.width, 0, 1)
    : clamp(Math.max(...resolvedRegion.map((point) => point.x)) + insets.right, 0, 1);
  const minY = focusWindow
    ? clamp(focusWindow.top, 0, 1)
    : clamp(Math.min(...resolvedRegion.map((point) => point.y)) - insets.top, 0, 1);
  const maxY = focusWindow
    ? clamp(focusWindow.top + focusWindow.height, 0, 1)
    : clamp(Math.max(...resolvedRegion.map((point) => point.y)) + insets.bottom, 0, 1);
  const cropWidth = Math.max(maxX - minX, 0.18);
  const cropHeight = Math.max(maxY - minY, 0.18);
  const visibleWidthFraction = stageSize?.visibleWidthFraction ?? 1;
  const visibleHeightFraction = stageSize?.visibleHeightFraction ?? 1;
  const scale = clamp(
    Math.min(visibleWidthFraction / cropWidth, visibleHeightFraction / cropHeight),
    1,
    3.8
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const minLeftPct = (0.5 + visibleWidthFraction / 2 - scale) * 100;
  const maxLeftPct = (0.5 - visibleWidthFraction / 2) * 100;
  const minTopPct = (0.5 + visibleHeightFraction / 2 - scale) * 100;
  const maxTopPct = (0.5 - visibleHeightFraction / 2) * 100;

  return {
    scale,
    leftPct: clamp((0.5 - centerX * scale) * 100, minLeftPct, maxLeftPct),
    topPct: clamp((0.5 - centerY * scale) * 100, minTopPct, maxTopPct)
  };
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
  onRegionChange = null,
  focusRegion = false,
  focusPadding = DEFAULT_FOCUS_PADDING,
  focusWindow = null
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
  const focusViewport = focusRegion
    ? getFocusViewport(normalizedRegion, focusPadding, stageSize, focusWindow)
    : null;

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
              height: Math.round(bounds.width / resolvedAspectRatio),
              visibleWidthFraction: 1,
              visibleHeightFraction: clamp(
                bounds.height / Math.max(Math.round(bounds.width / resolvedAspectRatio), 1),
                0,
                1
              )
            }
          : {
              width: Math.round(bounds.height * resolvedAspectRatio),
              height: Math.round(bounds.height),
              visibleWidthFraction: clamp(
                bounds.width / Math.max(Math.round(bounds.height * resolvedAspectRatio), 1),
                0,
                1
              ),
              visibleHeightFraction: 1
            }
        : shellAspectRatio > resolvedAspectRatio
          ? {
              width: Math.round(bounds.height * resolvedAspectRatio),
              height: Math.round(bounds.height),
              visibleWidthFraction: 1,
              visibleHeightFraction: 1
            }
          : {
              width: Math.round(bounds.width),
              height: Math.round(bounds.width / resolvedAspectRatio),
              visibleWidthFraction: 1,
              visibleHeightFraction: 1
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
        <div
          className={
            focusViewport
              ? "video-stage-content video-stage-content-focused"
              : "video-stage-content"
          }
          style={
            focusViewport
              ? {
                  width: `${focusViewport.scale * 100}%`,
                  height: `${focusViewport.scale * 100}%`,
                  left: `${focusViewport.leftPct}%`,
                  top: `${focusViewport.topPct}%`
                }
              : undefined
          }
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
                ? normalizedRegion.map((point, index) => {
                    const x = point.x * 100;
                    const y = point.y * 100;

                    return (
                      <g key={`${index}-${point.x}-${point.y}`}>
                        <circle
                          className="region-overlay-handle-hitbox"
                          cx={x}
                          cy={y}
                          r="1.7"
                          onPointerDown={(event) => {
                            dragPointIndexRef.current = index;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            updateRegionPoint(event.clientX, event.clientY);
                          }}
                        />
                        <circle
                          className="region-overlay-handle-ring"
                          cx={x}
                          cy={y}
                          r="0.7"
                        />
                        <line className="region-overlay-handle-tick" x1={x - 1.15} y1={y} x2={x - 0.48} y2={y} />
                        <line className="region-overlay-handle-tick" x1={x + 0.48} y1={y} x2={x + 1.15} y2={y} />
                        <line className="region-overlay-handle-tick" x1={x} y1={y - 1.15} x2={x} y2={y - 0.48} />
                        <line className="region-overlay-handle-tick" x1={x} y1={y + 0.48} x2={x} y2={y + 1.15} />
                      </g>
                    );
                  })
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
        </div>
        {overlayState ? (
          <div className={fullScreen ? "video-state video-state-overlay" : "video-state"}>
            {overlayState}
          </div>
        ) : null}
      </div>
    </div>
  );
}
