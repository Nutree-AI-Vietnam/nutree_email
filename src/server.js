require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./mailer');

const app = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '2mb';
const MAX_SEND_RECIPIENTS_PER_REQUEST = Number(process.env.MAX_SEND_RECIPIENTS_PER_REQUEST || 250);

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, '../public')));

const TEMPLATES_DIR  = path.join(__dirname, '../templates/emails');
const RECIPIENTS_DIR = path.join(__dirname, '../recipients');

// Nunjucks: each template folder is a loader root
const njkEnv = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(TEMPLATES_DIR),
  { autoescape: true }
);
njkEnv.addFilter('vnd', n => String(Number(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'));

const PYTHON_FMT = '{{ "{:,}".format(price_daily|default(1094)).replace(",", ".") }}';

function loadTemplate(name) {
  const dir = path.join(TEMPLATES_DIR, name);
  const html = fs.readFileSync(path.join(dir, 'template.html'), 'utf8')
    .replaceAll(PYTHON_FMT, '{{ price_daily | default(1094) | vnd }}');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return { html, config };
}

function render(name, ctx) {
  const { html, config } = loadTemplate(name);
  return { html: njkEnv.renderString(html, ctx), config };
}

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function csvKeysFromConfig(config) {
  return new Set(
    Object.entries(config.vars).filter(([, v]) => v.fromCsv).map(([k]) => k)
  );
}

function contextFromRecipient(config, recipient = {}, overrides = {}) {
  const ctx = {
    ...Object.fromEntries(Object.entries(config.vars).map(([k, v]) => [k, v.default ?? ''])),
    ...overrides,
  };
  for (const key of csvKeysFromConfig(config)) {
    if (recipient[key]) ctx[key] = recipient[key];
  }
  return ctx;
}

// ── API ───────────────────────────────────────────────────────────────────────

// List templates (any directory under TEMPLATES_DIR that has config.json)
app.get('/api/templates', (req, res) => {
  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(TEMPLATES_DIR, e.name, 'config.json')))
    .map(e => e.name)
    .sort();
  res.json(entries);
});

// Template config (subject, var labels, defaults, fromCsv)
app.get('/api/templates/:name/config', (req, res) => {
  try {
    const cfgPath = path.join(TEMPLATES_DIR, req.params.name, 'config.json');
    const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    res.json(config);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// List saved recipient CSVs
app.get('/api/recipients', (req, res) => {
  const files = fs.readdirSync(RECIPIENTS_DIR)
    .filter(f => f.endsWith('.csv'))
    .sort();
  res.json(files);
});

app.post('/api/preview', async (req, res) => {
  const { template, recipient, overrides = {} } = req.body;
  if (!template) return res.status(400).json({ error: 'template required' });

  let config;
  try {
    ({ config } = loadTemplate(template));
  } catch (err) {
    return res.status(404).json({ error: `Template load failed: ${err.message}` });
  }

  try {
    const ctx = contextFromRecipient(config, recipient, overrides);
    const { html } = render(template, ctx);
    return res.json({ subject: config.subject, html });
  } catch (err) {
    return res.status(500).json({ error: `Preview render failed: ${err.message}` });
  }
});

// Send — streams progress as newline-delimited JSON
app.post('/api/send', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const { template, recipients, overrides = {} } = req.body;
  if (!template || !recipients?.length) {
    writeEvent(res, { error: 'template and recipients required' });
    return res.end();
  }

  if (!isPositiveSafeInteger(MAX_SEND_RECIPIENTS_PER_REQUEST)) {
    writeEvent(res, { error: 'MAX_SEND_RECIPIENTS_PER_REQUEST must be a positive integer' });
    return res.end();
  }

  if (recipients.length > MAX_SEND_RECIPIENTS_PER_REQUEST) {
    writeEvent(res, {
      error: `Too many recipients in one request. Send ${MAX_SEND_RECIPIENTS_PER_REQUEST} or fewer per batch.`,
      maxRecipients: MAX_SEND_RECIPIENTS_PER_REQUEST,
    });
    return res.end();
  }

  let config;
  try {
    ({ config } = loadTemplate(template));
  } catch (err) {
    writeEvent(res, { error: `Template load failed: ${err.message}` });
    return res.end();
  }

  for (const recipient of recipients) {
    let html, subject;
    try {
      const ctx = contextFromRecipient(config, recipient, overrides);
      ({ html } = render(template, ctx));
      subject = njkEnv.renderString(config.subject, ctx);
    } catch (err) {
      writeEvent(res, { status: 'error', email: recipient.email, message: `Render: ${err.message}` });
      continue;
    }

    try {
      const data = await sendEmail({ to: recipient.email, subject, html });
      writeEvent(res, { status: 'ok', email: recipient.email, name: recipient.first_name, id: data?.id });
    } catch (err) {
      writeEvent(res, { status: 'error', email: recipient.email, message: err.message });
    }
  }

  writeEvent(res, { status: 'done' });
  res.end();
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Request body is too large. Upload fewer recipients per batch or keep the payload under ${JSON_BODY_LIMIT}.`,
    });
  }
  return next(err);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3333;
  app.listen(PORT, () => {
    console.log(`\n  Email Sender UI → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
