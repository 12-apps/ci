import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBundle, digest, restoreBundle } from './bundle.mjs';

const mode=process.argv[2];
if(!['locate','produce','restore'].includes(mode)){console.error('usage: main.mjs locate|produce|restore');process.exit(2);}
const output=(key,value)=>{if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);};
const directory=join(process.env.RUNNER_TEMP||process.cwd(),`immutable-build-${digest(process.env.ARTIFACT_NAME||'').slice(0,16)}`);
const file=join(directory,'bundle.json');
if(mode==='locate'){mkdirSync(directory,{recursive:true});output('directory',directory);}
else {
  try {
    const root=process.cwd();
    const command=process.env.BUILD_COMMAND;
    if(!command||!process.env.ARTIFACT_NAME)throw new Error('missing immutable build descriptor');
    const patterns=(process.env.BUILD_PATHS||'').split('\n').map(s=>s.trim()).filter(Boolean);
    const envNames=(process.env.BUILD_ENV_NAMES||'').split('\n').map(s=>s.trim()).filter(Boolean).sort();
    if(!envNames.length||!envNames.every(s=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)))throw new Error('missing or invalid build environment contract');
    const git=args=>execFileSync('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
    git(['diff','--quiet','HEAD','--']);
    const source=git(['rev-parse','HEAD']);
    const lockfile=digest(readFileSync(join(root,'pnpm-lock.yaml')));
    const pnpm=execFileSync('pnpm',['--version'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
    const implementation=digest(Buffer.concat(['bundle.mjs','main.mjs','action.yml'].map(p=>readFileSync(new URL(p,import.meta.url)))));
    const identity={source,lockfile,node:process.version,pnpm,platform:`${process.platform}-${process.arch}`,command,
      environment:digest(JSON.stringify(envNames.map(name=>[name,process.env[name]??null]))),implementation};
    if(mode==='produce') {
      rmSync(file,{force:true});mkdirSync(directory,{recursive:true});
      const bundle=createBundle(root,patterns,identity);
      writeFileSync(file,JSON.stringify(bundle));
      console.log(`Immutable build published locally: ${bundle.files.length} files, ${statSync(file).size} encoded bytes; source=${source}`);
    } else {
      if(!existsSync(file)||statSync(file).size>64*1024*1024)throw new Error('immutable bundle missing or outside its bound');
      const result=restoreBundle(root,patterns,identity,JSON.parse(readFileSync(file,'utf8')));
      console.log(`Immutable build reused: ${result.files} verified files, ${result.bytes} output bytes; source=${source}`);
    }
    output('ready','true');
  } catch(error) {
    output('ready','false');
    console.log(`::notice::Immutable build ${mode} unavailable: ${error.message}; retain local build fallback.`);
  }
}
