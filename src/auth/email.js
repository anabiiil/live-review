const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Sends mail through Resend. `send` never throws and never includes the API key in its result.
 * @param {{apiKey?: string, from?: string, fetch?: typeof globalThis.fetch}} opts
 */
export function createEmailSender({ apiKey, from, fetch = globalThis.fetch } = {}) {
  return {
    /**
     * @param {{to: string, subject: string, text: string}} message
     * @returns {Promise<{ok: true} | {ok: false, error: string}>}
     */
    async send({ to, subject, text }) {
      if (!apiKey || !from) return { ok: false, error: 'Email is not configured' };
      try {
        const res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        let detail = '';
        try {
          const body = await res.json();
          if (typeof body?.message === 'string') detail = body.message;
        } catch {
          // body was not JSON; fall back to the status text
        }
        return { ok: false, error: `Resend ${res.status}: ${detail || res.statusText || 'request failed'}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * @param {{projectName: string, link: string, ownerName: string}} p
 * @returns {{subject: string, text: string}}
 */
export function inviteEmail({ projectName, link, ownerName }) {
  return {
    subject: `${ownerName} invited you to review "${projectName}"`,
    text:
      `${ownerName} invited you to review their work on "${projectName}" with LiveReview.\n\n` +
      `Open this link to get started:\n${link}\n\n` +
      'The link works once and expires in 7 days.\n',
  };
}

/**
 * @param {string} code
 * @returns {{subject: string, text: string}}
 */
export function codeEmail(code) {
  return {
    subject: `Your LiveReview sign-in code: ${code}`,
    text:
      `Your LiveReview sign-in code is ${code}\n\n` +
      "It expires in 10 minutes. If you didn't ask for it, you can ignore this email.\n",
  };
}
