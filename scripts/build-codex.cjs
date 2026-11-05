const fs=require('node:fs'),path=require('node:path');
const target=path.resolve('assets/codex-cli');fs.mkdirSync(target,{recursive:true});
for(const name of ['cli.cjs','cli-proxy.cjs','native-channel.cjs','identity.cjs'])fs.copyFileSync(path.resolve('src/apps/codex-cli',name),path.join(target,name));
const ws=path.dirname(require.resolve('ws/package.json'));
fs.cpSync(ws,path.join(target,'node_modules/ws'),{recursive:true});

fs.writeFileSync(path.join(target,'runtime.json'),JSON.stringify({node:process.execPath}));
