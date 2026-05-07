import { loadConfig, readText, exists, pass, fail, printResults, exitCodeFor } from './lib.mjs';

const config = loadConfig();
const results = [];

if (!exists(config.manifestPath)) {
  results.push(fail('manifest.exists', `Missing manifest at ${config.manifestPath}`));
} else {
  results.push(pass('manifest.exists', `Found ${config.manifestPath}`));

  const manifest = readText(config.manifestPath);

  for (const phrase of config.requiredManifestPhrases) {
    if (manifest.includes(phrase)) {
      results.push(pass(`manifest.contains:${phrase}`, 'Required governance phrase present'));
    } else {
      results.push(fail(`manifest.contains:${phrase}`, 'Required governance phrase missing'));
    }
  }
}

printResults('Manifest Verification', results);
process.exit(exitCodeFor(results));
