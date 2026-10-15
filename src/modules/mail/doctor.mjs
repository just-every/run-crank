#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mailDoctor } from './src/doctor/index.mjs';
import { object } from './src/doctor/common.mjs';
import { fail } from './src/core/errors.mjs';

export const usage = `Mail doctor
  node modules/mail/doctor.mjs --domain mail.example.com --provider resend --plan [--json]
  node modules/mail/doctor.mjs --live --config /path/to/approved-mail-config.json [--json]
Live mode sends exactly one message and reads an actual Resend receiving mailbox.
Credentials: MAIL_DOCTOR_SEND_API_KEY and MAIL_DOCTOR_RECEIVE_API_KEY, environment only.
No mode flag means offline plan. See modules/mail/live-proof/README.md.`;

export async function doctorOptions(args, env = process.env) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--domain', '--provider', '--config', '--plan', '--live', '--json', '--help'].includes(name) || flags[name] !== undefined) fail('invalid_doctor_arguments');
    if (['--domain', '--provider', '--config'].includes(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail('invalid_doctor_arguments');
      flags[name] = value;
    } else flags[name] = true;
  }
  if (flags['--help']) return { help: true };
  if (flags['--live'] && flags['--plan']) fail('invalid_doctor_arguments');
  let config = {};
  if (flags['--config']) {
    try {
      if ((await stat(flags['--config'])).size > 65536) fail('invalid_doctor_config_file');
      config = JSON.parse(await readFile(flags['--config'], 'utf8'));
    } catch { fail('invalid_doctor_config_file'); }
    object(config, ['domain', 'provider', 'dnsRecords', 'send', 'receive', 'timeoutMs', 'pollIntervalMs'], 'invalid_doctor_config_file');
    if (config.send !== undefined) object(config.send, ['from', 'to', 'accountId'], 'invalid_doctor_config_file');
    if (config.receive !== undefined) object(config.receive, ['provider'], 'invalid_doctor_config_file');
  }
  for (const key of ['domain', 'provider']) {
    if (flags[`--${key}`] && config[key] && flags[`--${key}`] !== config[key]) fail('doctor_config_conflict');
  }
  const options = {
    domain: flags['--domain'] ?? config.domain, provider: flags['--provider'] ?? config.provider,
    dnsRecords: config.dnsRecords, live: flags['--live'] === true,
  };
  if (options.live) {
    if (!flags['--config'] || !config.send || !config.receive) fail('doctor_live_config_required');
    options.send = {
      from: config.send.from, to: config.send.to,
      config: { provider: options.provider, mode: 'production', apiKey: env.MAIL_DOCTOR_SEND_API_KEY,
        ...(config.send.accountId === undefined ? {} : { accountId: config.send.accountId }) },
    };
    options.receive = { provider: config.receive.provider, apiKey: env.MAIL_DOCTOR_RECEIVE_API_KEY };
    options.timeoutMs = config.timeoutMs; options.pollIntervalMs = config.pollIntervalMs;
  }
  return { options, json: flags['--json'] === true };
}

export function formatDoctor(result) {
  return [`Mail doctor: ${result.domain} (${result.provider})`, ...result.items.flatMap(item => [
    `${item.id.toUpperCase()}: ${item.status} (${item.evidence.state})`,
    ...(item.records ?? []).map(row => `  ${row.type} ${row.name} ${row.priority === undefined ? '' : `${row.priority} `}${row.value}`),
    ...item.nextSteps.map(step => `  Next: ${step}`),
  ])].join('\n');
}

export async function runCli(args, env = process.env) {
  try {
    const parsed = await doctorOptions(args, env);
    if (parsed.help) { process.stdout.write(`${usage}\n`); return 0; }
    const result = await mailDoctor(parsed.options);
    process.stdout.write(`${parsed.json ? JSON.stringify(result, null, 2) : formatDoctor(result)}\n`);
    return parsed.options.live && result.items.some(item => item.status !== 'pass') ? 1 : 0;
  } catch (error) {
    // Only our fixed error codes are printed; never paths, config or remote text.
    const code = error?.name === 'MailValidationError' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'doctor_failed';
    process.stderr.write(`Mail doctor failed: ${code}. Use --help for required configuration.\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
