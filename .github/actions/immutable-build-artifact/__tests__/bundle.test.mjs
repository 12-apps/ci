import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBundle, restoreBundle } from '../bundle.mjs';

const identity = { source: 'commit-a', lockfile: 'lock-a', node: '24.19.0', pnpm: '10.34.5', platform: 'linux-x64', command: 'build', environment: 'env-a', implementation: 'impl-a' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'immutable-build-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const source = join(dir,'source'), target=join(dir,'target');
  for(const root of [source,target]) mkdirSync(join(root,'packages/a'),{recursive:true});
  mkdirSync(join(source,'packages/a/dist')); writeFileSync(join(source,'packages/a/dist/index.js'),'export const value=42;');
  mkdirSync(join(source,'.pglite')); writeFileSync(join(source,'.pglite/state'),'mutated DB');
  return {dir,source,target,bundle:createBundle(source,['packages/*/dist'],identity)};
}
test('only declared immutable outputs survive, with independent consumer state',t=>{
  const f=fixture(t); restoreBundle(f.target,['packages/*/dist'],identity,f.bundle);
  assert.equal(readFileSync(join(f.target,'packages/a/dist/index.js'),'utf8'),'export const value=42;');
  assert.throws(()=>readFileSync(join(f.target,'.pglite/state')));
});
for(const field of ['source','lockfile','node','pnpm','platform','command','environment','implementation']) {
  test(`changed ${field} refuses reuse before writing`,t=>{
    const f=fixture(t); assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],{...identity,[field]:'changed'},f.bundle),/identity/);
    assert.throws(()=>readFileSync(join(f.target,'packages/a/dist/index.js')));
  });
}
test('corrupt output bytes refuse reuse before any write',t=>{
  const f=fixture(t);f.bundle.files[0].content=Buffer.from('corrupt').toString('base64');
  assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/digest/);
});
test('different output descriptor and extra database paths refuse reuse',t=>{
  const f=fixture(t); assert.throws(()=>restoreBundle(f.target,['apps/*/dist'],identity,f.bundle),/descriptor/);
  f.bundle.files[0].path='.pglite/state';assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/path/);
});
for(const path of ['../outside','/tmp/outside','packages/a/dist/../../outside','packages/a/dist\\outside']) {
  test(`unsafe path ${path} is rejected`,t=>{const f=fixture(t);f.bundle.files[0].path=path;assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle));});
}
test('producer symlinks and consumer symlink ancestors refuse reuse',t=>{
  const f=fixture(t);symlinkSync('/tmp',join(f.target,'packages/a/dist'));
  assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/symlink/);
  symlinkSync('/tmp',join(f.source,'packages/a/dist/linked'));
  assert.throws(()=>createBundle(f.source,['packages/*/dist'],identity),/symlink/);
});
test('duplicate output entries and unsupported schemas refuse reuse',t=>{
  const f=fixture(t);f.bundle.files.push({...f.bundle.files[0]});assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/duplicate/);
  f.bundle.version=0;assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/schema/);
});
test('empty compiled directories survive without sharing database state',t=>{
  const f=fixture(t);mkdirSync(join(f.source,'packages/a/dist/empty'));
  restoreBundle(f.target,['packages/*/dist'],identity,createBundle(f.source,['packages/*/dist'],identity));
  assert.equal(readFileSync(join(f.target,'packages/a/dist/index.js'),'utf8'),'export const value=42;');
  assert.doesNotThrow(()=>mkdirSync(join(f.target,'packages/a/dist/empty/child')));
});

for(const mutation of ['omitted file','omitted root','omitted directory','changed mode','changed path']) {
  test(`${mutation} rejects incomplete or altered manifest without replacing outputs`,t=>{
    const f=fixture(t);
    mkdirSync(join(f.source,'packages/b/dist'),{recursive:true});
    writeFileSync(join(f.source,'packages/b/dist/second.js'),'second');
    f.bundle=createBundle(f.source,['packages/*/dist'],identity);
    mkdirSync(join(f.target,'packages/a/dist'));writeFileSync(join(f.target,'packages/a/dist/existing.js'),'retain');
    if(mutation==='omitted file')f.bundle.files.pop();
    if(mutation==='omitted root'){f.bundle.roots.pop();f.bundle.files=f.bundle.files.filter(f=>!f.path.startsWith('packages/b/'));f.bundle.directories=f.bundle.directories.filter(d=>!d.startsWith('packages/b/'));}
    if(mutation==='omitted directory')f.bundle.directories.pop();
    if(mutation==='changed mode')f.bundle.files[0].mode=0o700;
    if(mutation==='changed path')f.bundle.files[0].path='packages/a/dist/renamed.js';
    assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle));
    assert.equal(readFileSync(join(f.target,'packages/a/dist/existing.js'),'utf8'),'retain');
  });
}
test('dangling consumer symlink rejects reuse',t=>{
  const f=fixture(t);symlinkSync(join(f.dir,'missing'),join(f.target,'packages/a/dist'));
  assert.throws(()=>restoreBundle(f.target,['packages/*/dist'],identity,f.bundle),/symlink/);
});
