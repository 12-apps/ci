import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from './bundle.mjs';
const [mode,root,scenario]=process.argv.slice(2);
const env={...process.env,GIT_AUTHOR_DATE:'2026-10-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-01T00:00:00Z'};
if(mode==='prepare') {
  mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'pnpm-lock.yaml'),'lockfileVersion: 9.0\n');
  writeFileSync(join(root,'source.txt'),'immutable source\n');
  for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','source.txt','pnpm-lock.yaml'],['commit','-qm','fixture']])execFileSync('git',args,{cwd:root,env});
  mkdirSync(join(root,'.pglite'));writeFileSync(join(root,'.pglite/state'),'fresh-consumer-state');
} else if(mode==='build') {
  mkdirSync(join(root,'packages/a/dist'),{recursive:true});
  writeFileSync(join(root,'packages/a/dist/index.js'),'export const value=42;\n');
  writeFileSync(join(root,'packages/a/dist/second.js'),'export const second=true;\n');
} else if(mode==='corrupt') {
  const file=join(process.env.RUNNER_TEMP,`immutable-build-${digest(process.env.ARTIFACT_NAME).slice(0,16)}`,'bundle.json');
  const bundle=JSON.parse(readFileSync(file,'utf8'));bundle.files.pop();writeFileSync(file,JSON.stringify(bundle));
} else if(mode==='assert') {
  assert.equal(process.env.READY,scenario==='matching'?'true':'false');
  assert.equal(readFileSync(join(root,'.pglite/state'),'utf8'),'fresh-consumer-state');
  assert.equal(readFileSync(join(root,'packages/a/dist/index.js'),'utf8'),'export const value=42;\n');
  assert.equal(readFileSync(join(root,'packages/a/dist/second.js'),'utf8'),'export const second=true;\n');
  console.log(`ARTIFACT_CONTROL scenario=${scenario} ready=${process.env.READY} complete-files=2 fresh-database=true fallback=${scenario!=='matching'}`);
} else throw new Error('unknown probe mode');
