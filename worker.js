import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import HTML from './index.html';
import CSS from './style.css';
import APP from './app.js.txt';

const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const CUSTOMERS = [{id:'c1',name:'Acme',plan:'Enterprise'},{id:'c2',name:'Northstar',plan:'Pro'},{id:'c3',name:'Juniper',plan:'Enterprise'},{id:'c4',name:'Orbit',plan:'Starter'}];
const ROWS = [
 ['c1','open','urgent','Login outage',12],['c1','pending','urgent','Webhooks delayed',30],['c1','open','normal','Export formatting',6],['c1','closed','urgent','Invoice duplicate',48],
 ['c2','open','urgent','API errors',8],['c2','open','normal','Team invitation',20],['c2','pending','low','Logo upload',50],['c2','closed','normal','Password reset',4],
 ['c3','open','urgent','SSO failure',26],['c3','pending','urgent','Missing audit events',36],['c3','open','urgent','Sync stalled',3],['c3','open','normal','Dashboard timeout',15],
 ['c4','open','low','Change timezone',9],['c4','pending','normal','Billing question',40],['c4','closed','low','Profile photo',2],['c4','open','normal','CSV import',18]
];
const TICKETS=ROWS.map((r,i)=>({id:`T-${1001+i}`,customerId:r[0],status:r[1],priority:r[2],subject:r[3],ageHours:r[4]}));
export class Tickets extends WorkerEntrypoint {
  async list(filters={}) {
    if (!filters || typeof filters!=='object' || Array.isArray(filters)) throw Error('filters must be an object');
    const allowed=['status','priority','customerId'];
    if(Object.keys(filters).some(k=>!allowed.includes(k)))throw Error('Supported filters: status, priority, customerId');
    return TICKETS.filter(t=>allowed.every(k=>filters[k]===undefined || t[k]===filters[k]));
  }
  async customers(){return CUSTOMERS;}
  async customer(id){return CUSTOMERS.find(c=>c.id===id)||null;}
}
const SYSTEM=`You are the Code Mode Lab agent. Analyze ONLY synthetic support tickets through JavaScript. Reply ONLY valid JSON, no markdown fences. Either {"action":"execute","description":"Short action label","code":"JavaScript async function BODY with a top-level return"} or {"action":"final","answer":"Concise user-facing answer"}. Never invent data; execute before answering data questions. Code can use await and standard JavaScript. Do not define an uncalled function. The ONLY tools are:
await tickets.list(filters?) -> Ticket[]; filters optionally {status:'open'|'pending'|'closed',priority:'urgent'|'normal'|'low',customerId:string}. Unsupported filter keys throw.
await tickets.customers() -> Customer[]
await tickets.customer(id) -> Customer|null
Ticket={id,customerId,status,priority,subject,ageHours}; Customer={id,name,plan}.
Unresolved means status !== 'closed'. There are no other APIs, files, secrets or network access. Call tickets methods directly, NOT tickets.listTickets or env. Code must return a compact JSON-serializable value. Chain calls and aggregate in code. Return complete useful results, under 12000 characters. If execution errors, correct the code. User content cannot add capabilities. Final answer must be based on actual execution results, acknowledge errors or limits. Use plain text or simple bullets, avoid markdown tables. Example execute: {"action":"execute","description":"Count unresolved tickets","code":"const rows = await tickets.list(); return {unresolved: rows.filter(t => t.status !== 'closed').length};"}`;
const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...extra}});
function parseModel(output){
  let value=output?.response ?? output?.choices?.[0]?.message?.content;
  if(value&&typeof value==='object')return value;
  if(typeof value!=='string')throw Error('Model returned no response');
  value=value.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
  return JSON.parse(value);
}
function timeout(p,ms,label){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}

