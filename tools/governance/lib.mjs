import fs from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();

export function readJson(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

export function readText(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

export function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

export function loadConfig() {
  return readJson('tools/governance/governance.config.json');
}

export function result(check, status, message, details = {}) {
  return {
    check,
    status,
    message,
    details,
  };
}

export function pass(check, message, details = {}) {
  return result(check, 'PASS', message, details);
}

export function warn(check, message, details = {}) {
  return result(check, 'WARN', message, details);
}

export function fail(check, message, details = {}) {
  return result(check, 'FAIL', message, details);
}

export function blocked(check, message, details = {}) {
  return result(check, 'BLOCKED', message, details);
}

export function printResults(title, results) {
  console.log(`\n## ${title}`);
  for (const item of results) {
    console.log(`${item.status.padEnd(7)} ${item.check} — ${item.message}`);
    if (item.details && Object.keys(item.details).length > 0) {
      console.log(`        ${JSON.stringify(item.details)}`);
    }
  }
}

export function summarize(results) {
  return results.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { PASS: 0, WARN: 0, FAIL: 0, BLOCKED: 0 }
  );
}

export function exitCodeFor(results) {
  return results.some((item) => item.status === 'FAIL') ? 1 : 0;
}

export function supabaseEnv() {
  const url = process.env.SAIL_CORE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SAIL_CORE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  return { url, key };
}

export async function fetchSupabaseRest(pathname, options = {}) {
  const { url, key } = supabaseEnv();
  if (!url || !key) {
    throw new Error('Missing Supabase env. Set SAIL_CORE_SUPABASE_URL and SAIL_CORE_SUPABASE_SERVICE_ROLE_KEY for full governance verification.');
  }

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${pathname.replace(/^\//, '')}`;
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const error = new Error(`Supabase REST request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}
