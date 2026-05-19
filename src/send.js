require('dotenv').config();
const nunjucks = require('nunjucks');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { sendEmail } = require('./mailer');

const TEMPLATES_DIR  = path.resolve('./templates/emails');
const RECIPIENTS_DIR = path.resolve('./recipients');

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

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', r => r.email && rows.push({
        email:      r.email.trim(),
        first_name: r.first_name?.trim() || '',
        promo_code: r.code?.trim() || 'COMEBACK55',
      }))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// ── CLI args ──────────────────────────────────────────────────────────────────
// npm run send -- --template winback_01_offer
// npm run send -- --template winback_01_offer --recipients recipients/winback-may-2026.csv
// npm run send -- --template winback_01_offer --to a@x.com,b@x.com
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      args[key] = next && !next.startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const templateNames = args.template
    ? args.template.split(',').map(t => t.trim())
    : fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(TEMPLATES_DIR, e.name, 'config.json')))
        .map(e => e.name).sort();

  let recipients;
  if (args.recipients) {
    recipients = await readCsv(path.resolve(args.recipients));
  } else if (args.to) {
    recipients = args.to.split(',').map(addr => ({
      email: addr.trim(), first_name: '', promo_code: 'COMEBACK55',
    }));
  } else {
    const csvFiles = fs.readdirSync(RECIPIENTS_DIR).filter(f => f.endsWith('.csv'));
    if (!csvFiles.length) {
      console.error('No recipients. Use --recipients <file.csv> or --to <email>');
      process.exit(1);
    }
    recipients = await readCsv(path.join(RECIPIENTS_DIR, csvFiles[0]));
    console.log(`Using ${csvFiles[0]}`);
  }

  console.log(`Templates  : ${templateNames.join(', ')}`);
  console.log(`Recipients : ${recipients.length} (${recipients.map(r => r.email).join(', ')})\n`);

  for (const name of templateNames) {
    let html, config;
    try {
      ({ html, config } = loadTemplate(name));
    } catch (err) {
      console.error(`✗ ${name} — load failed: ${err.message}`);
      continue;
    }

    const baseCtx = Object.fromEntries(
      Object.entries(config.vars).map(([k, v]) => [k, v.default ?? ''])
    );
    const csvKeys = new Set(
      Object.entries(config.vars).filter(([, v]) => v.fromCsv).map(([k]) => k)
    );

    for (const recipient of recipients) {
      const ctx = { ...baseCtx };
      for (const key of csvKeys) {
        if (recipient[key]) ctx[key] = recipient[key];
      }

      let rendered;
      try {
        rendered = njkEnv.renderString(html, ctx);
      } catch (err) {
        console.error(`✗ ${name} → ${recipient.email} — render: ${err.message}`);
        continue;
      }

      try {
        const data = await sendEmail({ to: recipient.email, subject: config.subject, html: rendered });
        console.log(`✓ ${name} → ${recipient.first_name || ''} <${recipient.email}> — id: ${data?.id}`);
      } catch (err) {
        console.error(`✗ ${name} → ${recipient.email} — send: ${err.message}`);
      }
    }
  }
}

main();