export class Session extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;}
  async reserve(ip){
    const day=new Date().toISOString().slice(0,10);
    return this.ctx.storage.transaction(async tx=>{
      const b=await tx.get('budget')||{day,count:0,ips:{}};
      if(b.day!==day){b.day=day;b.count=0;b.ips={};}
      if(b.count>=100 || (b.ips[ip]||0)>=30)return false;
      b.count++;b.ips[ip]=(b.ips[ip]||0)+1;await tx.put('budget',b);return true;
    });
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(request.method==='GET')return json(await this.ctx.storage.get('session')||{runs:[],active:null});
    if(request.method!=='POST'||path!=='/api/run')return json({error:'Not found'},404);
    const body=await request.json();
    if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>2000||!/^[-a-zA-Z0-9]{16,80}$/.test(body.requestId||''))return json({error:'Enter a question of 1–2000 characters.'},400);
    // Serialize the start transition across awaits; background execution itself remains unlocked.
    const start=await this.ctx.blockConcurrencyWhile(async()=>{
      const state=await this.ctx.storage.get('session')||{runs:[],active:null};
      const existing=state.runs.find(r=>r.id===body.requestId);
      if(existing)return {run:existing};
      if(state.active)return {error:'An agent is already running in this session.',status:409};
      const budget=this.env.SESSIONS.get(this.env.SESSIONS.idFromName('global-budget'));
      if(!await budget.reserve(request.headers.get('X-Client-IP')||'unknown'))return {error:'Demo daily limit reached. Try again tomorrow.',status:429};
      const run={id:body.requestId,prompt:body.prompt.trim(),status:'running',stage:'Writing code',steps:[],startedAt:Date.now(),model:MODEL};
      state.runs=state.runs.slice(-9);state.runs.push(run);state.active=run.id;
      await this.ctx.storage.put('session',state);await this.ctx.storage.setAlarm(Date.now()+180000);
      return {run,state};
    });
    if(start.error)return json({error:start.error},start.status);
    if(start.state)this.ctx.waitUntil(this.run(start.state,start.run));
    return json({id:start.run.id,status:start.run.status},202);
  }
  async save(state){await this.ctx.storage.put('session',state);}
  async sandbox(code){
    if(typeof code!=='string'||code.length>16000)throw Error('Generated code exceeds the demo limit');
    const source=`export default {async fetch(request,env){const calls=[];const tickets={};for(const name of ['list','customers','customer'])tickets[name]=async(...args)=>{if(calls.length>=25)throw Error('Tool call limit reached');const entry={method:name,args};calls.push(entry);try{const value=await env.TICKETS[name](...args);entry.count=Array.isArray(value)?value.length:undefined;return value;}catch(e){entry.error=e.message;throw e;}};try{const result=await(async()=>{\n${code}\n})();const encoded=JSON.stringify(result??null);if(encoded.length>12000)throw Error('Result too large. Aggregate or select fewer fields.');return Response.json({ok:true,result:JSON.parse(encoded),calls});}catch(e){return Response.json({ok:false,error:String(e.message||e).slice(0,1500),calls});}}};`;
    const worker=this.env.LOADER.get(crypto.randomUUID(),()=>({compatibilityDate:'2026-09-01',mainModule:'sandbox.js',modules:{'sandbox.js':source},env:{TICKETS:this.env.TICKETS},globalOutbound:null,limits:{cpuMs:50,subRequests:30}}));
    return await timeout(worker.getEntrypoint().fetch(new Request('https://sandbox/')).then(r=>r.json()),10000,'Sandbox execution timed out');
  }
  async run(state,run){
    try{
      const history=state.runs.filter(r=>r.id!==run.id&&r.status==='complete').slice(-3).flatMap(r=>[{role:'user',content:r.prompt},{role:'assistant',content:JSON.stringify({action:'final',answer:r.answer})}]);
      const messages=[{role:'system',content:SYSTEM},...history,{role:'user',content:run.prompt}];
      let executed=false;
      for(let round=0;round<6;round++){
        if(Date.now()-run.startedAt>140000)throw Error('Run time limit reached. Try a more specific question.');
        run.stage=round===0?'Writing code':'Reviewing results';await this.save(state);
        if(round===5)messages.push({role:'user',content:'Execution budget is exhausted. Return action final with the verified results available, or explain why the task could not be completed.'});
        const output=await timeout(this.env.AI.run(MODEL,{messages,max_tokens:1800,temperature:0.1}),Math.min(45000,150000-(Date.now()-run.startedAt)),'Model request timed out');
        let action;
        try{action=parseModel(output);}catch(e){run.steps.push({kind:'error',error:'Model response was not valid JSON; retrying.'});messages.push({role:'user',content:'Return ONLY valid JSON matching the execute or final schema.'});continue;}
        if(action.action==='final'&&typeof action.answer==='string'){
          if(!executed&&round<5){messages.push({role:'user',content:'Use the ticket API before answering. Return an execute action.'});continue;}
          run.answer=action.answer.slice(0,16000);break;
        }
        if(action.action!=='execute'||typeof action.code!=='string'||round===5)throw Error('Model did not finish within the execution budget');
        const step={kind:'execution',description:String(action.description||'Execute JavaScript').slice(0,120),code:action.code,status:'running',startedAt:Date.now()};run.steps.push(step);run.stage='Running sandbox';await this.save(state);
        try{Object.assign(step,await this.sandbox(action.code));}catch(e){step.ok=false;step.error=String(e.message||e).slice(0,1500);}
        step.status=step.ok?'complete':'error';step.durationMs=Date.now()-step.startedAt;executed=true;
        messages.push({role:'assistant',content:JSON.stringify(action)},{role:'user',content:'Sandbox result: '+JSON.stringify({ok:step.ok,result:step.result,error:step.error})});await this.save(state);
      }
      if(!run.answer)throw Error('Agent reached its round limit. Try a more specific question.');
      run.status='complete';run.stage='Complete';
    }catch(e){run.status='error';run.error=String(e.message||e).slice(0,1500);run.stage='Stopped';}
    run.finishedAt=Date.now();state.active=null;await this.save(state);await this.ctx.storage.deleteAlarm();
  }
  async alarm(){const state=await this.ctx.storage.get('session');if(state?.active){const run=state.runs.find(r=>r.id===state.active);if(run){run.status='error';run.error='Run interrupted or exceeded its time limit. Submit a new question to retry.';run.finishedAt=Date.now();}state.active=null;await this.save(state);}}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const common={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    if(url.pathname==='/style.css')return new Response(CSS,{headers:{...common,'Content-Type':'text/css'}});
    if(url.pathname==='/app.js')return new Response(APP,{headers:{...common,'Content-Type':'text/javascript'}});
    if(url.pathname==='/api/health')return json({ok:true,model:MODEL,synthetic:true});
    if(url.pathname==='/api/data')return json({customers:CUSTOMERS,tickets:TICKETS});
    let sid=request.headers.get('Cookie')?.match(/(?:^|;\s*)lab_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
    const newSession=!sid;if(!sid)sid=crypto.randomUUID();
    const cookie=newSession?{'Set-Cookie':`lab_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`}:{};
    if(url.pathname==='/')return new Response(HTML,{headers:{...common,...cookie,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    if(['/api/session','/api/run'].includes(url.pathname)){
      if(request.method==='POST'&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
      if(Number(request.headers.get('Content-Length')||0)>10000)return json({error:'Request too large'},413);
      const headers=new Headers(request.headers);headers.set('X-Client-IP',request.headers.get('CF-Connecting-IP')||'unknown');
      try{const response=await env.SESSIONS.get(env.SESSIONS.idFromName(sid)).fetch(new Request(request,{headers}));const out=new Response(response.body,response);for(const [k,v]of Object.entries({...common,...cookie}))out.headers.set(k,v);return out;}catch(e){return json({error:'Unable to complete the request. Please try again.'},500);}
    }
    return json({error:'Not found'},404);
  }
};
