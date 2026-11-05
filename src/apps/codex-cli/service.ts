import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {codexCliRule} from './rule';
const exec=promisify(execFile);
const support=path.join(os.homedir(),'Library/Application Support/App Hook Studio');
const runtime=path.join(support,'codex-cli');
const shellFile=path.join(process.env.ZDOTDIR || os.homedir(),'.zshrc');
const begin='# >>> App Hook Studio Codex CLI >>>',end='# <<< App Hook Studio Codex CLI <<<';
const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
async function readShell(){try{return await fs.readFile(shellFile,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return '';throw e;}}
export function removeCodexShellRule(text:string){const first=text.indexOf(begin);if(first<0)return text;const last=text.indexOf(end,first);if(last<0||text.indexOf(begin,first+begin.length)>=0)throw Error('App Hook Studio shell rule markers are inconsistent');return text.slice(0,first)+text.slice(last+end.length).replace(/^\r?\n/,'');}
export async function codexIntegrationStatus(){
 const text=await readShell();
 let config:{official?:string;node?:string;version?:string;installedAt?:string}={};try{config=JSON.parse(await fs.readFile(path.join(runtime,'installation.json'),'utf8'));}catch{}
 return {installed:text.includes(begin),shellFile,runtimeDirectory:runtime,...config};
}
async function findNode(assets:string){
 const candidates=['/opt/homebrew/bin/node','/usr/local/bin/node'];
 try{const built=JSON.parse(await fs.readFile(path.join(assets,'codex-cli/runtime.json'),'utf8'));if(typeof built.node==='string')candidates.unshift(built.node);}catch{}
 try{const root=path.join(os.homedir(),'.nvm/versions/node');for(const version of (await fs.readdir(root)).sort().reverse())candidates.push(path.join(root,version,'bin/node'));}catch{}
 for(const candidate of candidates)try{const version=(await exec(candidate,['--version'])).stdout.trim();if(Number(version.replace(/^v/,'').split('.')[0])>=22)return candidate;}catch{}
 throw Error('Node.js 22 or newer is required. Rebuild the App Hook Studio runtime after installing Node.');
}
export async function installCodexIntegration(assets:string, official:string=codexCliRule.officialEntry, node?:string){
 node=node || await findNode(assets);
 const binary=await fs.realpath(official);
 const version=(await exec(binary,['--version'])).stdout.trim();
 const help=(await exec(binary,['--help'])).stdout;
 if(!help.includes('--remote'))throw Error('Installed Codex does not support --remote');
 await exec(node,['--version']);
 const text=await readShell();const clean=removeCodexShellRule(text);
 await fs.mkdir(support,{recursive:true,mode:0o700});
 const staging=path.join(support,`codex-cli-stage-${process.pid}`);
 await fs.cp(path.join(assets,'codex-cli'),staging,{recursive:true,force:true});
 // Resolve through the package-manager entry point on every launch so upgrades remain visible.
 await fs.writeFile(path.join(staging,'installation.json'),JSON.stringify({rule:codexCliRule.id,official,node,version,installedAt:new Date().toISOString()}),{mode:0o600});
 const previous=runtime+'.previous';await fs.rm(previous,{recursive:true,force:true});
 try{await fs.rename(runtime,previous);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await fs.rename(staging,runtime);
 const block=`${begin}\nfunction codex() {\n  COLINK_CODEX_BINARY=${quote(official)} ${quote(node)} ${quote(path.join(runtime,'cli.cjs'))} "$@"\n}\n${end}\n`;
 await fs.mkdir(path.dirname(shellFile),{recursive:true});
 await fs.writeFile(path.join(support,`zshrc-before-codex-${Date.now()}`),text,{mode:0o600});
 await fs.writeFile(shellFile,clean+(clean&&!clean.endsWith('\n')?'\n':'')+block);
 return codexIntegrationStatus();
}
export async function uninstallCodexIntegration(){
 const text=await readShell();await fs.writeFile(shellFile,removeCodexShellRule(text));
 // Retain runtime for active terminals and keep the backup for recovery.
 return codexIntegrationStatus();
}
