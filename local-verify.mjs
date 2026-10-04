import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
const host = process.env.LOCAL_HOST || '127.0.0.1';
const port = Number(process.env.LOCAL_PORT || 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('LOCAL_PORT must be an integer from 0 to 65535');
let source=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
for(const [name,file]of [['HTML','index.html'],['CSS','style.css'],['APP','app.js.txt']])source=source.replace(`import ${name} from './${file}';`,`const ${name}=${JSON.stringify(readFileSync(new URL('./'+file,import.meta.url),'utf8'))};`);
source = source.replace("const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';", "const MODEL = 'local/deterministic-fixture';");
source = source.replace('Synthetic data <span>', 'Local test mode — deterministic fixture, no live AI <span>');
const mock=`import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {async run(model,input){const prompt=input.messages.filter(m=>m.role==='user'&&!m.content.startsWith('Sandbox result: ')).at(-1).content;const results=input.messages.filter(m=>m.content.startsWith('Sandbox result: '));if(!results.length){let code="const rows=await tickets.list();const customers=await tickets.customers();return customers.map(c=>({customer:c.name,urgent:rows.filter(t=>t.customerId===c.id&&t.priority==='urgent'&&t.status!=='closed').length})).sort((a,b)=>b.urgent-a.urgent);";if(prompt.includes('recover'))code='return await tickets.nonexistent();';if(prompt.includes('network'))code="return await fetch('https://example.com').then(r=>r.text());";if(prompt.includes('secrets'))code='return Object.keys(env);';return {response:{action:'execute',description:'Analyze sample tickets',code}};}if(prompt.includes('recover')&&results.length===1)return {response:{action:'execute',description:'Correct the tool call',code:'const rows=await tickets.list();return {total:rows.length};'}};return {response:{action:'final',answer:'Local test fixture result: '+results.at(-1).content.slice(16)}};}}`;
const mf=new Miniflare(convertV4MiniflareOptions({host,port,workers:[{name:'lab',modules:[{type:'ESModule',path:'worker.js',contents:source}],compatibilityDate:'2026-09-01',workerLoaders:{LOADER:{}},durableObjects:{SESSIONS:{className:'Session',useSQLite:true}},serviceBindings:{TICKETS:{name:'lab',entrypoint:'Tickets'},AI:'test-model'}},{name:'test-model',modules:true,script:mock,compatibilityDate:'2026-09-01'}]}));
console.log('Local verification server:',String(await mf.ready));
console.log('Inference is a deterministic test fixture; sandbox and Durable Objects use real workerd.');
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await mf.dispose();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
export { mf };
