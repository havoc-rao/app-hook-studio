// Experimental transport mirror: native requests continue to the original UI.
const fs = require('node:fs'), net = require('node:net'), crypto = require('node:crypto');
const directory = `/tmp/colink-codex-${process.getuid()}`;
const pending = new Map(), owners = new WeakMap(), activeOwners = new Set();
let server, channel;
function state(owner) { if (!owners.has(owner)) owners.set(owner, new Set()); return owners.get(owner); }
function key(owner, id) { return `${owner.options.hostId}:${typeof id}:${id}`; }
function start() {
 if (server) return;
 fs.mkdirSync(directory,{mode:0o700,recursive:true});
 const st=fs.lstatSync(directory);
 if (!st.isDirectory() || st.isSymbolicLink() || st.uid!==process.getuid() || (st.mode&0o077)) throw Error('Unsafe directory');
 const token=crypto.randomBytes(16).toString('hex'), endpoint=`${directory}/${token}.sock`;
 channel={protocol:1,transport:'unix',socket_path:endpoint,window_id:token};
 server=net.createServer(socket=>{
  let buffer=''; socket.setTimeout(3000,()=>socket.destroy());
  socket.on('error',()=>{});
  socket.on('data',async data=>{
   buffer+=data; if(buffer.length>65536)return socket.destroy();
   if(!buffer.includes('\n'))return;
   socket.pause();
   let response;
   try {
    const input=JSON.parse(buffer.split('\n')[0]);
    if(input.protocol!==1)throw Error('Invalid protocol');
    if(input.op==='list') response={window_id:token,requests:[...pending.values()].map(v=>v.request),sessions:[...activeOwners].flatMap(owner=>owner.sessionDisplays?.()||[])};
    else if(input.op==='respond') {
     const entry=pending.get(input.request_id);
     if(!entry || !['allow','reject'].includes(input.action)) throw Error('NOT_PENDING_OR_UNSUPPORTED');
     if(entry.owner.connection!==entry.connection) { pending.delete(input.request_id); throw Error('DISCONNECTED'); }
     await entry.owner.handleClientResponse({id:entry.id,result:{decision:input.action==='allow'?'accept':'decline'}},entry.thread);
     response={status:'submitted',request_id:input.request_id,action:input.action};
    } else throw Error('Invalid operation');
    socket.end(JSON.stringify({protocol:1,ok:true,...response})+'\n');
   } catch(error) {socket.end(JSON.stringify({protocol:1,ok:false,error:{code:'NOT_PENDING',message:String(error)}})+'\n');}
  });
 });
 server.on('error',()=>{});
 server.listen(endpoint,()=>{fs.chmodSync(endpoint,0o600);fs.writeFileSync(endpoint+'.json',JSON.stringify(channel),{mode:0o600});});
 server.unref();
 process.once('exit',()=>{try{fs.unlinkSync(endpoint+'.json');fs.unlinkSync(endpoint);}catch{}});
}
exports.observe=(owner,message)=>{
 try {
  if(message.method!=='item/commandExecution/requestApproval')return;
  if(typeof message.params?.command!=='string' || !message.params.command || message.params.networkApprovalContext)return;
  // Only local transport: remote approvals require separate routing validation.
  if(!owner.isLocalAppServerConnection())return;
  start();
  const id=key(owner,message.id), p=message.params;
  state(owner).delete(id);
  pending.set(id,{owner,id:message.id,thread:p.threadId,connection:owner.connection,request:{
   request_id:id,session_id:p.threadId,tool_call_id:p.itemId||String(message.id),
   supported_actions:['allow','reject'],tool_name:message.method.includes('commandExecution')?'Bash':'apply_patch',
   tool_input:{command:p.command||'',grantRoot:p.grantRoot},cwd:p.cwd||'',subagent:false,
   reason:p.reason||'',created_at:Date.now(),expires_at:Date.now()+86400000,approval_channel:channel,
   ...(owner.approvalMetadata?owner.approvalMetadata(p):{})
  }});
 }catch{}
};
exports.claim=(owner,id)=>{
 const k=key(owner,id), done=state(owner);
 if(done.has(k))return false;
 if(pending.has(k)){pending.delete(k);done.add(k);if(done.size>8192)done.delete(done.values().next().value);}
 return true;
};
exports.notification=(owner,message)=>{
 if(message.method==='serverRequest/resolved') {const k=key(owner,message.params.requestId);pending.delete(k);state(owner).add(k);}
 if(message.method==='turn/completed')for(const [k,v] of pending)if(v.owner===owner&&v.thread===message.params.threadId)pending.delete(k);
};
exports.attach=owner=>activeOwners.add(owner);
exports.clear=owner=>{activeOwners.delete(owner);for(const [k,v] of pending)if(v.owner===owner)pending.delete(k);};

try { start(); } catch {}
