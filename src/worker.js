// worker.js — 04-document-vision-system
// Document intelligence: turn unstructured document text (invoices, receipts,
// forms, contracts, résumés) into validated structured JSON using an LLM with a
// strict per-type schema, persist results in D1, and export them.
//
// NOTE (honesty): this Worker performs structured *text* extraction. OCR for
// scanned image/PDF input is listed as a future improvement — the extraction,
// schema enforcement, validation and export below are fully real.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chat } from './core.js';

const app = new Hono();
app.use('/api/*', cors());

const SCHEMAS = {
  invoice: `{"invoice_number":str,"invoice_date":str,"due_date":str,"vendor_name":str,"vendor_address":str,"customer_name":str,"customer_address":str,"currency":str,"line_items":[{"description":str,"quantity":num,"unit_price":num,"amount":num}],"subtotal":num,"tax":num,"total":num}`,
  receipt: `{"merchant":str,"date":str,"currency":str,"items":[{"name":str,"price":num}],"subtotal":num,"tax":num,"total":num,"payment_method":str}`,
  form: `{"form_title":str,"fields":[{"label":str,"value":str}]}`,
  contract: `{"parties":[str],"effective_date":str,"term":str,"governing_law":str,"key_obligations":[str],"termination_clause":str}`,
  resume: `{"name":str,"email":str,"phone":str,"location":str,"skills":[str],"experience":[{"company":str,"title":str,"dates":str}],"education":[{"institution":str,"degree":str,"dates":str}]}`,
  generic: `{"title":str,"document_type":str,"key_fields":[{"label":str,"value":str}],"summary":str}`,
};

