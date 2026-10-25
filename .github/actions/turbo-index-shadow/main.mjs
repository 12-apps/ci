import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { capture, clearTransport, producer, verifyTransport } from './shadow.mjs';

const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const emit = report => console.log(`TURBO_INDEX_SHADOW=${JSON.stringify(report)}`);
// Advisory failures stay visible and never change Build's exit or gate state.
try {
  const mode = process.argv[2];
  if (mode === 'clear') { clearTransport(process.env.SHADOW_STATE_PATH); output('cleared', 'true'); }
  else if (mode === 'verify') {
    if (process.env.SHADOW_CLEAR !== 'true' || process.env.SHADOW_LOOKUP_HIT !== 'true' || process.env.SHADOW_TRANSPORT_HIT !== 'true') throw new Error('cache transport unavailable');
    emit(verifyTransport(process.env.SHADOW_STATE_PATH));
  }
  else {
    const root = process.cwd(), require = createRequire(join(root, 'package.json'));
    const version = require('turbo/package.json').version;
    if (mode === 'before') {
      const result = await capture({ root, temp: process.env.RUNNER_TEMP, version,
        matchedKey: process.env.SHADOW_MATCHED_KEY,
        cleanBeforeRestore: process.env.SHADOW_CLEAN === 'true',
        affected: process.env.GITHUB_EVENT_NAME === 'pull_request' && Boolean(process.env.SELECTION_BASE) });
      emit(result.report); output('ready', String(result.ready));
      if (result.ready) { output('index-path', result.indexPath); output('state-path', result.statePath); }
    } else if (mode === 'after') emit(producer({ root, version, saveKey: process.env.SHADOW_SAVE_KEY,
      payloadSaveAllowed: process.env.GITHUB_EVENT_NAME !== 'pull_request' }));
    else throw new Error('unknown advisory mode');
  }
} catch {
  output('ready', 'false');
  console.log('::warning::Turbo index shadow measurement unavailable; normal restore/build/save retain their original behavior.');
  emit({ phase: process.argv[2], measurementUnavailable: true, actualRestoreRetained: true });
}
