import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES=32*1024*1024, MAX_FILES=10000;
function safePath(path) {
  return typeof path==='string' && path.length>0 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && path.split('/').every(s=>s && s!=='.' && s!=='..');
}
function descriptor(patterns) {
  if(!Array.isArray(patterns)||patterns.length===0||!patterns.every(p=>safePath(p)&&p.split('/').every(s=>s==='*'||!s.includes('*')))) throw new Error('invalid output descriptor');
  return [...new Set(patterns)].sort();
}
function matches(root,pattern) {
  const a=root.split('/'),b=pattern.split('/');return a.length===b.length&&a.every((s,i)=>b[i]==='*'||s===b[i]);
}
function noSymlinks(root,path) {
  let current=root;
  for(const part of path.split('/')) {
    current=join(current,part);
    try {
      if(lstatSync(current).isSymbolicLink()) throw new Error('symlink in immutable output path');
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
}
function findRoots(root,patterns) {
  const found=[];
  for(const pattern of patterns) {
    let candidates=[''];
    for(const segment of pattern.split('/')) {
      const next=[];
      for(const relative of candidates) {
        const path=join(root,relative);
        if(segment==='*') {
          if(!existsSync(path))continue;
          for(const e of readdirSync(path,{withFileTypes:true})) {
            if(e.isSymbolicLink())throw new Error('symlink in immutable output descriptor');
            if(e.isDirectory())next.push(relative?`${relative}/${e.name}`:e.name);
          }
        } else {
          const p=relative?`${relative}/${segment}`:segment;
          noSymlinks(root,p);
          if(existsSync(join(root,p))&&lstatSync(join(root,p)).isDirectory())next.push(p);
        }
      }
      candidates=next;
    }
    found.push(...candidates);
  }
  return [...new Set(found)].sort();
}
export function createBundle(root,patterns,identity) {
  patterns=descriptor(patterns);const roots=findRoots(root,patterns),files=[],directories=[];let bytes=0;
  const walk=relative=>{
    noSymlinks(root,relative);
    if(directories.length>=MAX_FILES)throw new Error('immutable directories exceed bundle bound');
    directories.push(relative);
    for(const e of readdirSync(join(root,relative),{withFileTypes:true})) {
      const path=`${relative}/${e.name}`;
      if(!safePath(path)||e.isSymbolicLink())throw new Error('unsafe path or symlink in immutable output');
      if(e.isDirectory()){walk(path);continue;}
      if(!e.isFile())throw new Error('immutable output is not a regular file');
      const data=readFileSync(join(root,path));bytes+=data.length;
      if(bytes>MAX_BYTES||files.length>=MAX_FILES)throw new Error('immutable output exceeds bundle bound');
      files.push({path,mode:lstatSync(join(root,path)).mode&0o777,sha256:digest(data),content:data.toString('base64')});
    }
  };
  for(const r of roots)walk(r);
  if(!files.length)throw new Error('no immutable outputs to publish');
  const manifest={version:1,patterns,roots,identity,directories:directories.sort(),files:files.sort((a,b)=>a.path.localeCompare(b.path))};
  return {...manifest,manifestDigest:digest(JSON.stringify(manifest))};
}
export function restoreBundle(root,patterns,identity,bundle) {
  patterns=descriptor(patterns);
  if(!bundle||bundle.version!==1)throw new Error('unsupported immutable bundle schema');
  if(JSON.stringify(bundle.patterns)!==JSON.stringify(patterns))throw new Error('immutable descriptor mismatch');
  if(JSON.stringify(bundle.identity)!==JSON.stringify(identity))throw new Error('immutable build identity mismatch');
  if(!Array.isArray(bundle.roots)||bundle.roots.length===0||!bundle.roots.every(r=>safePath(r)&&patterns.some(p=>matches(r,p))))throw new Error('invalid output root path');
  if(new Set(bundle.roots).size!==bundle.roots.length||bundle.roots.some(r=>bundle.roots.some(s=>s!==r&&r.startsWith(s+'/'))))throw new Error('duplicate or overlapping output roots');
  if(!Array.isArray(bundle.directories)||bundle.directories.length>MAX_FILES||new Set(bundle.directories).size!==bundle.directories.length||
    !bundle.directories.every(d=>safePath(d)&&bundle.roots.some(r=>d===r||d.startsWith(r+'/')))||!bundle.roots.every(r=>bundle.directories.includes(r)))throw new Error('invalid immutable directories');
  if(!Array.isArray(bundle.files)||bundle.files.length===0||bundle.files.length>MAX_FILES)throw new Error('invalid output files');
  const seen=new Set(),validated=[];let bytes=0;
  for(const file of bundle.files) {
    if(!safePath(file.path)||!bundle.roots.some(r=>file.path.startsWith(r+'/')))throw new Error('invalid immutable file path');
    if(seen.has(file.path))throw new Error('duplicate immutable output');seen.add(file.path);
    noSymlinks(root,file.path);
    if(typeof file.content!=='string'||!Number.isInteger(file.mode)||file.mode<0||file.mode>0o777)throw new Error('invalid immutable bytes or mode');
    const data=Buffer.from(file.content,'base64');bytes+=data.length;
    if(bytes>MAX_BYTES||data.toString('base64')!==file.content||digest(data)!==file.sha256)throw new Error('immutable output digest mismatch');
    validated.push({...file,data});
  }
  for(const r of bundle.roots)noSymlinks(root,r);
  for(const d of bundle.directories)noSymlinks(root,d);
  const manifest={version:bundle.version,patterns:bundle.patterns,roots:bundle.roots,identity:bundle.identity,directories:bundle.directories,files:bundle.files};
  if(bundle.manifestDigest!==digest(JSON.stringify(manifest)))throw new Error('immutable manifest digest mismatch');
  // Validate the complete bundle before touching consumer outputs. Staging
  // contains regular files only; databases/server processes are never shared.
  const stage=mkdtempSync(join(root,'.immutable-build-stage-'));
  try {
    for(const d of bundle.directories)mkdirSync(join(stage,d),{recursive:true});
    for(const file of validated){const path=join(stage,file.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.data,{mode:file.mode});}
    for(const r of bundle.roots) {
      const target=join(root,r);mkdirSync(dirname(target),{recursive:true});rmSync(target,{recursive:true,force:true});renameSync(join(stage,r),target);
    }
  } finally {rmSync(stage,{recursive:true,force:true});}
  return {files:validated.length,bytes};
}
