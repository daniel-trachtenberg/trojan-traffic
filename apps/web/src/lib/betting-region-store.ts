import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_BETTING_REGION,
  normalizeBettingRegion,
  type RegionPoint
} from "@/lib/betting-region";

const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1)
});

const regionFileSchema = z.object({
  points: z.array(pointSchema).length(4),
  updatedAt: z.string().optional()
});

export const regionPayloadSchema = z.object({
  points: z.array(pointSchema).length(4)
});

function getRegionConfigPath() {
  const workspacePath = path.join(
    process.cwd(),
    "apps",
    "web",
    "src",
    "config",
    "betting-region.json"
  );
  const localPath = path.join(
    process.cwd(),
    "src",
    "config",
    "betting-region.json"
  );

  return process.cwd().endsWith(path.join("apps", "web"))
    ? localPath
    : workspacePath;
}

export function isRegionEditorEnabled() {
  return process.env.REGION_EDITOR_ENABLED === "true";
}

export async function readStoredBettingRegion() {
  const filePath = getRegionConfigPath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = regionFileSchema.parse(JSON.parse(raw));
    return normalizeBettingRegion(parsed.points);
  } catch {
    return DEFAULT_BETTING_REGION;
  }
}

export async function writeStoredBettingRegion(points: RegionPoint[]) {
  const normalizedPoints = normalizeBettingRegion(points);
  const filePath = getRegionConfigPath();

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        points: normalizedPoints
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return normalizedPoints;
}
