require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { sendEmail } = require('./mailer');

const app = express();
app.use(express.json());
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

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', r => {
        if (!r.email) return;
        const row = {};
        for (const [k, v] of Object.entries(r))
          row[k.trim()] = typeof v === 'string' ? v.trim() : v;
        rows.push(row);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
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

// Send — streams progress as newline-delimited JSON
app.post('/api/send', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const { template, recipients, overrides = {} } = req.body;
  if (!template || !recipients?.length) {
    res.write(`data: ${JSON.stringify({ error: 'template and recipients required' })}\n\n`);
    return res.end();
  }

  let config;
  try {
    ({ config } = loadTemplate(template));
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: `Template load failed: ${err.message}` })}\n\n`);
    return res.end();
  }

  // Build base context from config defaults
  const baseCtx = Object.fromEntries(
    Object.entries(config.vars).map(([k, v]) => [k, v.default ?? ''])
  );
  const subject = config.subject;

  // Which vars pull from the CSV recipient row
  const csvKeys = new Set(
    Object.entries(config.vars).filter(([, v]) => v.fromCsv).map(([k]) => k)
  );

  for (const recipient of recipients) {
    // Start with defaults, then apply UI overrides for non-CSV vars
    const ctx = { ...baseCtx, ...overrides };
    // CSV vars: recipient value wins over everything
    for (const key of csvKeys) {
      if (recipient[key]) ctx[key] = recipient[key];
    }

    let html;
    try {
      ({ html } = render(template, ctx));
    } catch (err) {
      res.write(`data: ${JSON.stringify({ status: 'error', email: recipient.email, message: `Render: ${err.message}` })}\n\n`);
      continue;
    }

    try {
      const data = await sendEmail({ to: recipient.email, subject, html });
      res.write(`data: ${JSON.stringify({ status: 'ok', email: recipient.email, name: recipient.first_name, id: data?.id })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ status: 'error', email: recipient.email, message: err.message })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ status: 'done' })}\n\n`);
  res.end();
});

if (require.main === module) {
  const PORT = process.env.PORT || 3333;
  app.listen(PORT, () => {
    console.log(`\n  Email Sender UI → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
