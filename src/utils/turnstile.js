/**
 * Cloudflare Turnstile Bot Protection Engine
 * Verifies guest checkout verification challenges before allowing hold allocations.
 */

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

/**
 * Verifies Cloudflare Turnstile tokens
 */
async function verifyCloudflareTurnstile(token, remoteIp, secretKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteIp) formData.append("remoteip", remoteIp);

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const data = await response.json().catch(() => ({}));

    if (data.success) {
      return { success: true, provider: "turnstile", data };
    }

    return {
      success: false,
      provider: "turnstile",
      message:
        "Security verification failed. Please refresh and complete the verification challenge.",
      errorCodes: data["error-codes"] || [],
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[Turnstile Exception]:", error.message || error);

    // Strictly fail-closed on network errors or timeouts to prevent bot floods
    return {
      success: false,
      provider: "turnstile",
      message:
        "Security verification service timed out or failed. Please try again in a moment.",
    };
  }
}

/**
 * Validates Cloudflare Turnstile challenge token
 */
export async function verifyTurnstileToken(token, remoteIp) {
  const turnstileSecret = (
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || ""
  ).trim();

  // Strictly fail-closed if the secret key is missing.
  // (Use Cloudflare's 1x00000000000000000000AA dummy keys for local dev bypasses).
  if (!turnstileSecret) {
    console.error(
      "[Bot Protection Alert] CLOUDFLARE_TURNSTILE_SECRET_KEY is missing! Refusing unverified checkout.",
    );
    return {
      success: false,
      message:
        "Security verification is temporarily unavailable. Please contact the property directly.",
    };
  }

  if (!token) {
    return {
      success: false,
      message:
        "Security verification challenge was not completed. Please verify the checkbox to continue.",
    };
  }

  return verifyCloudflareTurnstile(token, remoteIp, turnstileSecret);
}
