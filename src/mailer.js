require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const MIN_SEND_INTERVAL_MS = Number(process.env.RESEND_MIN_SEND_INTERVAL_MS || 250);
const MAX_RATE_LIMIT_RETRIES = Number(process.env.RESEND_MAX_RATE_LIMIT_RETRIES || 3);

let sendQueue = Promise.resolve();
let nextSendAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Derive a plain-text fallback from the HTML body. Sending HTML-only is a
// well-known spam signal; a multipart/alternative message scores better.
function htmlToText(html) {
  return html
    .replace(/<\!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&zwnj;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&rarr;|→/g, '->')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
}

// Gmail/Yahoo require a List-Unsubscribe header for bulk mail (Feb 2024).
// Configurable via env; falls back to a mailto on the sending domain.
function unsubscribeHeaders() {
  const fromDomain = (process.env.EMAIL_FROM || '').split('@')[1] || 'nutreeai.com';
  const httpsUrl = process.env.EMAIL_LIST_UNSUBSCRIBE_URL;
  const mailto = process.env.EMAIL_LIST_UNSUBSCRIBE_MAILTO
    || `unsubscribe@${fromDomain}`;

  const parts = [];
  if (httpsUrl) parts.push(`<${httpsUrl}>`);
  parts.push(`<mailto:${mailto}?subject=unsubscribe>`);

  const headers = { 'List-Unsubscribe': parts.join(', ') };
  // One-Click is only valid when an HTTPS endpoint is present.
  if (httpsUrl) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return headers;
}

async function waitForSendSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, nextSendAt - now);
  if (waitMs) await sleep(waitMs);
  nextSendAt = Date.now() + MIN_SEND_INTERVAL_MS;
}

function normalizeResendError(error) {
  const message = typeof error?.message === 'string'
    ? error.message
    : JSON.stringify(error);
  const normalized = new Error(message);
  normalized.statusCode = error?.statusCode;
  normalized.name = error?.name;
  return normalized;
}

async function sendEmail({ to, subject, html }) {
  const sendTask = async () => {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      await waitForSendSlot();

      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_FROM}>`,
        to,
        subject,
        html,
        text: htmlToText(html),
        headers: unsubscribeHeaders(),
      });

      if (!error) return data;

      const normalized = normalizeResendError(error);
      if (normalized.statusCode !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) {
        throw normalized;
      }

      await sleep(1000 * (attempt + 1));
    }
  };

  const queued = sendQueue.then(sendTask, sendTask);
  sendQueue = queued.catch(() => {});
  return queued;
}

module.exports = { sendEmail };
