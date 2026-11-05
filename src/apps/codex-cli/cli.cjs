#!/usr/bin/env node
// Start a per-terminal proxy, retaining the normal Codex terminal interface.
const cp=require('node:child_process'),path=require('node:path');
const args=process.argv.slice(2);
const passCommands=new Set(['agents','exec','e','review','login','logout','mcp','plugin','app-server','remote-control','app','completion','update','doctor','sandbox','debug','apply','a','queue','archive','delete','migrate-rollouts','migrate-nfs-db','unarchive','cloud','exec-server','features','help']);
const valueFlags=new Set(['-c','--config','--enable','--disable','-i','--image','-m','--model','--local-provider','-p','--profile','-s','--sandbox','-C','--cd','--add-dir','-a','--ask-for-approval','--remote-auth-token-env']);
let positional=null;
for(let i=0;i<args.length;i++){if(valueFlags.has(args[i])){i++;continue;}if(!args[i].startsWith('-')){positional=args[i];break;}}
if(args.some(a=>['--remote','--no-daemon','--help','-h','--version','-V'].includes(a)||a.startsWith('--remote='))||passCommands.has(positional)){
 const child=cp.spawn(process.env.COLINK_CODEX_BINARY||'codex',args,{stdio:'inherit'});
 child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
} else start();
function start(){
const broker=cp.spawn(process.execPath,[path.join(__dirname,'cli-proxy.cjs')],{stdio:['ignore','pipe','inherit']});
let tui,buffer='',started=false;
const cleanup=()=>{if(!broker.killed)broker.kill();};
broker.stdout.setEncoding('utf8');broker.stdout.on('data',chunk=>{
 buffer+=chunk;const match=buffer.match(/CoLink CLI proxy ready: (unix:\/\/[^\n]+)/);
 if(!match||started)return;started=true;
 tui=cp.spawn(process.env.COLINK_CODEX_BINARY||'codex',['--remote',match[1],...process.argv.slice(2)],{stdio:'inherit'});
 tui.on('error',error=>{console.error(error.message);cleanup();process.exitCode=1;});
 tui.on('exit',code=>{cleanup();process.exitCode=code??1;});
});
broker.on('error',error=>{console.error(error.message);process.exitCode=1;});
broker.on('exit',code=>{if(tui&&!tui.killed)tui.kill();if(!started)process.exitCode=code||1;});
process.once('exit',cleanup);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(tui)tui.kill(signal);cleanup();});

}
