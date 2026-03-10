import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getPublicEnvironment } from "@/lib/env";

export class AdminRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireAdminRequest(request: Request) {
  const authorizationHeader = request.headers.get("authorization") ?? "";
  if (!authorizationHeader.startsWith("Bearer ")) {
    throw new AdminRequestError(401, "Authentication required.");
  }

  const accessToken = authorizationHeader.slice("Bearer ".length).trim();
  if (!accessToken) {
    throw new AdminRequestError(401, "Authentication required.");
  }

  const env = getPublicEnvironment();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new AdminRequestError(500, "Supabase environment is not configured.");
  }

  const authClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const userResponse = await authClient.auth.getUser(accessToken);
  if (userResponse.error || !userResponse.data.user) {
    throw new AdminRequestError(401, "Authentication required.");
  }

  const adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const adminResponse = await adminClient
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userResponse.data.user.id)
    .maybeSingle();

  if (adminResponse.error) {
    throw new AdminRequestError(500, adminResponse.error.message);
  }

  if (!adminResponse.data) {
    throw new AdminRequestError(403, "Admin permissions required.");
  }

  return {
    accessToken,
    user: userResponse.data.user
  };
}
