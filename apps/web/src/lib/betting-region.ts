export type RegionPoint = {
  x: number;
  y: number;
};

export const DEFAULT_BETTING_REGION: RegionPoint[] = [
  { x: 0.78, y: 0.45 },
  { x: 0.9, y: 0.45 },
  { x: 0.9, y: 0.55 },
  { x: 0.78, y: 0.55 }
];

function clampCoordinate(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

export function normalizeBettingRegion(points: RegionPoint[]) {
  return points.map((point) => ({
    x: Number(clampCoordinate(point.x).toFixed(4)),
    y: Number(clampCoordinate(point.y).toFixed(4))
  }));
}

export function bettingRegionsEqual(left: RegionPoint[], right: RegionPoint[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((point, index) => {
    const next = right[index];
    return (
      Math.abs(point.x - next.x) < 0.0001 &&
      Math.abs(point.y - next.y) < 0.0001
    );
  });
}
