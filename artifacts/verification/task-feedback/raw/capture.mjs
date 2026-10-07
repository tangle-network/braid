import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const repository = process.argv[2]
const require = createRequire(join(repository, 'package.json'))
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const { installPackedBraid } = await import(pathToFileURL(join(repository, 'scripts/packed-binary.mjs')))
const { writeCastGif, captureProvenance } = await import(pathToFileURL(join(repository, 'scripts/capture-visual-support.mjs')))
async function writeRaster(cast, png, gif) {
  execFileSync('/tmp/braid-feedback-tools/agg', ['--quiet','--theme','github-dark','--font-size','16','--idle-time-limit','1','--last-frame-duration','1','--select','100%','--no-loop','--font-family','DejaVu Sans Mono',cast,gif])
  execFileSync('ffmpeg', ['-loglevel','error','-y','-i',gif,'-frames:v','1',png])
  await rm(gif)
}
const root = process.argv[3]
await mkdir(join(root, 'raw'), { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const packed = await installPackedBraid(repository)
const artifacts = []
async function run(columns, rows) {
  const temp = await mkdtemp(join(tmpdir(), 'braid-feedback-pty-'))
  const emulator = new Terminal({ cols: columns, rows, allowProposedApi: true })
  const events = []
  const start = performance.now()
  let pending = 0, last = start, exited = false
  const env = { ...process.env, TERM: 'xterm-256color', BRAID_JOURNAL_PATH: join(temp, 'fixture.jsonl') }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  const record = join(temp, 'state.json')
  const session = pty.spawn(process.execPath, [packed.binary, '--fixture', 'deterministic', '--record-state', record], {name:'xterm-256color', cols:columns, rows, cwd:temp, env})
  const exit = new Promise(r => session.onExit(result => { exited = true; r(result) }))
  const screen = () => Array.from({length:rows}, (_, i) => emulator.buffer.active.getLine(emulator.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n')
  session.onData(data => { events.push([(performance.now()-start)/1000,'o',data]); last=performance.now();pending++;emulator.write(data,()=>pending--) })
  const input = data => {events.push([(performance.now()-start)/1000,'i',data]);session.write(data)}
  async function wait(check, label) {const deadline=Date.now()+15000;while(!check()) {if(Date.now()>deadline) throw Error(`${columns}x${rows} ${label}\n${screen()}`);await sleep(20)}}
  async function settled() { await wait(()=>pending===0&&performance.now()-last>120,'settle') }
  async function command(value) { input(value);await sleep(40);input('\r');await sleep(80);await settled() }
  const cast = es => [JSON.stringify({version:2,width:columns,height:rows,timestamp:Math.floor(Date.now()/1000),title:'Braid task feedback',command:'packed braid --fixture deterministic',env:{TERM:'xterm-256color'},stdin:true}),...es.map(e=>JSON.stringify(e)),''].join('\n')
  async function frame(name) {await settled();const base=`${columns}x${rows}-${name}`;const txt=join(root,`${base}.txt`);const png=join(root,`${base}.png`);const raw=join(root,'raw',`${base}.cast`);await writeFile(txt,screen()+'\n');await writeFile(raw,cast([[0,'o',`\u001b[2J\u001b[H${screen().split('\n').join('\r\n')}`],[.1,'o','\u001b[0m']]));await writeRaster(raw,png,join(root,'raw',`${base}.gif`));for(const file of [txt,png,raw])artifacts.push({path:file.slice(root.length+1),sha256:await digest(file)})}
  try {
    await wait(()=>screen().includes('Braid')||screen().includes('braid'),'ready');await settled()
    await command('/feedback list');await wait(()=>screen().includes('Task feedback'),'empty feedback');assert(screen().includes('No feedback.'));await frame('empty')
    input('\u001b');await sleep(250);await settled()
    await command('Inspect the source and cite the check.');await wait(()=>/run result/iu.test(screen()),'run finished');await settled()
    await command('/feedback accept Cited the source and passing check.');await wait(()=>screen().includes('feedback saved'),'saved');await settled()
    await command('/feedback list');await wait(()=>screen().includes('Task feedback')&&screen().includes('Accepted'),'feedback list');await frame('list')
    input('\r');await wait(()=>screen().includes('Decision: accepted'),'feedback detail');await settled();await frame('detail')
    input('\u001b');await sleep(250);await settled();input('\u001b');await sleep(250);await settled()
    await command('/feedback list');await wait(()=>screen().includes('Task feedback')&&screen().includes('Accepted'),'reopened')
    input('\u001b');await sleep(250);await settled();input('\u0003');await sleep(100);input('\u0003')
    const result=await Promise.race([exit,sleep(5000).then(()=>{throw Error('exit timeout')})]);assert.equal(result.exitCode,0)
    const state=JSON.parse(await readFile(record,'utf8'))
    assert(JSON.stringify(state).includes('braid.task-feedback'))
    if(columns===80) {const file=join(root,'raw','feedback-keyboard.cast');await writeFile(file,cast(events));const gif=join(root,'feedback-keyboard.gif');await writeCastGif(file,gif);for(const path of [file,gif])artifacts.push({path:path.slice(root.length+1),sha256:await digest(path)})}
  } finally {if(!exited)session.kill();emulator.dispose();await rm(temp,{recursive:true,force:true})}
}
try {
 for(const [columns,rows] of [[40,12],[80,24],[120,40],[200,60]]) {await run(columns,rows);process.stdout.write(`Captured ${columns}x${rows}\n`)}
 await writeFile(join(root,'manifest.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),generatedAt:new Date().toISOString(),command:'node /tmp/braid-feedback-capture.mjs <repository> <output>',binary:'clean npm install from locally built tarball',tarball:packed.tarballName,tarballSha256:packed.tarballSha256,provenance:await captureProvenance(),fixture:'deterministic runtime fixture; no live provider integration claim',steps:['open empty feedback list','run task to completion','accept with reason','inspect list and detail','close and reopen feedback list','exit cleanly'],artifacts},null,2)+'\n')
} finally {await packed.cleanup()}
