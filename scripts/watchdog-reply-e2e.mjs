// A watchdog launches ordinary Claude under dtach, without --remote-control.
// Exercise real Box HTTP/WebSocket + mobile browser + terminal attachment with
// synthetic transcripts and a local terminal fixture; never use real credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { webkit } from '@playwright/test';
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'boxwatchdogtest'));
const id = randomUUID();
const sock = `/tmp/cc-evt-test-${id}.dtach`;
const token = 'synthetic-watchdog-test';
const port = await new Promise(r => { const s=createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));}); });
const base = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: home, LANG:'C.UTF-8', BOX_TEAM:'0', BOX_HOST_SECRETS_FILE:'/dev/null', BOX_IGNORE_LOCAL_ENV:'1', BOX_SKIP_META_PROBE:'1', LINEAR_LOCAL:'off', CC_WORKSPACE:home, CC_AUTH_TOKEN:token, PORT:String(port) };
const project = join(home,'.claude','projects',home.replace(/[^a-zA-Z0-9]/g,'-'));
mkdirSync(project,{recursive:true});
const transcript = join(project,`${id}.jsonl`);
const row=(type,text)=>JSON.stringify({type,sessionId:id,uuid:randomUUID(),timestamp:new Date().toISOString(),cwd:home,message:{role:type,content:[{type:'text',text}],...(type==='assistant'?{stop_reason:'end_turn'}:{})}})+'\n';
writeFileSync(transcript,row('user','Synthetic watchdog task')+row('assistant','Watchdog ready'));
const fixture=join(home,'terminal.py');
writeFileSync(fixture,`import os,sys,tty,signal,json,uuid,datetime\ntty.setraw(0)\nopen(sys.argv[2],'w').write(str(os.getpid()))\nsignal.signal(signal.SIGWINCH,lambda *_:os.write(1,b'Claude ready > '))\nos.write(1,b'Claude ready > ')\nbuf=b''\nwhile True:\n c=os.read(0,4096)\n if not c: break\n buf+=c\n if b'\\r' not in buf: continue\n text=buf.replace(b'\\x1b[200~',b'').replace(b'\\x1b[201~',b'').strip().decode()\n buf=b''\n if text=='exit fixture': sys.exit(0)\n with open(sys.argv[1],'a') as f:\n  for role,value in [('user',text),('assistant','Fixture reply: '+text)]:\n   f.write(json.dumps({'type':role,'uuid':str(uuid.uuid4()),'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'message':{'role':role,'content':[{'type':'text','text':value}],'stop_reason':'end_turn' if role=='assistant' else None}})+'\\n')\n os.write(1,b'Claude ready > ')\n`);
const pidFile=join(home,'fixture.pid');
execFileSync('dtach',['-n',sock,'bash','-c','exec -a claude python3 "$@"','fixture',fixture,transcript,pidFile,'--session-id',id],{env});
let child, browser;
const until=async(fn,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for synthetic watchdog test');};
try {
 await until(()=>Number(readFileSync(pidFile,'utf8'))>0);
 const fixturePid=Number(readFileSync(pidFile,'utf8'));
 child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
 child.stderr.on('data', d => process.stderr.write(d));
 await until(async()=> (await fetch(base)).ok);
 browser=await webkit.launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.goto(base);
 await page.locator('#tokenInput').fill(token); await page.locator('#loginBtn').click();
 await page.locator('#sessions:not(.hidden)').waitFor();
 await page.evaluate(s=>openChat(s),{id,cwd:home,title:'Synthetic watchdog session',agent:'claude'});
 await page.locator('#chat:not(.hidden)').waitFor();
 // The fixture answers immediately; disable task-finisher reminders so it cannot
 // generate unrelated synthetic turns between the completion and exit assertions.
 await page.evaluate(async id => {
  const response = await api(`/api/sessions/${id}/autocontinue`, {method:'PUT',body:JSON.stringify({enabled:false})});
  if (!response.ok) throw Error('Could not disable synthetic task finisher');
 }, id);
 await page.locator('#input').fill('Now?'); await page.locator('#sendBtn').click();
 try { await page.getByText('Fixture reply: Now?',{exact:true}).waitFor({timeout:30000}); } catch (e) { console.error(await page.locator('body').innerText()); console.error(readFileSync(transcript,'utf8')); throw e; }
 await page.waitForFunction(()=>!running);
 assert.equal(Number(readFileSync(pidFile,'utf8')),fixturePid,'reply must use original watchdog terminal');
 const commands=execFileSync('ps',['-ww','-p',String(fixturePid),'-o','args='],{encoding:'utf8'});
 assert.match(commands,/^claude /);
 assert.doesNotMatch(commands,/--remote-control/);
 await page.screenshot({path:join(home,'watchdog-reply.png')});
 // Exiting after input submission must immediately end the phone spinner.
 await page.locator('#input').fill('exit fixture'); await page.locator('#sendBtn').click();
 await page.getByText(/Claude disconnected before the reply completed/).waitFor({timeout:10000});
 await page.waitForFunction(()=>!running);
 console.log('PASS: watchdog reply attaches to original plain Claude terminal and completes; terminal exit ends spinner');
 if(process.env.BOX_TEST_SCREENSHOT) execFileSync('cp',[join(home,'watchdog-reply.png'),process.env.BOX_TEST_SCREENSHOT]);
} finally {
 await browser?.close();
 child?.kill('SIGTERM');
 if(child && child.exitCode===null) await new Promise(r=>child.once('exit',r));
 try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGTERM');}catch{}
 try{rmSync(sock);}catch{}
 rmSync(home,{recursive:true,force:true});
}
