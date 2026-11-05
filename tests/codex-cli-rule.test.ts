import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeCodexShellRule } from '../src/apps/codex-cli/service';
const begin='# >>> App Hook Studio Codex CLI >>>',end='# <<< App Hook Studio Codex CLI <<<';
test('unregistering Codex removes only its managed block and preserves user configuration',()=>{
 const original='export EDITOR=vim\n';const after='alias ll="ls -l"\n';
 assert.equal(removeCodexShellRule(original+begin+'\nfunction codex() { echo managed; }\n'+end+'\n'+after),original+after);
 assert.equal(removeCodexShellRule(original+after),original+after);
});
test('ambiguous or incomplete shell rule refuses to remove user configuration',()=>{
 assert.throws(()=>removeCodexShellRule(begin+'\nmissing end'));
 assert.throws(()=>removeCodexShellRule(begin+'\n'+end+'\n'+begin+'\n'+end));
});
