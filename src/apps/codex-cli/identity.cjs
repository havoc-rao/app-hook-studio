// Native Codex thread metadata -> CoLink display identity. Never used for routing.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const text=value=>typeof value==='string'&&value.trim()?value:null;
function machineIdentity(directory=path.join(os.homedir(),'Library/Application Support/CoLink')){
 try {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const dir=fs.lstatSync(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077))throw Error('Unsafe identity directory');
  const file=path.join(directory,'machine-id.json');
  if(!fs.existsSync(file)){
   const temp=path.join(directory,`.machine-${crypto.randomUUID()}.tmp`);
   fs.writeFileSync(temp,JSON.stringify({id:`colink:${crypto.randomUUID()}`}),{flag:'wx',mode:0o600});
   try{fs.linkSync(temp,file);}catch(error){if(error.code!=='EEXIST')throw error;}finally{fs.unlinkSync(temp);}
  }
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>4096)throw Error('Unsafe identity file');
  const id=JSON.parse(fs.readFileSync(file,'utf8')).id;
  if(!/^colink:[0-9a-f-]{36}$/.test(id))throw Error('Invalid machine ID');
  return {id,source:'colink.machine-id',scope:'colink-installation',display_name:os.hostname(),display_name_source:'node.os.hostname'};
 }catch{return {id:null,source:'unknown',scope:'colink-installation',display_name:os.hostname(),display_name_source:'node.os.hostname'};}
}
class IdentityContext {
 constructor(machine=machineIdentity()){this.machine=machine;this.threads=new Map();}
 observe(message){
  const thread=message.params?.thread||message.result?.thread;
  if(thread)this.save(thread);
  if(Array.isArray(message.result?.data))for(const t of message.result.data)if(typeof t?.id==='string'&&typeof t.cwd==='string')this.save(t);
  if(message.method==='thread/name/updated'){
   const t=this.threads.get(message.params.threadId);
   if(t)this.threads.set(t.id,{...t,name:text(message.params.threadName),titleObservedAt:Date.now(),metadataObservedAt:Date.now()});
  }
  if(message.method==='thread/project/updated'){
   const t=this.threads.get(message.params.threadId);if(t)this.threads.set(t.id,{...t,projectId:text(message.params.projectId),metadataObservedAt:Date.now()});
  }
 }
 save(t){
  if(!text(t?.id))return;
  const prior=this.threads.get(t.id);
  // A full native Thread carries name, including null. Do not substitute preview.
  if(Number.isFinite(prior?.updatedAt)&&Number.isFinite(t.updatedAt)&&t.updatedAt<prior.updatedAt)return;
  const fields=['id','sessionId','parentThreadId','cwd','projectId','name','source','createdAt','updatedAt'];
  const metadata=Object.fromEntries(fields.filter(key=>Object.hasOwn(t,key)).map(key=>[key,t[key]]));
  this.threads.set(t.id,{...prior,...metadata,titleObservedAt:Date.now(),metadataObservedAt:Date.now()});
  if(this.threads.size>2048)this.threads.delete(this.threads.keys().next().value);
 }
 snapshots(){
  return [...this.threads.values()].filter(t=>!t.parentThreadId && (!t.sessionId || t.id===t.sessionId)).slice(-256).map(t=>{
   const value=this.convert({threadId:t.id});
   value.identity.observed_at=t.metadataObservedAt||t.titleObservedAt;
   return {session_id:value.session_id,identity:value.identity,platform:value.platform};
  });
 }
 convert(p){
  const t=this.threads.get(p.threadId), diagnostics=[];
  if(!t)diagnostics.push('CODEX_THREAD_METADATA_UNAVAILABLE');
  const session=text(t?.sessionId)||p.threadId;
  if(!text(t?.sessionId))diagnostics.push('CODEX_SESSION_ID_FALLBACK_THREAD_ID');
  const parent=text(t?.parentThreadId);
  const sourceChild=!!(t?.source&&typeof t.source==='object'&&t.source.subAgent);
  const child=!!parent||sourceChild;
  const root=this.threads.get(session)||(session===p.threadId?t:undefined);
  const cwd=text(t?.cwd), project=text(t?.projectId);
  const workspaceId=project?`codex:project:${project}`:cwd?`codex:cwd:${crypto.createHash('sha256').update(cwd).digest('hex')}`:null;
  if(!workspaceId)diagnostics.push('CODEX_WORKSPACE_METADATA_UNAVAILABLE');
  if(!this.machine.id)diagnostics.push('COLINK_MACHINE_ID_UNAVAILABLE');
  const title=text(root?.name);
  if(!title)diagnostics.push('CODEX_SESSION_TITLE_UNAVAILABLE');
  return {
   session_id:session,subagent:child,
   platform:{id:'codex',display_name:'Codex CLI',source:'local-codex-cli-proxy'},
   codex_context:{thread_id:p.threadId,session_id:text(t?.sessionId),turn_id:p.turnId||null,parent_thread_id:parent,project_id:project},
   identity:{schema:1,machine:{...this.machine},workspace:{id:workspaceId,source:project?'codex.thread.projectId':cwd?'codex.thread.cwd':'unknown',scope:'codex-thread',kind:cwd?'folder':'unknown',name:cwd?path.basename(cwd):null,workspace_file:null,roots:cwd?[{uri:pathToFileURL(cwd).href,path:cwd,name:path.basename(cwd)}]:[]},
    agent:{id:p.threadId,kind:child?'subagent':'session',source:'codex.thread.id',session_id:session,session_source:text(t?.sessionId)?'codex.thread.sessionId':'codex.request.threadId',parent_agent_id:parent,parent_session_id:parent?session:null,task_tool_call_id:null},
    cwd_source:typeof p.cwd==='string'?'tool-context':'unknown',session:{id:session,title,title_source:title?'codex.thread.name':null,title_observed_at:root?.titleObservedAt??null,created_at:Number.isFinite(root?.createdAt)?root.createdAt*1000:null,updated_at:Number.isFinite(root?.updatedAt)?root.updatedAt*1000:null},observed_at:Date.now(),diagnostics}
  };
 }
}
module.exports={IdentityContext,machineIdentity};
