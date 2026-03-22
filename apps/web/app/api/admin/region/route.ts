import {
  readStoredBettingRegion,
  regionPayloadSchema,
  writeStoredBettingRegion
} from "@/lib/betting-region-store";
import { AdminRequestError, requireAdminRequest } from "@/lib/admin-auth";

export async function GET() {
  return Response.json(
    {
      points: await readStoredBettingRegion()
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}

export async function POST(request: Request) {
  try {
    const { accessToken } = await requireAdminRequest(request);
    const payload = regionPayloadSchema.parse(await request.json());
    const points = await writeStoredBettingRegion(payload.points, accessToken);

    return Response.json(
      {
        points
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, max-age=0"
        }
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
