import { runFromEnvironment, safeCode } from './ram-contract';

void runFromEnvironment(process.env, process.argv.slice(2), {
  log: event => process.stdout.write(`${JSON.stringify(event)}\n`),
}).then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 'skipped' in result || result.passed ? 0 : 1;
}).catch(error => {
  process.stderr.write(`${JSON.stringify({ passed: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
});
