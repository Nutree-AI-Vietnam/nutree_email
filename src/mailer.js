require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const MIN_SEND_INTERVAL_MS = Number(process.env.RESEND_MIN_SEND_INTERVAL_MS || 250);
const MAX_RATE_LIMIT_RETRIES = Number(process.env.RESEND_MAX_RATE_LIMIT_RETRIES || 3);

let sendQueue = Promise.resolve();
let nextSendAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
