import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {IdentityContext,machineIdentity}=require('../src/apps/codex-cli/identity.cjs');
test('Codex proxy keeps PC identity stable across independent launches',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ahs-codex-machine-'));
 try{const first=machineIdentity(directory),second=machineIdentity(directory);assert.ok(first.id);assert.equal(first.id,second.id);assert.equal(first.scope,'colink-installation');}
 finally{rmSync(directory,{recursive:true,force:true});}
});
test('native session tree preserves child routing ID, parent, workspace and title snapshots',()=>{
 const context=new IdentityContext({id:'pc',source:'colink.machine-id',scope:'colink-installation'});
 context.observe({params:{thread:{id:'root',sessionId:'root',cwd:'/work',name:'Original'}}});
 context.observe({params:{thread:{id:'child',sessionId:'root',parentThreadId:'root',cwd:'/work',name:'Child'}}});
 const before=context.convert({threadId:'child',turnId:'turn',cwd:'/work/command-dir'});
 assert.equal(before.session_id,'root');assert.equal(before.codex_context.thread_id,'child');assert.equal(before.subagent,true);
 assert.equal(before.identity.agent.parent_agent_id,'root');assert.equal(before.identity.workspace.roots[0].path,'/work');assert.equal(before.identity.session.title,'Original');
 context.observe({method:'thread/name/updated',params:{threadId:'root',threadName:'Renamed'}});
 assert.equal(context.convert({threadId:'child'}).identity.session.title,'Renamed');assert.equal(before.identity.session.title,'Original');
});
test('unknown native metadata is explicit rather than synthesized from command context',()=>{
 const result=new IdentityContext({id:'pc'}).convert({threadId:'unknown',cwd:'/command-dir'});
 assert.equal(result.identity.workspace.id,null);assert.equal(result.identity.session.title,null);
 assert.ok(result.identity.diagnostics.includes('CODEX_THREAD_METADATA_UNAVAILABLE'));
});

test('post-approval native rename exports a separate latest display with real thread times',()=>{
 const context=new IdentityContext({id:'pc'});
 context.observe({params:{thread:{id:'root',sessionId:'root',cwd:'/work',name:null,createdAt:100,updatedAt:200}}});
 const approval=context.convert({threadId:'root'});
 context.observe({method:'thread/name/updated',params:{threadId:'root',threadName:'Actual native title'}});
 const latest=context.snapshots()[0];
 assert.equal(latest.identity.session.title,'Actual native title');
 assert.equal(latest.identity.session.created_at,100000);assert.equal(latest.identity.session.updated_at,200000);
 assert.equal(approval.identity.session.title,null);
});
