"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

type RecoveryStatus = "checking" | "ready" | "success" | "invalid-link" | "missing-client";

function readRecoveryErrorFromLocation() {
  if (typeof window === "undefined") {
    return null;
  }

  const currentUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  return (
    currentUrl.searchParams.get("error_description") ??
    hashParams.get("error_description") ??
    currentUrl.searchParams.get("error") ??
    hashParams.get("error")
  );
}

export default function ResetPasswordPage() {
  const supabase = getBrowserSupabaseClient();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<RecoveryStatus>(supabase ? "checking" : "missing-client");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setStatus("missing-client");
      setError("Supabase is not configured for this deployment.");
      return;
    }

    const client = supabase;

    const recoveryError = readRecoveryErrorFromLocation();
    if (recoveryError) {
      setStatus("invalid-link");
      setError(recoveryError);
      return;
    }

    let isMounted = true;
    let fallbackTimerId: number | null = null;

    async function bootstrap() {
      const sessionResponse = await client.auth.getSession();
      if (!isMounted) {
        return;
      }

      if (sessionResponse.data.session) {
        setStatus("ready");
        setError(null);
        return;
      }

      fallbackTimerId = window.setTimeout(() => {
        if (!isMounted) {
          return;
        }

        setStatus("invalid-link");
        setError("This password reset link is invalid or has expired.");
      }, 1500);
    }

    void bootstrap();

    const {
      data: { subscription }
    } = client.auth.onAuthStateChange((event, session) => {
      if (!isMounted) {
        return;
      }

      if (event === "PASSWORD_RECOVERY" || session?.user) {
        if (fallbackTimerId !== null) {
          window.clearTimeout(fallbackTimerId);
        }

        setStatus("ready");
        setError(null);
      }
    });

    return () => {
      isMounted = false;
      if (fallbackTimerId !== null) {
        window.clearTimeout(fallbackTimerId);
      }
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) {
      setStatus("missing-client");
      setError("Supabase is not configured for this deployment.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    const updateResponse = await supabase.auth.updateUser({
      password
    });

    setIsSubmitting(false);

    if (updateResponse.error) {
      setError(updateResponse.error.message);
      return;
    }

    setPassword("");
    setConfirmPassword("");
    setStatus("success");
    setNotice("Password updated. Head back to Trojan Traffic and sign in with your new password.");
  }

  const canSubmit = status === "ready" && !isSubmitting;

  return (
    <main className="reset-password-page">
      <section className="reset-password-card">
        <header className="reset-password-header">
          <h1>Choose a new password</h1>
          <p className="reset-password-copy">
            Use the secure link from your email to set a fresh password for your Trojan Traffic account.
          </p>
        </header>

        {error ? (
          <p className="reset-password-status reset-password-status-error">{error}</p>
        ) : notice ? (
          <p className="reset-password-status reset-password-status-success">{notice}</p>
        ) : status === "checking" ? (
          <p className="reset-password-status reset-password-status-neutral">
            Verifying your reset link...
          </p>
        ) : null}

        {status === "ready" ? (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              New Password
              <input
                required
                minLength={6}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            <label>
              Confirm Password
              <input
                required
                minLength={6}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>

            <div className="reset-password-actions">
              <button type="submit" className="primary-button" disabled={!canSubmit}>
                {isSubmitting ? "Saving..." : "Update Password"}
              </button>
              <Link href="/" className="secondary-button reset-password-link">
                Back to App
              </Link>
            </div>
          </form>
        ) : (
          <div className="reset-password-actions">
            <Link href="/" className="secondary-button reset-password-link">
              Back to App
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