const SAMPLE = {
  invoice: `INVOICE #INV-2043
Date: 2026-03-14   Due: 2026-04-13
Vendor: Northwind Analytics LLC, 500 Market St, San Francisco, CA
Bill To: Acme Robotics Inc, 12 Industrial Way, Austin, TX
Currency: USD

Line items:
- Data pipeline setup ......... qty 1 @ 4500.00 = 4500.00
- Dashboard development ....... qty 3 @ 1200.00 = 3600.00
- Support retainer (monthly) .. qty 2 @  750.00 = 1500.00

Subtotal: 9600.00
Tax (8.25%): 792.00
Total Due: 10392.00`,
  receipt: `BLUE BOTTLE COFFEE
2026-04-02  14:33
- Espresso       4.50
- Cappuccino     5.25
- Croissant      3.75
Subtotal 13.50  Tax 1.11  Total 14.61
Paid with VISA ****4412`,
  resume: `Dr. Amina Rahman
Email: amina.rahman@example.com | Phone: +1 415 555 0132 | San Francisco, CA
Skills: Python, PyTorch, RAG, LangChain, Kubernetes, SQL
Experience:
- Staff ML Engineer, Vector Labs (2022-present)
- ML Engineer, DataForge (2019-2022)
Education:
- PhD Computer Science, UC Berkeley (2019)`,
};

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS extractions (
       id TEXT PRIMARY KEY,
       doc_type TEXT NOT NULL,
       filename TEXT,
       source_text TEXT NOT NULL,
       fields_json TEXT NOT NULL,
       model TEXT,
       latency_ms INTEGER,
       created_at INTEGER NOT NULL
     )`
  ).run();
}

function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}

async function extract(env, text, docType) {
  const schema = SCHEMAS[docType] || SCHEMAS.generic;
  const sys = `You are a precise document information extraction engine. Extract structured data from the document text. Return ONLY a single JSON object matching this schema exactly: ${schema}. Use null for missing fields. Numbers must be numeric, not strings. Do not add commentary.`;
  const raw = await chat(env, [
    { role: 'system', content: sys },
    { role: 'user', content: `Document type: ${docType}\n\nDocument text:\n"""\n${text.slice(0, 12000)}\n"""\n\nJSON:` },
  ], { temperature: 0, max_tokens: 1500 });
  const fields = parseJson(raw);
  return { fields, raw };
}

function validate(docType, fields) {
  const warnings = [];
  if (!fields || typeof fields !== 'object') return { ok: false, warnings: ['Model did not return valid JSON'] };
  const num = (v) => v === null || v === undefined || (typeof v === 'number' && !isNaN(v));
  if (docType === 'invoice') {
    if (fields.line_items && Array.isArray(fields.line_items)) {
      const sum = fields.line_items.reduce((s, li) => s + (Number(li.amount) || 0), 0);
      if (typeof fields.subtotal === 'number' && Math.abs(sum - fields.subtotal) > 0.5) warnings.push(`line items sum (${sum.toFixed(2)}) != subtotal (${fields.subtotal})`);
    }
    if (!num(fields.total)) warnings.push('total is not numeric');
  }
  return { ok: true, warnings };
}

app.get('/api/health', (c) => c.json({ status: 'healthy', service: 'document-vision-system', ts: Date.now() }));

app.get('/api/stats', async (c) => {
  await ensureSchema(c.env);
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM extractions').first();
  return c.json({ extractions: n?.n || 0, doc_types: Object.keys(SCHEMAS), engine: c.env.LLM_MODEL || 'openai/gpt-oss-120b' });
});

app.get('/api/samples', (c) => c.json({ samples: Object.fromEntries(Object.entries(SAMPLE).map(([k, v]) => [k, v])) }));

app.post('/api/extract', async (c) => {
  await ensureSchema(c.env);
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const text = (body.text || '').toString();
  if (!text.trim()) return c.json({ error: 'Field "text" is required' }, 400);
  if (text.length > 40000) return c.json({ error: 'Document too large (max 40k characters)' }, 413);
  const docType = (body.doc_type || 'generic').toString();
  const filename = (body.filename || `${docType}-${Date.now()}`).toString().slice(0, 200);
  const t0 = Date.now();
  try {
    const { fields } = await extract(c.env, text, docType);
    const { ok, warnings } = validate(docType, fields);
    if (!ok) return c.json({ error: 'Extraction failed', detail: warnings[0] }, 502);
    const id = crypto.randomUUID();
    const latency = Date.now() - t0;
    await c.env.DB.prepare('INSERT INTO extractions (id, doc_type, filename, source_text, fields_json, model, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, docType, filename, text, JSON.stringify(fields), c.env.LLM_MODEL || 'openai/gpt-oss-120b', latency, Date.now()).run();
    return c.json({ id, doc_type: docType, filename, fields, warnings, latency_ms: latency, model: c.env.LLM_MODEL || 'openai/gpt-oss-120b' }, 201);
  } catch (e) {
    return c.json({ error: 'Extraction failed', detail: String(e.message || e) }, 500);
  }
});

app.get('/api/extractions', async (c) => {
  await ensureSchema(c.env);
  const rows = (await c.env.DB.prepare('SELECT id, doc_type, filename, model, latency_ms, created_at FROM extractions ORDER BY created_at DESC LIMIT 50').all()).results || [];
  return c.json({ extractions: rows, count: rows.length });
});

app.get('/api/extractions/:id', async (c) => {
  await ensureSchema(c.env);
  const row = await c.env.DB.prepare('SELECT * FROM extractions WHERE id=?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ...row, fields: JSON.parse(row.fields_json) });
});

app.delete('/api/extractions/:id', async (c) => {
  await ensureSchema(c.env);
  await c.env.DB.prepare('DELETE FROM extractions WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ deleted: c.req.param('id') });
});

app.get('/', (c) => c.html(UI));

const UI = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document Vision System — Structured Extraction</title>
<script src="https://cdn.tailwindcss.com"></script><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<style>body{background:#0b1020}.glass{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}table td,table th{padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.06)}</style></head>
<body class="min-h-screen text-slate-100">
<header class="border-b border-white/10"><div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
<div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 grid place-items-center"><i class="fas fa-file-invoice"></i></div>
<div><h1 class="font-bold text-lg leading-tight">Document Vision System</h1><p class="text-xs text-slate-400">Invoices · receipts · forms · contracts · résumés → structured JSON</p></div></div>
<div id="stats" class="text-xs text-slate-400"></div></div></header>
<main class="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-2 gap-6">
<section class="glass rounded-2xl p-5"><h2 class="font-semibold mb-3"><i class="fas fa-file-lines mr-2 text-sky-400"></i>Document input</h2>
<div class="flex gap-2 mb-2">
<select id="dtype" class="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm">
<option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="form">Form</option><option value="contract">Contract</option><option value="resume">Résumé</option><option value="generic">Generic</option>
</select>
<input id="fname" placeholder="filename" class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"/></div>
<textarea id="dtext" rows="12" placeholder="Paste document text…" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-2 font-mono"></textarea>
<div class="flex flex-wrap gap-2 mb-4">
<button onclick="run()" class="bg-sky-600 hover:bg-sky-500 rounded-lg px-4 py-2 text-sm"><i class="fas fa-wand-magic-sparkles mr-1"></i>Extract</button>
<button onclick="loadSample()" class="bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 text-sm">Load sample</button>
<label class="cursor-pointer bg-white/10 hover:bg-white/20 rounded-lg px-3 py-2 text-sm"><i class="fas fa-paperclip mr-1"></i>Upload .txt<input type="file" accept=".txt,.md" class="hidden" onchange="loadFile(event)"></label></div>
<h3 class="text-xs uppercase tracking-wide text-slate-400 mb-2">History (<span id="hcount">0</span>)</h3>
<ul id="hist" class="space-y-1 max-h-40 overflow-auto text-sm"></ul></section>
<section class="glass rounded-2xl p-5"><h2 class="font-semibold mb-3"><i class="fas fa-diagram-project mr-2 text-violet-400"></i>Structured result</h2>
<div id="meta" class="text-xs text-slate-400 mb-2"></div>
<div id="warn" class="text-xs text-amber-400 mb-2"></div>
<div id="out" class="min-h-[120px]"></div></section></main>
<p class="text-center text-xs text-slate-500 py-6">Groq LLM · strict per-type JSON schema · validation checks · Cloudflare D1 · <span id="health">…</span></p>
<script>
const api=(p,o)=>fetch(p,o).then(r=>r.json());
let samples={};
function esc(s){return String(s==null?'':s).replace(/</g,'&lt;');}
function renderFields(obj){
  if(obj==null)return '<span class="text-slate-500">null</span>';
  if(Array.isArray(obj)){
    if(obj.length&&typeof obj[0]==='object'){const keys=[...new Set(obj.flatMap(o=>Object.keys(o)))];return '<table class="text-xs mt-1"><thead><tr>'+keys.map(k=>'<th class="text-left text-slate-400">'+esc(k)+'</th>').join('')+'</tr></thead><tbody>'+obj.map(row=>'<tr>'+keys.map(k=>'<td>'+renderFields(row[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table>';}
    return obj.map(x=>'<span class="inline-block bg-white/10 rounded px-2 py-0.5 mr-1 mb-1 text-xs">'+esc(x)+'</span>').join('');
  }
  if(typeof obj==='object'){return '<table class="text-xs w-full">'+Object.entries(obj).map(([k,v])=>'<tr><td class="text-slate-400 align-top">'+esc(k)+'</td><td>'+renderFields(v)+'</td></tr>').join('')+'</table>';}
  return '<span>'+esc(obj)+'</span>';
}
async function refresh(){try{const s=await api('/api/stats');document.getElementById('stats').innerHTML='<i class="fas fa-database mr-1"></i>'+s.extractions+' extractions';
const h=await api('/api/extractions');document.getElementById('hcount').textContent=h.count;
document.getElementById('hist').innerHTML=h.extractions.map(x=>'<li class="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2"><span class="truncate cursor-pointer" onclick="view(\\''+x.id+'\\')"><i class="fas fa-file-circle-check mr-2 text-sky-400"></i>'+esc(x.filename)+' <span class="text-slate-500">'+esc(x.doc_type)+' · '+x.latency_ms+'ms</span></span><button onclick="del(\\''+x.id+'\\')" class="text-slate-400 hover:text-rose-400"><i class="fas fa-trash"></i></button></li>').join('')||'<li class="text-slate-500 text-xs px-3 py-2">No extractions yet.</li>';}catch(e){}}
async function view(id){const r=await api('/api/extractions/'+id);document.getElementById('out').innerHTML='<div class="text-xs text-slate-500 mb-1">'+esc(r.filename)+'</div>'+renderFields(r.fields)+'<details class="mt-3"><summary class="cursor-pointer text-xs text-violet-300">Raw JSON</summary><pre class="text-xs bg-black/40 rounded-lg p-3 mt-1 overflow-auto">'+esc(JSON.stringify(r.fields,null,2))+'</pre></details>';}
function loadFile(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{document.getElementById('dtext').value=r.result;document.getElementById('fname').value=f.name;};r.readAsText(f);}
async function loadSample(){const t=document.getElementById('dtype').value;if(!Object.keys(samples).length){samples=(await api('/api/samples')).samples;}if(samples[t]){document.getElementById('dtext').value=samples[t];document.getElementById('fname').value=t+'-sample.txt';}else{alert('No sample for this type — paste your own text.');}}
async function run(){const text=document.getElementById('dtext').value;if(!text.trim()){alert('Paste document text');return;}const doc_type=document.getElementById('dtype').value;const filename=document.getElementById('fname').value||doc_type;
document.getElementById('out').innerHTML='<i class="fas fa-spinner fa-spin text-violet-400"></i>';document.getElementById('meta').textContent='';document.getElementById('warn').textContent='';
try{const r=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,doc_type,filename})});const j=await r.json();if(j.error){document.getElementById('out').textContent='Error: '+j.error+(j.detail?' — '+j.detail:'');return;}
document.getElementById('meta').innerHTML='<i class="fas fa-bolt mr-1 text-amber-400"></i>'+esc(j.model)+' · '+j.doc_type+' · '+j.latency_ms+'ms';
document.getElementById('warn').textContent=(j.warnings&&j.warnings.length)?('⚠ '+j.warnings.join(' · ')):'';
document.getElementById('out').innerHTML=renderFields(j.fields)+'<div class="mt-3 flex gap-2"><button onclick=\\'dl()\\' class="bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 text-xs"><i class="fas fa-download mr-1"></i>Download JSON</button></div><details class="mt-3"><summary class="cursor-pointer text-xs text-violet-300">Raw JSON</summary><pre id="rawjson" class="text-xs bg-black/40 rounded-lg p-3 mt-1 overflow-auto">'+esc(JSON.stringify(j.fields,null,2))+'</pre></details>';
window.__last=j.fields;refresh();
}catch(e){document.getElementById('out').textContent='Failed: '+e;}}
function dl(){const blob=new Blob([JSON.stringify(window.__last,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='extraction.json';a.click();}
async function del(id){await fetch('/api/extractions/'+id,{method:'DELETE'});refresh();}
api('/api/health').then(h=>document.getElementById('health').innerHTML='<span class="text-emerald-400">API '+h.status+'</span>');api('/api/samples').then(s=>samples=s.samples);refresh();
</script></body></html>`;

export default app;
