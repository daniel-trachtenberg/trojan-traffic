import {
  isRegionEditorEnabled,
  readStoredBettingRegion,
  regionPayloadSchema,
  writeStoredBettingRegion
} from "@/lib/betting-region-store";
import { AdminRequestError, requireAdminRequest } from "@/lib/admin-auth";

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
    await requireAdminRequest(request);
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
    if (error instanceof AdminRequestError) {
      return Response.json(
        {
          error: error.message
        },
        {
          status: error.status
        }
      );
    }

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
