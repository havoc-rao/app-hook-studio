const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
const bridge=require('../src/apps/codex-cli/native-channel.cjs');
let sent=[];
const owner={options:{hostId:'colink-test'},connection:{},isLocalAppServerConnection:()=>true,
 async handleClientResponse(message){if(bridge.claim(this,message.id))sent.push(message);}};
function request(id){bridge.observe(owner,{id,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',itemId:'test-item',command:'true',cwd:'/tmp'}});}
const call=(path,data)=>new Promise((resolve,reject)=>{const s=net.createConnection(path);s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({protocol:1,...data})+'\n'));let b='';s.on('data',d=>{b+=d;if(b.includes('\n')){s.destroy();resolve(JSON.parse(b));}});});
(async()=>{
 request(1);await new Promise(r=>setTimeout(r,50));
 const directory=`/tmp/colink-codex-${process.getuid()}`;
 let channel;
 for(const file of fs.readdirSync(directory).filter(f=>f.endsWith('.json'))){const c=JSON.parse(fs.readFileSync(directory+'/'+file));const list=await call(c.socket_path,{op:'list'}).catch(()=>null);if(list?.requests?.some(r=>r.session_id==='test-thread'))channel=c;}
 assert(channel);
 let list=await call(channel.socket_path,{op:'list'});
 assert((await call(channel.socket_path,{op:'respond',request_id:list.requests[0].request_id,action:'allow'})).ok);
 await owner.handleClientResponse({id:1,result:{decision:'decline'}});assert.equal(sent.length,1);
 request(2);await owner.handleClientResponse({id:2,result:{decision:'decline'}});
 assert.equal((await call(channel.socket_path,{op:'list'})).requests.length,0);
 request(3);bridge.notification(owner,{method:'serverRequest/resolved',params:{requestId:3}});
 assert.equal((await call(channel.socket_path,{op:'list'})).requests.length,0);
 console.log('PASS: Raycast-first, native-first, duplicate response, resolved cleanup');
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
