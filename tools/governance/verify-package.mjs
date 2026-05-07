import { loadConfig, readJson, pass, fail, warn, printResults, exitCodeFor } from './lib.mjs';

const config = loadConfig();
const pkg = readJson('package.json');
const results = [];

if (pkg.name === config.expectedPackage.name) {
  results.push(pass('package.name', 'Package name matches governance config'));
} else {
  results.push(fail('package.name', `Expected ${config.expectedPackage.name} but found ${pkg.name}`));
}

if (pkg.type === config.expectedPackage.type) {
  results.push(pass('package.type', 'Package type matches governance config'));
} else {
  results.push(fail('package.type', `Expected ${config.expectedPackage.type} but found ${pkg.type}`));
}

for (const script of config.requiredPackageScripts) {
  if (pkg.scripts?.[script]) {
    results.push(pass(`package.script:${script}`, 'Required script exists'));
  } else {
    results.push(warn(`package.script:${script}`, 'Required script missing'));
  }
}

printResults('Package Verification', results);
process.exit(exitCodeFor(results));
