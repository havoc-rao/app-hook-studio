#!/usr/bin/env node
// A private newline-delimited JSON-RPC transport for `codex --remote`.
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),crypto=require('node:crypto');
const bridge=require('./native-channel.cjs');
const {IdentityContext}=require('./identity.cjs');
const machine=require('./identity.cjs').machineIdentity();
const directory=`/tmp/colink-codex-${process.getuid()}`;
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('Unsafe channel directory');
const endpoint=`${directory}/cli-${process.pid}.rpc`;
const codex=process.env.COLINK_CODEX_BINARY||'codex';
const sessions=new Set();
function lines(stream,onLine,onError){let buffer='';stream.setEncoding('utf8');stream.on('data',chunk=>{
 buffer+=chunk;if(Buffer.byteLength(buffer)>256*1024*1024){onError(Error('Protocol message too large'));return;}
 let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())try{onLine(JSON.parse(line));}catch(error){onError(error);return;}}
});}
const http=require('node:http');
const {WebSocketServer}=require('ws');
const server=http.createServer();
const websocket=new WebSocketServer({server,maxPayload:256*1024*1024});
websocket.on('connection',client=>{
 const backend=cp.spawn(codex,['app-server','--listen','stdio://'],{stdio:['pipe','pipe','inherit']});
 const identity=new IdentityContext(machine);
 const owner={approvalMetadata:p=>identity.convert(p),sessionDisplays:()=>identity.snapshots(),options:{hostId:crypto.randomBytes(12).toString('hex')},connection:backend,isLocalAppServerConnection:()=>true,
  async handleClientResponse(message,thread){
   if(!bridge.claim(this,message.id))return;
   await new Promise((resolve,reject)=>backend.stdin.write(JSON.stringify(message)+'\n',e=>e?reject(e):resolve()));
  }};
 bridge.attach(owner);
 sessions.add(backend);let closed=false;
 const close=(reason)=>{if(reason)console.error("CoLink transport closed:",reason.message||String(reason));if(closed)return;closed=true;bridge.clear(owner);owner.connection=null;sessions.delete(backend);client.terminate();backend.kill();};
 client.on('error',close);client.on('close',close);backend.on('error',close);backend.on('exit',(code,signal)=>close(Error(`backend exit ${code}/${signal}`)));backend.stdin.on('error',close);
 client.on('message',raw=>{
  let message;try{message=JSON.parse(raw.toString());}catch{return close(Error('Invalid client JSON'));}
  if(process.env.COLINK_TRACE)console.error('client',message.method||'response',message.id??'');
  if('id'in message&&!('method'in message))owner.handleClientResponse(message).catch(close);
  else backend.stdin.write(JSON.stringify(message)+'\n');
 });
 lines(backend.stdout,message=>{
  identity.observe(message);
  if(process.env.COLINK_TRACE)console.error('server',message.method||'response',message.id??'',message.error?.code??'');
  if(message.method&&'id'in message)bridge.observe(owner,message);
  else if(message.method)bridge.notification(owner,message);
  if(client.readyState===1)client.send(JSON.stringify(message));
 },close);
});
server.on('error',error=>{console.error(error);process.exit(1);});
server.listen(endpoint,()=>{fs.chmodSync(endpoint,0o600);console.log(`CoLink CLI proxy ready: unix://${endpoint}`);});
process.on('exit',()=>{try{fs.unlinkSync(endpoint);}catch{}for(const child of sessions)child.kill();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.exit(0));
