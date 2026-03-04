export async function GET() {
  return Response.json(
    {
      service: "web",
      status: "ok",
      timestamp: new Date().toISOString()
    },
    {
      status: 200
    }
  );
}
