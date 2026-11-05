import path from 'node:path';
import {codexIntegrationStatus,installCodexIntegration,uninstallCodexIntegration} from '../src/apps/codex-cli/service';
async function main(){
 const action=process.argv[2]||'status';
 if(action==='install')await installCodexIntegration(path.resolve('assets'));
 else if(action==='uninstall')await uninstallCodexIntegration();
 else if(action==='refresh'){if((await codexIntegrationStatus()).installed)await installCodexIntegration(path.resolve('assets'));}
 else if(action!=='status')throw Error('Expected install, uninstall, refresh or status');
 console.log(await codexIntegrationStatus());
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
