import {
  isRegionEditorEnabled,
  readStoredBettingRegion,
  regionPayloadSchema,
  writeStoredBettingRegion
} from "@/lib/betting-region-store";

export async function GET() {
  return Response.json(
    {
      enabled: isRegionEditorEnabled(),
      points: await readStoredBettingRegion()
    },
    {
      status: 200
    }
  );
}

export async function POST(request: Request) {
  if (!isRegionEditorEnabled()) {
    return Response.json(
      {
        error: "Region editor is disabled."
      },
      {
        status: 403
      }
    );
  }

  try {
    const payload = regionPayloadSchema.parse(await request.json());
    const points = await writeStoredBettingRegion(payload.points);

    return Response.json(
      {
        points
      },
      {
        status: 200
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid region payload.";

    return Response.json(
      {
        error: message
      },
      {
        status: 400
      }
    );
  }
}
